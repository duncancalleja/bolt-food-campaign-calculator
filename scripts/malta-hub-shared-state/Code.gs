/**
 * Malta Performance Hub — shared notes, comments and Targeting.
 *
 * Spreadsheet (do not rename, do not edit the KPI tabs from this script):
 *   Title: RAM | Performance Tracker - Sept 2026
 *   ID:    12YkQowNT23C1i9D9SYuPuiYA_HazgSkEZUHRZnNi9kA
 *
 * Tab created by setupHubSharedStateTab / the first authorised request:
 *   Hub shared state
 *
 * Schema (row 1 is the header; one hub key per row):
 *   A key        Stable hub key. See isAllowedKey_ and docs/malta-hub-shared-state.md.
 *   B valueJson  JSON text. Targeting ticks are `true`. Comments are JSON strings.
 *                A person+KPI block is a JSON object (notes, confidence, amComment,
 *                rootCause, pipeline, forecast, plus any legacy fields already stored).
 *   C updatedAt  ISO-8601 UTC timestamp written by this script.
 *   D updatedBy  Label sent by the hub. The current client always sends `malta-hub`.
 *
 * A missing row means the key is unset (checkbox off, comment cleared, block reset).
 *
 * Deploy as a web app, execute as the account that can edit this spreadsheet,
 * access "Anyone". Set script property HUB_SYNC_TOKEN to the same value as
 * data/malta-mm/hub-sync.json. The token is the only check this web app does.
 * Anyone who can read the hub page can read the token and call this endpoint.
 * The script only reads and writes the Hub shared state tab.
 *
 * Setup steps: docs/malta-hub-shared-state.md
 */

var SPREADSHEET_ID = '12YkQowNT23C1i9D9SYuPuiYA_HazgSkEZUHRZnNi9kA';
var TAB_NAME = 'Hub shared state';
var HEADERS = ['key', 'valueJson', 'updatedAt', 'updatedBy'];
var TOKEN_PROPERTY = 'HUB_SYNC_TOKEN';
var MAX_KEYS = 500;
var MAX_VALUE_CHARS = 40000;

var AM_NAMES = [
  'Alena Tokareva',
  'Rico Spagnol',
  'Yousef Moungad',
  'Gulcin Erguven',
  'Fiona Borg'
];
var KPI_NAMES = [
  'Q3 Renegotiations',
  'Sponsored Listings',
  'Bolt Plus',
  'Marketing Campaigns',
  'Smart Promotions'
];

/** Run once from the Apps Script editor to create the tab before the first AM opens the hub. */
function setupHubSharedStateTab() {
  var sheet = ensureSheet_(spreadsheet_());
  console.log('Hub shared state ready on ' + sheet.getParent().getName() + ' / ' + sheet.getName());
}

function doGet(e) {
  return handle_((e && e.parameter) || {}, null);
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad json' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json_({ ok: false, error: 'bad json' });
  }
  return handle_((e && e.parameter) || {}, body);
}

