#!/usr/bin/env python3
"""Merge CI weekly snapshot JSON into data/team-snapshots.json."""
import json
import pathlib
import sys
from datetime import date

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEAM_PATH = ROOT / "data" / "team-snapshots.json"


def main():
    new_path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/weekly-snap-new.json")
    if not new_path.exists():
        print("No new snapshots file, skip")
        return 0
    new_data = json.loads(new_path.read_text())
    by_new = new_data.get("byCountry") or {}
    if not by_new:
        print("Empty byCountry, skip merge")
        return 0

    if TEAM_PATH.exists():
        team = json.loads(TEAM_PATH.read_text())
    else:
        team = {"schema": 1, "updated": "", "note": "", "byCountry": {}}

    team.setdefault("byCountry", {})
    for cc, snaps in by_new.items():
        if not isinstance(snaps, list):
            continue
        team["byCountry"].setdefault(cc, [])
        existing_dates = {s.get("date") for s in team["byCountry"][cc]}
        for s in snaps:
            if not isinstance(s, dict):
                continue
            s.pop("_fromTeam", None)
            d = s.get("date")
            if d and d in existing_dates:
                continue
            team["byCountry"][cc].insert(0, s)
            if d:
                existing_dates.add(d)
        team["byCountry"][cc] = team["byCountry"][cc][:40]

    team["updated"] = str(date.today())
    team["schema"] = 1
    TEAM_PATH.write_text(json.dumps(team, indent=2) + "\n")
    print(f"Merged snapshots for: {list(by_new.keys())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
