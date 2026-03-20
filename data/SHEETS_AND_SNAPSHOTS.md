# Shared sheets & team snapshots

## `sheet-config.json`

- Lists the **Traitless OPS Google Sheet** (Sheet ID + GID tab) per country.
- **All AMs** see the same sheet when they select that country (unless they set a local override in the dashboard inputs).
- **To add a country:** edit `sheet-config.json` on GitHub, add `"sheetId"` and `"gid"`, commit and push.

## `team-snapshots.json`

- Optional **shared snapshot history** for calibration / learning.
- Structure: `{ "byCountry": { "mt": [ {...}, ... ], "pl": [...] } }`
- **Export:** any AM can click **Export all countries** on the dashboard after Sunday runs (or anytime), then merge the downloaded `byCountry` into `team-snapshots.json` and push so everyone loads the same history.

## Scheduled weekly snapshots (GitHub Actions)

You **do not** need to open the dashboard on Sunday. Workflow **Weekly team snapshots** runs on a cron (default: Sunday 08:00 UTC), uses Playwright to load `am-spend-dashboard.html` locally, calls the same multi-country snapshot logic as the in-app Sunday run, then merges results into `data/team-snapshots.json` and pushes.

- Workflow file: `.github/workflows/weekly-snapshots.yml`
- Scripts: `scripts/ci_weekly_snapshots.mjs`, `scripts/merge_team_snapshots.py`
- Manual run: **Actions → Weekly team snapshots → Run workflow**

## Sunday auto-snapshots (browser only)

- If someone opens the **Spend dashboard on a Sunday**, the app can still snapshot **every country** that has a sheet configured (shared config or local override).
- Each country’s snapshots are stored in the browser under `am_spend_snapshots_<cc>`.
- Use **Export all countries** + merge into `team-snapshots.json` to share history, or rely on the **scheduled Actions** job above.

---

## Pushing sheet changes from the dashboard → GitHub

A static HTML app **cannot** hold a GitHub token safely. Options:

### A) `repository_dispatch` (recommended)

1. Create a **classic PAT** (or fine-grained token) with **`repo`** scope for `duncancalleja/bolt-food-campaign-calculator`.
2. After you enter Sheet ID + GID on the dashboard, run (replace values):

```bash
gh auth login   # once, or export GH_TOKEN

gh api --method POST repos/duncancalleja/bolt-food-campaign-calculator/dispatches \
  -f event_type=update_sheet_config \
  -f client_payload[country]=pl \
  -f client_payload[sheetId]=YOUR_SPREADSHEET_ID \
  -f client_payload[gid]=0
```

3. The workflow **Update sheet config (repository_dispatch)** updates `data/sheet-config.json` and pushes.

The dashboard shows a copy-paste **GitHub dispatch** command with your current country and fields filled where possible.

### B) Optional webhook URL

If you set a **Sheet dispatch webhook** in the dashboard (stored in `localStorage`), saving sheet settings can **POST** `{ country, sheetId, gid }` to your endpoint (e.g. Google Apps Script, Cloudflare Worker). **Your** server must validate the request and either call `repository_dispatch` with a secret PAT or commit to the repo.

---

## Files reference

| File | Role |
|------|------|
| `data/sheet-config.json` | Shared Sheet ID + GID per country |
| `data/team-snapshots.json` | Shared snapshot history |
| `.github/workflows/weekly-snapshots.yml` | Cron + Playwright snapshot collector |
| `.github/workflows/update-sheet-config.yml` | Applies `update_sheet_config` dispatch |
| `scripts/ci_weekly_snapshots.mjs` | Playwright: collect snapshots JSON |
| `scripts/merge_team_snapshots.py` | Merge CI output into `team-snapshots.json` |
| `scripts/apply_sheet_dispatch.py` | Apply dispatch payload to `sheet-config.json` |
