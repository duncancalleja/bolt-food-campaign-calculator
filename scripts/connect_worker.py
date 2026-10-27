#!/usr/bin/env python3
"""Long-lived Spark Connect worker driven over stdin/stdout by ``dbx.DBX``.

Runs inside the databricks-connect virtualenv (Python 3.12) so callers stuck on
the system Python can still reach serverless compute. Protocol is one JSON
object per line:

    <- {"sql": "SELECT 1", "out": "/tmp/result.parquet"}
    -> {"status": "ok", "rows": 1}

The first line written is ``{"status": "ready"}`` once the Spark session exists.
"""
from __future__ import annotations

import json
import sys
import traceback


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main() -> int:
    profile = sys.argv[1] if len(sys.argv) > 1 else "DEFAULT"

    try:
        from databricks.connect import DatabricksSession

        spark = DatabricksSession.builder.serverless().profile(profile).getOrCreate()
    except Exception as exc:  # pragma: no cover - depends on workspace state
        _emit({"status": "fatal", "message": f"{type(exc).__name__}: {exc}"})
        return 1

    _emit({"status": "ready"})

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                request = json.loads(line)
            except json.JSONDecodeError as exc:
                _emit({"status": "error", "message": f"bad request: {exc}"})
                continue

            if request.get("command") == "quit":
                break

            try:
                pdf = spark.sql(request["sql"]).toPandas()
                # Connect attaches PlanMetrics to .attrs, which parquet cannot serialize.
                pdf.attrs = {}
                pdf.to_parquet(request["out"], index=False)
                _emit({"status": "ok", "rows": int(len(pdf))})
            except Exception as exc:
                _emit(
                    {
                        "status": "error",
                        "message": f"{type(exc).__name__}: {exc}",
                        "traceback": traceback.format_exc(limit=3),
                    }
                )
    finally:
        try:
            spark.stop()
        except Exception:
            pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
