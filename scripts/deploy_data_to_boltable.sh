#!/usr/bin/env bash
# Copy refreshed data/ + HTML + shared-state backend into boltable clone and push.
# Updates BOTH cost calculator (data/*-calc.json) and AM spend (data/*-dash.json).
# Also copies malta-mm-performance.html + data/malta-mm/ (unlisted; direct URL only).
# Usage: bash scripts/deploy_data_to_boltable.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT"
DEST="$ROOT/boltable/food-campaign-calculator"

if [ ! -d "$DEST/.git" ]; then
  echo "Missing boltable clone at $DEST" >&2
  echo "Clone first: mkdir -p $ROOT/boltable && gh repo clone boltable/food-campaign-calculator $DEST" >&2
  exit 1
fi

mkdir -p "$DEST/public/data" "$DEST/public/investment-data"
cp -R "$SRC/data/." "$DEST/public/data/"
cp -R "$SRC/investment-data/." "$DEST/public/investment-data/"
rm -f "$DEST/public/data/SHEETS_AND_SNAPSHOTS.md" "$DEST/public/data/WEBHOOK_SETUP.md" 2>/dev/null || true

# Keep both apps + related pages in sync
for f in am-spend-dashboard.html campaign-cost-calculator.html am-portfolio.html investment-dashboard.html malta-mm-performance.html; do
  if [ -f "$SRC/$f" ]; then
    cp "$SRC/$f" "$DEST/public/$f"
  fi
done

# The Malta hub now needs a same-origin API. Move the deployed app from static nginx to the
# FastAPI web process used by mt-smb-mm-resegmentation; it still serves every file in public/.
cp "$SRC/boltable-backend/server.py" "$DEST/server.py"
cp "$SRC/boltable-backend/requirements.txt" "$DEST/requirements.txt"
cp "$SRC/boltable-backend/Procfile" "$DEST/Procfile"
rm -f "$DEST/project.toml"

cd "$DEST"
git add -A

if git diff --cached --quiet; then
  echo "No Boltable data changes to push."
  exit 0
fi

git commit -m "Refresh calculator + spend data ($(date -u +%Y-%m-%d) UTC)"
git push origin main
echo "Live in ~60s:"
echo "  Spend:      https://food-campaign-calculator.boltable.eu/am-spend-dashboard.html"
echo "  Calculator: https://food-campaign-calculator.boltable.eu/campaign-cost-calculator.html"
echo "  Malta MM:   https://food-campaign-calculator.boltable.eu/malta-mm-performance.html"