function handle_(params, body) {
  try {
    var token = String((body && body.token) || (params && params.token) || '');
    if (!authorised_(token)) return json_({ ok: false, error: 'unauthorized' });

    var result = { rejected: [], applied: false, entries: {} };
    withLock_(function () {
      var sheet = ensureSheet_(spreadsheet_());
      if (body) {
        var wrote = applyChanges_(sheet, body);
        result.rejected = wrote.rejected;
        result.applied = true;
        result.entries = wrote.entries;
      } else {
        result.entries = readEntries_(sheet);
      }
    });
    return json_({
      ok: true,
      applied: result.applied,
      entries: result.entries,
      rejected: result.rejected,
      serverTime: new Date().toISOString()
    });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function authorised_(token) {
  var expected = PropertiesService.getScriptProperties().getProperty(TOKEN_PROPERTY) || '';
  if (!expected || !token || expected.length !== token.length) return false;
  var mismatch = 0;
  for (var i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return mismatch === 0;
}

function spreadsheet_() {
  try {
    var active = SpreadsheetApp.getActive();
    if (active && active.getId() === SPREADSHEET_ID) return active;
  } catch (err) {
    // Standalone scripts have no active spreadsheet.
  }
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function ensureSheet_(ss) {
  var sheet = ss.getSheetByName(TAB_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(TAB_NAME);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 360);
    sheet.setColumnWidth(2, 480);
    return sheet;
  }
  var header = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0].map(function (cell) {
    return String(cell || '');
  });
  if (header.every(function (cell) { return !cell; })) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  if (header.join('|') !== HEADERS.join('|')) {
    throw new Error('Hub shared state tab exists but the header row is not key | valueJson | updatedAt | updatedBy');
  }
  return sheet;
}

function readEntries_(sheet) {
  var last = sheet.getLastRow();
  var entries = {};
  if (last < 2) return entries;
  var values = sheet.getRange(2, 1, last - 1, 4).getValues();
  values.forEach(function (row) {
    var key = String(row[0] || '');
    if (!key || !isAllowedKey_(key)) return;
    entries[key] = decodeValue_(row[1]);
  });
  return entries;
}

function applyChanges_(sheet, body) {
  var rejected = [];
  var upserts = body.upserts && typeof body.upserts === 'object' && !Array.isArray(body.upserts) ? body.upserts : {};
  var deletes = Array.isArray(body.deletes) ? body.deletes : [];
  var upsertKeys = Object.keys(upserts);
  if (upsertKeys.length + deletes.length > MAX_KEYS) {
    throw new Error('too many keys');
  }

  var rows = readRows_(sheet);
  var index = {};
  rows.forEach(function (row, i) { index[row.key] = i; });

  var now = new Date().toISOString();
  var who = String(body.updatedBy || '').slice(0, 80);
  upsertKeys.forEach(function (key) {
    if (!isAllowedKey_(key)) {
      rejected.push(key);
      return;
    }
    var encoded;
    try {
      encoded = JSON.stringify(upserts[key]);
    } catch (err) {
      rejected.push(key);
      return;
    }
    if (!encoded || encoded.length > MAX_VALUE_CHARS) {
      rejected.push(key);
      return;
    }
    var record = { key: key, valueJson: encoded, updatedAt: now, updatedBy: who };
    if (index[key] != null) rows[index[key]] = record;
    else {
      index[key] = rows.length;
      rows.push(record);
    }
  });

  var drop = {};
  deletes.forEach(function (key) {
    if (!isAllowedKey_(key)) {
      rejected.push(key);
      return;
    }
    drop[key] = true;
  });
  var kept = rows.filter(function (row) { return row.key && !drop[row.key]; });
  rewrite_(sheet, kept);
  console.log('hub sync write upserts=' + upsertKeys.length + ' deletes=' + deletes.length + ' rejected=' + rejected.length);
  var entries = {};
  kept.forEach(function (row) {
    if (!isAllowedKey_(row.key)) return;
    entries[row.key] = decodeValue_(row.valueJson);
  });
  return { rejected: rejected, entries: entries };
}

function readRows_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, 4).getValues().map(function (row) {
    return {
      key: String(row[0] || ''),
      valueJson: encodeStored_(row[1]),
      updatedAt: row[2] instanceof Date ? row[2].toISOString() : String(row[2] || ''),
      updatedBy: String(row[3] || '')
    };
  }).filter(function (row) { return row.key; });
}

function rewrite_(sheet, rows) {
  var last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, 4).clearContent();
  if (!rows.length) return;
  var values = rows.map(function (row) {
    return [row.key, row.valueJson, row.updatedAt, row.updatedBy];
  });
  sheet.getRange(2, 1, values.length, 4).setValues(values);
}

function encodeStored_(cell) {
  if (cell === true || cell === false) return JSON.stringify(cell);
  if (cell instanceof Date) return JSON.stringify(cell.toISOString());
  return String(cell == null ? '' : cell);
}

function decodeValue_(cell) {
  if (cell === true || cell === false) return cell;
  if (cell instanceof Date) return cell.toISOString();
  var text = String(cell == null ? '' : cell);
  try { return JSON.parse(text); } catch (err) { return text; }
}

/** Keep this allowlist aligned with isSyncableKey in malta-hub-sync.js. */
function isAllowedKey_(key) {
  if (typeof key !== 'string' || !key || key.length > 400) return false;
  if (/[\u0000-\u001f]/.test(key)) return false;
  var parts = key.split('||');
  if (key.indexOf('targeting||') === 0) return parts.length >= 4;
  if (key.indexOf('amComment||') === 0) return parts.length >= 3;
  if (key.indexOf('nextStep||') === 0) return parts.length >= 3;
  if (key.indexOf('next||') === 0) return parts.length >= 3;
  return parts.length === 2 && AM_NAMES.indexOf(parts[0]) !== -1 && KPI_NAMES.indexOf(parts[1]) !== -1;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); }
  finally { lock.releaseLock(); }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
