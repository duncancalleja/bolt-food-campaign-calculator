"""Boltable web server and shared state API for the Malta MM hub."""

from __future__ import annotations

import copy
import json
import os
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3
import uvicorn
from fastapi import FastAPI, Header, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

PUBLIC_DIR = Path(os.environ.get("PUBLIC_DIR", Path(__file__).resolve().parent / "public"))
DATA_DIR = Path(os.environ.get("DATA_DIR", "/tmp/food-campaign-calculator"))
STATE_FILE = DATA_DIR / "malta-mm-state.json"
S3_KEY = "shared/malta-mm-state.json"
USE_S3 = os.environ.get("USE_S3", "").lower() in {"1", "true", "yes", "on"}
S3_BUCKET = os.environ.get("BOLTABLE_S3_BUCKET", "boltable-food-campaign-calculator")
S3_REGION = os.environ.get("AWS_REGION") or os.environ.get("BOLTABLE_S3_REGION", "eu-central-1")
S3_TIMEOUT = float(os.environ.get("S3_TIMEOUT", "20"))

EMPTY_STATE: dict[str, Any] = {
    "version": 0,
    "updated_at": None,
    "updated_by": None,
    "entries": {},
    "next_steps": {},
}
ENTRY_FIELDS = {"rootCause", "pipeline", "forecast", "notes", "rows"}
ROW_FIELDS = {"account", "size", "confidence", "nextStep"}
MAX_TEXT = 20_000
MAX_KEYS = 20_000

_lock = threading.RLock()
_state = copy.deepcopy(EMPTY_STATE)
_storage_warning: str | None = None
_persist_seq = 0


class StatePut(BaseModel):
    deltas: dict[str, Any] = Field(default_factory=dict)
    updated_by: str | None = Field(default=None, max_length=200)
    migrate_missing: bool = False


def _state_response(applied: int | None = None) -> dict[str, Any]:
    with _lock:
        result = copy.deepcopy(_state)
    result["storage"] = "s3" if USE_S3 else "local-only"
    result["warning"] = _storage_warning
    if applied is not None:
        result["applied"] = applied
    return result


