# food-campaign-calculator

Source repo for the Food campaign calculator. After merging, run `bash scripts/deploy_data_to_boltable.sh` to copy `data/` + HTML into the Boltable clone and push. Live site: https://food-campaign-calculator.boltable.eu/

## Malta Performance Hub (unlisted)

`malta-mm-performance.html` plus `data/malta-mm/` (hub-data, sl-pipeline, summary). It is **not** linked from the calculator home or other nav — open it by URL only.

Structure: an Overview tab plus one tab per AM (Alena Tokareva, Rico Spagnol, Yousef Moungad, Gulcin Erguven, Fiona Borg). Only the five Malta MM columns of the shared RAM/KPI sheet are tracked — Q3 Renegotiations, Sponsored Listings, Bolt Plus, Marketing Campaigns, Smart Promotions — and each AM page carries a root cause / pipeline / forecast block plus a named-account pipeline table per KPI. Account-level enrolment lists exist only for Sponsored Listings, which is the one product in the Databricks pull (`sl-pipeline.json`); the page filters that pull to each AM by owner name. Notes and pipeline rows are saved per person + KPI in browser localStorage, not in the repo.

After merge, run the deploy script. Live at:

https://food-campaign-calculator.boltable.eu/malta-mm-performance.html
