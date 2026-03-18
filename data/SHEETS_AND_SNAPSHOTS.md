# Shared sheets & team snapshots

## `sheet-config.json`

- Lists the **Traitless OPS Google Sheet** (Sheet ID + GID tab) per country.
- **All AMs** see the same sheet when they select that country (unless they set a local override in the dashboard inputs).
- **To add a country:** edit `sheet-config.json` on GitHub, add `"sheetId"` and `"gid"`, commit and push.

## `team-snapshots.json`

- Optional **shared snapshot history** for calibration / learning.
- Structure: `{ "byCountry": { "mt": [ {...}, ... ], "pl": [...] } }`
- **Export:** any AM can click **Export all countries** on the dashboard after Sunday runs (or anytime), then merge the downloaded `byCountry` into `team-snapshots.json` and push so everyone loads the same history.

## Sunday auto-snapshots

- If someone opens the **Spend dashboard on a Sunday**, the app snapshots **every country** that has a sheet configured (shared config or local override).
- Each country’s snapshots are stored in the browser under `am_spend_snapshots_<cc>`.
- Use **Export all countries** + merge into `team-snapshots.json` to share history across the team.
