# Sheet dispatch Worker

Deploy with Wrangler — full steps: **[../data/WEBHOOK_SETUP.md](../data/WEBHOOK_SETUP.md)**.

```bash
cd workers
npx wrangler@3 deploy
npx wrangler@3 secret put GITHUB_TOKEN
npx wrangler@3 secret put WEBHOOK_SECRET   # optional
```