def _valid_state(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    entries = value.get("entries")
    next_steps = value.get("next_steps")
    if not isinstance(entries, dict) or not isinstance(next_steps, dict):
        return None
    state = copy.deepcopy(EMPTY_STATE)
    state.update({
        "version": max(0, int(value.get("version", 0))),
        "updated_at": value.get("updated_at"),
        "updated_by": value.get("updated_by"),
        "entries": entries,
        "next_steps": next_steps,
    })
    return state


def _local_load() -> dict[str, Any] | None:
    try:
        return _valid_state(json.loads(STATE_FILE.read_text()))
    except (OSError, ValueError, TypeError):
        return None


def _local_save(snapshot: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp = STATE_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")))
    temp.replace(STATE_FILE)


def _s3_client():
    return boto3.client("s3", region_name=S3_REGION)


def _s3_get() -> dict[str, Any] | None:
    try:
        response = _s3_client().get_object(Bucket=S3_BUCKET, Key=S3_KEY)
        return _valid_state(json.loads(response["Body"].read()))
    except _s3_client().exceptions.NoSuchKey:
        return None


def _s3_put(snapshot: dict[str, Any]) -> None:
    _s3_client().put_object(
        Bucket=S3_BUCKET,
        Key=S3_KEY,
        Body=json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).encode(),
        ContentType="application/json",
    )


def _run_bounded(function, timeout: float) -> tuple[bool, Any]:
    result: list[Any] = []
    error: list[BaseException] = []

    def run() -> None:
        try:
            result.append(function())
        except BaseException as exc:  # daemon boundary: report, never crash the app
            error.append(exc)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        return False, TimeoutError(f"storage operation exceeded {timeout:g}s")
    if error:
        return False, error[0]
    return True, result[0] if result else None


def _persist(snapshot: dict[str, Any], sequence: int) -> None:
    global _storage_warning
    try:
        _local_save(snapshot)
    except OSError as exc:
        _storage_warning = f"Local cache unavailable: {exc}"
    if not USE_S3:
        return
    with _lock:
        if sequence != _persist_seq:
            return
    ok, result = _run_bounded(lambda: _s3_put(snapshot), S3_TIMEOUT)
    _storage_warning = None if ok else f"Shared storage unavailable: {result}"


def _queue_persist(snapshot: dict[str, Any]) -> None:
    global _persist_seq
    with _lock:
        _persist_seq += 1
        sequence = _persist_seq
    threading.Thread(target=_persist, args=(snapshot, sequence), daemon=True).start()


def _load_shared_state() -> None:
    global _state, _storage_warning
    if not USE_S3:
        return
    ok, result = _run_bounded(_s3_get, S3_TIMEOUT)
    if not ok:
        _storage_warning = f"Shared storage unavailable: {result}"
        return
    if result:
        with _lock:
            if result["version"] >= _state["version"]:
                _state = result
                try:
                    _local_save(_state)
                except OSError:
                    pass
    _storage_warning = None


def _clean_text(value: Any) -> str:
    return str(value if value is not None else "")[:MAX_TEXT]


def _clean_entry(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HTTPException(422, "Each entry delta must be an object or null.")
    clean: dict[str, Any] = {}
    for field, field_value in value.items():
        if field not in ENTRY_FIELDS:
            continue
        if field == "rows":
            if not isinstance(field_value, list):
                raise HTTPException(422, "rows must be an array.")
            clean["rows"] = [
                {key: _clean_text(item.get(key)) for key in ROW_FIELDS if key in item}
                for item in field_value[:500]
                if isinstance(item, dict)
            ]
        else:
            clean[field] = _clean_text(field_value)
    return clean


def apply_deltas(state: dict[str, Any], deltas: dict[str, Any], missing_only: bool = False) -> int:
    """Merge field-level deltas. Exported for focused unit tests."""
    entries = deltas.get("entries", {})
    next_steps = deltas.get("next_steps", {})
    if not isinstance(entries, dict) or not isinstance(next_steps, dict):
        raise HTTPException(422, "deltas.entries and deltas.next_steps must be objects.")
    if len(entries) + len(next_steps) > MAX_KEYS:
        raise HTTPException(413, "Too many state changes in one request.")

    applied = 0
    for raw_key, value in entries.items():
        key = _clean_text(raw_key)
        if not key:
            continue
        if value is None:
            if not missing_only and key in state["entries"]:
                del state["entries"][key]
                applied += 1
            continue
        patch = _clean_entry(value)
        if missing_only and key in state["entries"]:
            continue
        state["entries"][key] = {**state["entries"].get(key, {}), **patch}
        applied += len(patch)

    for raw_key, value in next_steps.items():
        key = _clean_text(raw_key)
        if not key or (missing_only and key in state["next_steps"]):
            continue
        if value is None or not str(value).strip():
            if key in state["next_steps"]:
                del state["next_steps"][key]
                applied += 1
        else:
            state["next_steps"][key] = _clean_text(value).strip()
            applied += 1
    return applied


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _state
    local = _local_load()
    if local:
        _state = local
    threading.Thread(target=_load_shared_state, daemon=True).start()
    yield


app = FastAPI(title="Food Campaign Calculator", lifespan=lifespan)


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "gitSha": os.environ.get("BOLTABLE_GIT_SHA"),
        "builtAt": os.environ.get("BOLTABLE_BUILT_AT"),
        "storage": "s3" if USE_S3 else "local-only",
        "bucket": S3_BUCKET if USE_S3 else None,
        "warning": _storage_warning,
    }


@app.get("/api/state")
def get_state() -> dict[str, Any]:
    return _state_response()


@app.put("/api/state")
def put_state(
    body: StatePut,
    x_user_email: str | None = Header(default=None),
) -> dict[str, Any]:
    global _state
    with _lock:
        candidate = copy.deepcopy(_state)
        applied = apply_deltas(candidate, body.deltas, body.migrate_missing)
        if applied:
            candidate["version"] += 1
            candidate["updated_at"] = datetime.now(timezone.utc).isoformat()
            candidate["updated_by"] = x_user_email or body.updated_by or "dashboard-user"
            _state = candidate
        snapshot = copy.deepcopy(_state)
    if applied:
        _queue_persist(snapshot)
    return _state_response(applied)


if PUBLIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(PUBLIC_DIR), html=True), name="public")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
