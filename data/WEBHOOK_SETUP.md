# Auto-push sheet config from the dashboard (~5 minutes)

The dashboard cannot store a GitHub token. This uses a **free Cloudflare Worker** as a tiny bridge: your browser POSTs to the Worker, the Worker calls GitHub `repository_dispatch`, and **Update sheet config** updates `data/sheet-config.json`.

## 1. GitHub token

1. GitHub → **Settings → Developer settings → Personal access tokens**
2. Create a token (classic is fine) with scope **`repo`** (or fine-grained: **Contents: Read and write** on `bolt-food-campaign-calculator`).
3. Copy the token (you will only paste it into Cloudflare once).

## 2. Deploy the Worker

```bash
cd workers
npx wrangler@3 deploy
```

## 3. Add secrets to the Worker

```bash
npx wrangler@3 secret put GITHUB_TOKEN
# paste the GitHub token when prompted

# Optional but recommended: random string; same value goes in the dashboard "Webhook shared secret"
npx wrangler@3 secret put WEBHOOK_SECRET
```

## 4. Dashboard

1. Open the [AM Spend dashboard](https://duncancalleja.github.io/bolt-food-campaign-calculator/am-spend-dashboard.html).
2. **Webhook URL** — paste your Worker URL, e.g. `https://bolt-sheet-dispatch.<your-subdomain>.workers.dev`
3. If you set `WEBHOOK_SECRET`, paste the **same** string into **Webhook shared secret**.
4. Enter **Sheet ID** + **GID** and tab out / save — the page POSTs to the Worker; Actions updates the repo within ~1 minute.

## 5. Verify

- GitHub → **Actions** → **Update sheet config (repository_dispatch)** should show a successful run.
- `data/sheet-config.json` on `main` should show the new `sheetId` / `gid` for that country.

## Troubleshooting

| Issue | What to check |
|--------|----------------|
| Browser console CORS error | In **Cloudflare** → Worker → **Settings** → **Variables**, add `ALLOWED_ORIGINS` = comma-separated list including your Pages origin (e.g. `https://YOUR_USER.github.io`). Redeploy if you change `wrangler.toml` `[vars]`. |
| `401 unauthorized` from Worker | `WEBHOOK_SECRET` set in Worker but dashboard secret missing or wrong. |
| `502` + GitHub error | Token lacks `repo` / wrong repo; or workflow name typo. |
| Nothing happens | Webhook URL wrong; or sheet ID empty (webhook only fires when Sheet ID is non-empty). |

## Weekly snapshots

No Worker needed. **Actions → Weekly team snapshots → Run workflow** once to test; cron runs Sundays 08:00 UTC.

If you use a fork or different GitHub username, set Worker var `GITHUB_REPO` to `your-user/bolt-food-campaign-calculator`.
