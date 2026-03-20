#!/usr/bin/env python3
"""Update data/sheet-config.json from repository_dispatch client_payload (GitHub Actions)."""
import json
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CFG_PATH = ROOT / "data" / "sheet-config.json"


def main():
    raw = os.environ.get("PAYLOAD", "{}")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        print("Invalid PAYLOAD JSON", file=sys.stderr)
        return 1

    country = str(payload.get("country", "")).lower().strip()
    sheet_id = str(payload.get("sheetId", "")).strip()
    gid = str(payload.get("gid", "0")).strip() or "0"

    if not re.match(r"^[a-z]{2}$", country):
        print(f"Invalid country code: {country}", file=sys.stderr)
        return 1
    if not sheet_id:
        print("Missing sheetId", file=sys.stderr)
        return 1

    cfg = json.loads(CFG_PATH.read_text())
    cfg[country] = {"sheetId": sheet_id, "gid": gid}
    CFG_PATH.write_text(json.dumps(cfg, indent=2) + "\n")
    print(f"Updated sheet-config for {country}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
