# food-campaign-calculator

Source repo for the Food campaign calculator. After merging, run `bash scripts/deploy_data_to_boltable.sh` to copy `data/` + HTML into the Boltable clone and push. Live site: https://food-campaign-calculator.boltable.eu/

## Malta MM Performance Hub (unlisted)

`malta-mm-performance.html` plus `data/malta-mm/` (hub-data, sl-pipeline, summary). It is **not** linked from the calculator home or other nav — open it by URL only.

Structure: an Overview tab plus one tab per AM (Alena Tokareva, Rico Spagnol, Yousef Moungad, Gulcin Erguven, Fiona Borg). Only the five Malta MM columns of the shared RAM/KPI sheet are tracked — Q3 Renegotiations, Sponsored Listings, Bolt Plus, Marketing Campaigns, Smart Promotions — and each AM page carries a root cause / pipeline / forecast block plus a named-account pipeline table per KPI. Account-level enrolment lists exist only for Sponsored Listings and Smart Promotions; the page filters those pulls to each AM by owner name.

Notes, pipeline rows and provider next steps are shared through `GET /api/state` and `PUT /api/state`. The FastAPI service in `boltable-backend/` uses the same delta-merge + S3 pattern as Duncan's `mt-smb-mm-resegmentation` dashboard. State is stored at `shared/malta-mm-state.json` in Boltable File Storage. Browser localStorage is a cache and one-time migration source, not the shared source of truth.

### Boltable setup

The deployed `boltable/food-campaign-calculator` app must run the Python backend rather than static nginx:

1. In Portal → Configuration, enable **File Storage**.
2. In Portal → Secrets, add `USE_S3=1`.
3. Recommended: enable SSO with an empty email allowlist so any Bolt colleague can use the app and saves are attributed from `X-User-Email`.
4. Run `bash scripts/deploy_data_to_boltable.sh`. The script copies the backend and public files into the Boltable clone, removes the nginx `project.toml`, commits and pushes that clone.

No MySQL database or database secret is needed. Without File Storage and `USE_S3=1`, the API still works inside the current pod but state will not survive a restart.

After merge, run the deploy script. Live at:

https://food-campaign-calculator.boltable.eu/malta-mm-performance.html
