/**
 * Shared-state client for the Malta Performance Hub.
 *
 * The hub still reads and writes its existing localStorage blob
 * (`mt-mm-performance-hub-v2`). When `data/malta-mm/hub-sync.json` has a web
 * app URL and token, this module also syncs the syncable keys with the
 * "Hub shared state" tab via the Apps Script web app in
 * scripts/malta-hub-shared-state/Code.gs.
 *
 * The sheet is the source of truth once a browser has completed its one-time
 * upload. Keys that exist only in this browser are pushed up once. After that,
 * a key the sheet does not have is treated as deleted. Edits that have not
 * been acknowledged yet stay local and are retried, including across reloads.
 */
(function (root) {
  const AM_NAMES = [
    'Alena Tokareva',
    'Rico Spagnol',
    'Yousef Moungad',
    'Gulcin Erguven',
    'Fiona Borg',
  ];
  const KPI_NAMES = [
    'Q3 Renegotiations',
    'Sponsored Listings',
    'Bolt Plus',
    'Marketing Campaigns',
    'Smart Promotions',
  ];

  function isSyncableKey(key) {
    if (typeof key !== 'string' || !key || key.length > 400) return false;
    if (/[\u0000-\u001f]/.test(key)) return false;
    if (key.startsWith('targeting||')) return key.split('||').length >= 4;
    if (key.startsWith('amComment||')) return key.split('||').length >= 3;
    if (key.startsWith('nextStep||')) return key.split('||').length >= 3;
    if (key.startsWith('next||')) return key.split('||').length >= 3;
    const parts = key.split('||');
    return parts.length === 2 && AM_NAMES.indexOf(parts[0]) !== -1 && KPI_NAMES.indexOf(parts[1]) !== -1;
  }

  function stableStringify(value) {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }

  function sameValue(a, b) {
    return stableStringify(a) === stableStringify(b);
  }

  function normaliseMeta(meta) {
    const src = meta && typeof meta === 'object' ? meta : {};
    const pendingUpserts = {};
    const rawUpserts = src.pendingUpserts && typeof src.pendingUpserts === 'object' ? src.pendingUpserts : {};
    Object.keys(rawUpserts).forEach(k => {
      if (isSyncableKey(k)) pendingUpserts[k] = rawUpserts[k];
    });
    const pendingDeletes = [];
    (Array.isArray(src.pendingDeletes) ? src.pendingDeletes : []).forEach(k => {
      if (isSyncableKey(k) && pendingDeletes.indexOf(k) === -1 && !Object.prototype.hasOwnProperty.call(pendingUpserts, k)) {
        pendingDeletes.push(k);
      }
    });
    const pinned = [];
    (Array.isArray(src.pinned) ? src.pinned : []).forEach(k => {
      if (isSyncableKey(k) && pinned.indexOf(k) === -1 && !Object.prototype.hasOwnProperty.call(pendingUpserts, k) && pendingDeletes.indexOf(k) === -1) {
        pinned.push(k);
      }
    });
    return {
      migrated: Boolean(src.migrated),
      pendingUpserts,
      pendingDeletes,
      pinned,
    };
  }

  function hasPending(meta) {
    const m = normaliseMeta(meta);
    return Object.keys(m.pendingUpserts).length > 0 || m.pendingDeletes.length > 0;
  }

  /**
   * Fold a sheet snapshot into the local blob.
   * Pending local edits win. Until `migrated` is set, local keys the sheet
   * does not have yet are queued for upload. After that, absence on the sheet
   * deletes the local key.
   */
  function mergeSharedState(local, remote, meta) {
    const base = normaliseMeta(meta);
    const pendingUpserts = Object.assign({}, base.pendingUpserts);
    const pendingDeletes = {};
    base.pendingDeletes.forEach(k => { pendingDeletes[k] = true; });
    const remoteSync = {};
    const remoteObj = remote && typeof remote === 'object' ? remote : {};
    Object.keys(remoteObj).forEach(k => {
      if (isSyncableKey(k)) remoteSync[k] = remoteObj[k];
    });

    const state = {};
    Object.keys(remoteSync).forEach(k => {
      if (pendingDeletes[k]) return;
      if (Object.prototype.hasOwnProperty.call(pendingUpserts, k)) state[k] = pendingUpserts[k];
      else state[k] = remoteSync[k];
    });
    Object.keys(pendingUpserts).forEach(k => {
      if (pendingDeletes[k]) return;
      state[k] = pendingUpserts[k];
    });

    const localObj = local && typeof local === 'object' ? local : {};
    if (!base.migrated) {
      Object.keys(localObj).forEach(k => {
        if (!isSyncableKey(k)) return;
        if (Object.prototype.hasOwnProperty.call(remoteSync, k)) return;
        if (pendingDeletes[k]) return;
        if (Object.prototype.hasOwnProperty.call(pendingUpserts, k)) return;
        pendingUpserts[k] = localObj[k];
        state[k] = localObj[k];
      });
    }

    // Keys the sheet refused (too large, or not a hub field) stay on this device
    // and are not uploaded again until the value changes.
    const pinned = base.pinned.filter(k => !Object.prototype.hasOwnProperty.call(remoteSync, k) && !pendingDeletes[k]);
    pinned.forEach(k => {
      if (Object.prototype.hasOwnProperty.call(state, k)) return;
      if (Object.prototype.hasOwnProperty.call(localObj, k)) state[k] = localObj[k];
    });

    Object.keys(localObj).forEach(k => {
      if (!isSyncableKey(k)) state[k] = localObj[k];
    });

    return {
      state,
      meta: {
        migrated: base.migrated,
        pendingUpserts,
        pendingDeletes: Object.keys(pendingDeletes),
        pinned,
      },
    };
  }

  function noteChange(prev, next, meta) {
    const base = normaliseMeta(meta);
    const pendingUpserts = Object.assign({}, base.pendingUpserts);
    const pendingDeletes = new Set(base.pendingDeletes);
    const before = prev && typeof prev === 'object' ? prev : {};
    const after = next && typeof next === 'object' ? next : {};
    const keys = new Set(Object.keys(before).concat(Object.keys(after)));
    const touched = new Set();
    keys.forEach(k => {
      if (!isSyncableKey(k)) return;
      const had = Object.prototype.hasOwnProperty.call(before, k);
      const has = Object.prototype.hasOwnProperty.call(after, k);
      if (has && (!had || !sameValue(before[k], after[k]))) {
        pendingUpserts[k] = after[k];
        pendingDeletes.delete(k);
        touched.add(k);
      } else if (had && !has) {
        delete pendingUpserts[k];
        pendingDeletes.add(k);
        touched.add(k);
      }
    });
    return {
      migrated: base.migrated,
      pendingUpserts,
      pendingDeletes: Array.from(pendingDeletes),
      pinned: base.pinned.filter(k => !touched.has(k)),
    };
  }

  function acknowledgePush(meta, sentUpserts, sentDeletes) {
    const base = normaliseMeta(meta);
    const pendingUpserts = Object.assign({}, base.pendingUpserts);
    const pendingDeletes = new Set(base.pendingDeletes);
    const sent = sentUpserts && typeof sentUpserts === 'object' ? sentUpserts : {};
    Object.keys(sent).forEach(k => {
      if (sameValue(pendingUpserts[k], sent[k])) delete pendingUpserts[k];
    });
    (Array.isArray(sentDeletes) ? sentDeletes : []).forEach(k => {
      if (pendingDeletes.has(k) && !Object.prototype.hasOwnProperty.call(pendingUpserts, k)) pendingDeletes.delete(k);
    });
    return {
      migrated: true,
      pendingUpserts,
      pendingDeletes: Array.from(pendingDeletes),
      pinned: base.pinned.filter(k => !Object.prototype.hasOwnProperty.call(pendingUpserts, k) && !pendingDeletes.has(k)),
    };
  }

  function explainError(err) {
    const msg = String((err && err.message) || err || '');
    if (msg === 'unauthorized') return 'The shared sheet rejected the sync token.';
    if (/unreadable response|did not return JSON/i.test(msg)) return msg;
    if (/Failed to fetch|NetworkError|Load failed|ECONNREFUSED|network/i.test(msg)) return 'Could not reach the team sheet.';
    return msg || 'Team sync failed.';
  }

  function hintFor(status) {
    if (status === 'loading') {
      return {
        shortHint: 'Loading team notes',
        hint: 'Loading shared notes, comments and targeting…',
      };
    }
    if (status === 'saving') {
      return {
        shortHint: 'Saving for the team',
        hint: 'Saving notes, comments and targeting for the Malta MM team…',
      };
    }
    if (status === 'saved') {
      return {
        shortHint: 'Shared with the team',
        hint: 'KPI notes, confidence, comments and targeting are shared with the Malta MM team',
      };
    }
    if (status === 'error') {
      return {
        shortHint: 'Team sync failed',
        hint: 'Team sync failed. Your latest edits are still on this device.',
      };
    }
    return {
      shortHint: 'Team sync not connected',
      hint: 'Team sync is not connected. Notes, comments and targeting stay on this device until setup is finished.',
    };
  }

  function createHubSync(options) {
    const opts = options || {};
    const storage = opts.storage;
    const fetchImpl = opts.fetch;
    const onState = typeof opts.onState === 'function' ? opts.onState : function () {};
    const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : function () {};
    const onToast = typeof opts.onToast === 'function' ? opts.onToast : function () {};
    const setTimer = opts.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
    const clearTimer = opts.clearTimer || function (id) { clearTimeout(id); };
    const lsKey = opts.lsKey || 'mt-mm-performance-hub-v2';
    const metaKey = opts.metaKey || 'mt-mm-performance-hub-v2-sync';
    const batchSize = opts.batchSize || 200;

    let config = { webAppUrl: '', token: '' };
    let status = 'off';
    let lastError = '';
    let pushTimer = null;
    let pushing = false;
    let pulling = false;
    let queued = false;
    let pullQueued = false;
    let failCount = 0;
    let epoch = 0;
    let pullSerial = 0;
    let lastSavedToastAt = 0;

    function loadState() {
      try {
        const parsed = JSON.parse(storage.getItem(lsKey) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (err) {
        return {};
      }
    }

    function saveStateRaw(state) {
      storage.setItem(lsKey, JSON.stringify(state && typeof state === 'object' ? state : {}));
    }

    function loadMeta() {
      try {
        return normaliseMeta(JSON.parse(storage.getItem(metaKey) || '{}'));
      } catch (err) {
        return normaliseMeta({});
      }
    }

    function saveMeta(meta) {
      storage.setItem(metaKey, JSON.stringify(normaliseMeta(meta)));
    }

    function configured() {
      return /^https?:\/\//i.test(config.webAppUrl) && String(config.token || '').length > 0;
    }

    function statusInfo() {
      const hints = hintFor(status);
      return {
        status,
        lastError,
        shortHint: hints.shortHint,
        hint: hints.hint,
      };
    }

    function setStatus(next, err) {
      status = next;
      lastError = err ? explainError(err) : '';
      onStatus(statusInfo());
    }

    function saveState(state) {
      const prev = loadState();
      saveStateRaw(state);
      if (!configured()) return;
      saveMeta(noteChange(prev, state, loadMeta()));
      schedulePush(700);
    }

    function schedulePush(delay) {
      if (!configured()) return;
      if (pushing) {
        queued = true;
        return;
      }
      if (pushTimer) clearTimer(pushTimer);
      pushTimer = setTimer(() => {
        pushTimer = null;
        flush();
      }, delay == null ? 700 : delay);
    }

    function applyRemote(remote) {
      const before = loadState();
      const merged = mergeSharedState(before, remote, loadMeta());
      saveMeta(merged.meta);
      if (!sameValue(before, merged.state)) {
        saveStateRaw(merged.state);
        onState();
      }
      return loadMeta();
    }

    async function request(method, body) {
      const url = new URL(config.webAppUrl);
      url.searchParams.set('token', config.token);
      url.searchParams.set('cb', String(Date.now()));
      const init = {
        method,
        redirect: 'follow',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      };
      if (method === 'POST') {
        init.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
        init.body = JSON.stringify({
          token: config.token,
          updatedBy: 'malta-hub',
          upserts: (body && body.upserts) || {},
          deletes: (body && body.deletes) || [],
        });
      }
      const res = await fetchImpl(url.toString(), init);
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (err) { data = null; }
      if (!data || typeof data !== 'object') {
        if (/^\s*</.test(text) || text.indexOf('accounts.google.com') !== -1) {
          throw new Error('The web app did not return JSON. Deploy access as Anyone and use the /exec URL.');
        }
        throw new Error('Team sheet returned an unreadable response');
      }
      if (!data.ok) throw new Error(data.error || 'sync failed');
      return data;
    }

    async function pull() {
      if (!configured() || pushing) return;
      if (pulling) {
        pullQueued = true;
        return;
      }
      pulling = true;
      const seenEpoch = epoch;
      const serial = ++pullSerial;
      try {
        const data = await request('GET');
        if (serial !== pullSerial || seenEpoch !== epoch || pushing) return;
        const meta = applyRemote(data.entries || {});
        if (hasPending(meta)) {
          schedulePush(failCount ? Math.min(30000, 2000 * Math.pow(2, failCount - 1)) : 700);
        } else {
          if (!meta.migrated) saveMeta(Object.assign({}, meta, { migrated: true }));
          failCount = 0;
          if (status !== 'saving') setStatus('saved');
        }
      } catch (err) {
        const was = status;
        setStatus('error', err);
        if (was !== 'error') {
          onToast({ kind: 'error', message: 'Team sync failed. Your latest edits are still on this device.' });
        }
      } finally {
        pulling = false;
        if (pullQueued) {
          pullQueued = false;
          pull();
        }
      }
    }

    async function flush() {
      if (!configured()) return;
      if (pushing) {
        queued = true;
        return;
      }
      const snapshot = loadMeta();
      const upserts = Object.assign({}, snapshot.pendingUpserts);
      const deletes = snapshot.pendingDeletes.slice();
      const upsertKeys = Object.keys(upserts);
      if (!upsertKeys.length && !deletes.length) return;

      pushing = true;
      let failed = false;
      setStatus('saving');
      try {
        let upIdx = 0;
        let delIdx = 0;
        let rejectedAny = false;
        while (upIdx < upsertKeys.length || delIdx < deletes.length) {
          const sliceKeys = upsertKeys.slice(upIdx, upIdx + batchSize);
          upIdx += sliceKeys.length;
          const sliceDeletes = deletes.slice(delIdx, delIdx + batchSize);
          delIdx += sliceDeletes.length;
          const sliceUpserts = {};
          sliceKeys.forEach(k => { sliceUpserts[k] = upserts[k]; });
          const data = await request('POST', { upserts: sliceUpserts, deletes: sliceDeletes });
          if (!data.applied) throw new Error('Team sheet did not confirm the save');
          const remote = data.entries || {};
          const rejected = new Set(data.rejected || []);
          if (rejected.size) rejectedAny = true;
          sliceKeys.forEach(k => {
            if (rejected.has(k)) return;
            if (!sameValue(remote[k], sliceUpserts[k])) throw new Error('Team sheet did not store a change');
          });
          sliceDeletes.forEach(k => {
            if (rejected.has(k)) return;
            if (Object.prototype.hasOwnProperty.call(remote, k)) throw new Error('Team sheet did not clear a change');
          });
          const acked = acknowledgePush(loadMeta(), sliceUpserts, sliceDeletes);
          rejected.forEach(k => {
            delete acked.pendingUpserts[k];
            acked.pendingDeletes = acked.pendingDeletes.filter(d => d !== k);
            if (acked.pinned.indexOf(k) === -1) acked.pinned.push(k);
          });
          saveMeta(acked);
          epoch += 1;
          applyRemote(remote);
        }
        failCount = 0;
        if (rejectedAny) {
          failed = true;
          setStatus('error', 'The team sheet rejected part of the save.');
          onToast({ kind: 'error', message: 'Team sync failed. Your latest edits are still on this device.' });
        } else {
          setStatus('saved');
          const now = Date.now();
          if (now - lastSavedToastAt > 8000) {
            lastSavedToastAt = now;
            onToast({ kind: 'ok', message: 'Saved for the team' });
          }
        }
      } catch (err) {
        failed = true;
        failCount += 1;
        setStatus('error', err);
        onToast({ kind: 'error', message: 'Team sync failed. Your latest edits are still on this device.' });
      } finally {
        pushing = false;
        const retrySoon = queued;
        queued = false;
        if (failed) schedulePush(Math.min(30000, 2000 * Math.pow(2, Math.max(0, failCount - 1))));
        else if (retrySoon || hasPending(loadMeta())) schedulePush(700);
      }
    }

    async function boot(cfg) {
      config = {
        webAppUrl: String((cfg && cfg.webAppUrl) || '').trim(),
        token: String((cfg && cfg.token) || '').trim(),
      };
      if (!configured()) {
        setStatus('off');
        return;
      }
      setStatus('loading');
      await pull();
    }

    return {
      loadState,
      saveState,
      boot,
      pull,
      flush,
      configured,
      statusInfo,
      schedulePush,
    };
  }

  const api = {
    AM_NAMES,
    KPI_NAMES,
    isSyncableKey,
    stableStringify,
    sameValue,
    normaliseMeta,
    hasPending,
    mergeSharedState,
    noteChange,
    acknowledgePush,
    explainError,
    createHubSync,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MaltaHubSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
