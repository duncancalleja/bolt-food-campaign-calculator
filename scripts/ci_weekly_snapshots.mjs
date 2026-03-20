/**
 * Run inside GitHub Actions: local HTTP server must serve repo root on 8765.
 * Requires: npm install playwright && npx playwright install chromium --with-deps
 */
import { spawn } from 'child_process';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outFile = process.env.SNAPSHOT_OUT || '/tmp/weekly-snap-new.json';

const server = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1'], {
  cwd: root,
  stdio: 'pipe',
});
await new Promise((r) => setTimeout(r, 2500));

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('CI snapshot') || t.includes('error') || t.includes('Error')) console.log('PAGE:', t);
  });
  await page.addInitScript(() => {
    window.__PLAYWRIGHT_CI = true;
  });
  await page.goto('http://127.0.0.1:8765/am-spend-dashboard.html', {
    waitUntil: 'domcontentloaded',
    timeout: 180000,
  });
  await page.waitForFunction(() => window.__weeklySnapshotsReady === true, {
    timeout: 300000,
  });
  const data = await page.evaluate(async () => {
    if (typeof window.__collectWeeklySnapshotsForCI !== 'function') {
      return { error: 'missing __collectWeeklySnapshotsForCI' };
    }
    return await window.__collectWeeklySnapshotsForCI();
  });
  if (data && data.error) {
    console.error(data.error);
    process.exitCode = 1;
  } else {
    fs.writeFileSync(outFile, JSON.stringify(data, null, 2));
    console.log('Wrote', outFile, 'countries:', Object.keys(data.byCountry || {}));
  }
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
