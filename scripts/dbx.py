from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from typing import Any, Optional

import pandas as pd
from databricks import sql

DEFAULT_SERVER_HOSTNAME = "bolt-incentives.cloud.databricks.com"
DEFAULT_HTTP_PATH = "sql/protocolv1/o/2472566184436351/0221-081903-9ag4bh69"

_NO_TOKEN_MSG = (
    "No Databricks token found. Set DATABRICKS_TOKEN or ~/.databricks_token "
    "(PAT starting with dapi…). OAuth browser login is disabled by default — "
    "pass allow_oauth=True to DBX() only when you explicitly want browser auth."
)

# The SQL warehouse exposes hive-style schemas; serverless compute reads the
# same tables through Unity Catalog under the `main` catalog.
UC_SCHEMA_MAP = {
    "ng_public_spark": "main.ng_public",
    "ng_delivery_spark": "main.ng_delivery",
    "ng_delivery_store_spark": "main.ng_delivery_store",
    "core_models_spark": "main.core_models",
}

CONNECT_PYTHON = os.environ.get(
    "DBX_CONNECT_PYTHON", os.path.expanduser("~/.venvs/dbx-connect/bin/python")
)
CONNECT_WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "connect_worker.py")


def read_access_token() -> Optional[str]:
    token = os.environ.get("DATABRICKS_TOKEN")
    if token and token.strip():
        return token.strip()

    token_path = os.path.expanduser("~/.databricks_token")
    if os.path.exists(token_path):
        with open(token_path, "r", encoding="utf-8") as f:
            token_from_file = f.read().strip()
        return token_from_file or None

    return None


def has_access_token() -> bool:
    return bool(read_access_token())


def to_unity_catalog(query: str) -> str:
    """Rewrite hive-style `<schema>_spark.table` references to `main.<schema>.table`."""
    for hive_schema, uc_schema in UC_SCHEMA_MAP.items():
        query = re.sub(rf"\b{hive_schema}\.", f"{uc_schema}.", query)
    return query


def connect_backend_available() -> bool:
    return os.path.exists(CONNECT_PYTHON) and os.path.exists(CONNECT_WORKER)


class ConnectSession:
    """Runs SQL on serverless compute via a helper process in the Connect venv."""

    def __init__(self, profile: str = "DEFAULT") -> None:
        self._proc = subprocess.Popen(
            [CONNECT_PYTHON, CONNECT_WORKER, profile],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        ready = self._read_response()
        if ready.get("status") != "ready":
            raise RuntimeError(f"Spark Connect worker failed to start: {ready.get('message')}")

    def _read_response(self) -> dict:
        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
        return {"status": "fatal", "message": "worker exited without responding"}

    def query(self, query: str) -> pd.DataFrame:
        assert self._proc.stdin is not None
        with tempfile.NamedTemporaryFile(suffix=".parquet", delete=False) as tmp:
            out_path = tmp.name

        try:
            self._proc.stdin.write(
                json.dumps({"sql": to_unity_catalog(query), "out": out_path}) + "\n"
            )
            self._proc.stdin.flush()
            response = self._read_response()
            if response.get("status") != "ok":
                raise RuntimeError(f"Spark Connect query failed: {response.get('message')}")
            return pd.read_parquet(out_path)
        finally:
            if os.path.exists(out_path):
                os.unlink(out_path)

    def close(self) -> None:
        if self._proc.poll() is None:
            try:
                assert self._proc.stdin is not None
                self._proc.stdin.write(json.dumps({"command": "quit"}) + "\n")
                self._proc.stdin.flush()
                self._proc.wait(timeout=30)
            except Exception:
                self._proc.kill()


@dataclass
class DBX:
    server_hostname: str = DEFAULT_SERVER_HOSTNAME
    http_path: str = DEFAULT_HTTP_PATH
    access_token: Optional[str] = None
    allow_oauth: bool = False
    # "auto" tries the SQL warehouse, then serverless compute. Override with
    # DBX_BACKEND=sql|connect when you need one specific path.
    backend: str = field(default_factory=lambda: os.environ.get("DBX_BACKEND", "auto"))

    _conn: Any = field(default=None, repr=False)
    _connect: Optional[ConnectSession] = field(default=None, repr=False)

    def __enter__(self) -> "DBX":
        if self.backend == "connect":
            self._connect = ConnectSession()
            return self

        connect_args: dict[str, Any] = {
            "server_hostname": self.server_hostname,
            "http_path": self.http_path,
        }

        token = self.access_token or read_access_token()
        if token:
            connect_args["access_token"] = token
        elif self.allow_oauth:
            connect_args["auth_type"] = "databricks-oauth"
        else:
            raise RuntimeError(_NO_TOKEN_MSG)

        try:
            self._conn = sql.connect(**connect_args)
        except Exception as exc:
            if self.backend == "sql" or not connect_backend_available():
                raise
            print(
                f"WARN: SQL warehouse unavailable ({exc}); using serverless compute.",
                file=sys.stderr,
            )
            self._connect = ConnectSession()

        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None
        if self._connect is not None:
            self._connect.close()
            self._connect = None

    def execute(self, query: str) -> None:
        """Run SQL with no result set (DDL / CREATE VIEW / DROP)."""
        if self._connect is not None:
            self._connect.query(query)
            return

        if self._conn is None:
            raise RuntimeError("DBX connection not open. Use `with DBX() as dbx:`.")

        with self._conn.cursor() as cur:
            cur.execute(query)

    def query(self, query: str) -> pd.DataFrame:
        if self._connect is not None:
            return self._connect.query(query)

        if self._conn is None:
            raise RuntimeError("DBX connection not open. Use `with DBX() as dbx:`.")

        with self._conn.cursor() as cur:
            cur.execute(query)
            cols = [d[0] for d in cur.description]
            rows = cur.fetchall()

        return pd.DataFrame(rows, columns=cols)
