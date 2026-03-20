/**
 * Cloudflare Worker: receives POST from AM Spend dashboard, triggers GitHub repository_dispatch.
 *
 * Deploy: see ../data/WEBHOOK_SETUP.md
 */
export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'use POST' }, 405, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'invalid JSON' }, 400, cors);
    }

    const want = (env.WEBHOOK_SECRET || '').trim();
    if (want && String(body.secret || '') !== want) {
      return json({ ok: false, error: 'unauthorized' }, 401, cors);
    }

    const country = String(body.country || '').toLowerCase().trim();
    const sheetId = String(body.sheetId || '').trim();
    const gid = String(body.gid ?? '0').trim() || '0';

    if (!/^[a-z]{2}$/.test(country)) {
      return json({ ok: false, error: 'invalid country' }, 400, cors);
    }
    if (!sheetId) {
      return json({ ok: false, error: 'missing sheetId' }, 400, cors);
    }

    const token = (env.GITHUB_TOKEN || '').trim();
    if (!token) {
      return json({ ok: false, error: 'worker missing GITHUB_TOKEN' }, 500, cors);
    }

    const repo = (env.GITHUB_REPO || 'duncancalleja/bolt-food-campaign-calculator').trim();
    const gh = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'bolt-sheet-dispatch-worker',
      },
      body: JSON.stringify({
        event_type: 'update_sheet_config',
        client_payload: { country, sheetId, gid },
      }),
    });

    const text = await gh.text();
    if (!gh.ok) {
      return json({ ok: false, error: 'github_api', status: gh.status, detail: text.slice(0, 500) }, 502, cors);
    }

    return json({ ok: true }, 200, cors);
  },
};

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const raw = env.ALLOWED_ORIGINS ||
    'https://duncancalleja.github.io,http://localhost:8080,http://127.0.0.1:8080,http://localhost:5500,http://127.0.0.1:5500,http://localhost:5173,http://127.0.0.1:5173';
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const allow = list.includes(origin) ? origin : list[0] || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
