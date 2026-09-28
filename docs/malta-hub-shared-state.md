# Malta Performance Hub — shared notes and Targeting

The hub page (`malta-mm-performance.html`) keeps AM comments, Targeting ticks, and the KPI blocks (root cause, pipeline, forecast, confidence, KPI-level AM comment, notes) in the browser under `mt-mm-performance-hub-v2`. With the web app below filled in, that same blob is shared across the Malta MM team. The Google Sheet tab is the source of truth while the browser can reach it. A local copy remains so a short outage does not clear the form.

KPI JSON under `data/malta-mm/` is unchanged. This sync does not write those files and does not touch the other tabs in the workbook.

## Sheet

| | |
|---|---|
| Workbook | `RAM \| Performance Tracker - Sept 2026` |
| Spreadsheet ID | `12YkQowNT23C1i9D9SYuPuiYA_HazgSkEZUHRZnNi9kA` |
| Tab | `Hub shared state` (created by the script; do not rename the workbook) |

Do not edit the existing KPI tabs from this script. The script refuses to rewrite the header if the tab already has a different header row.

## Tab schema

Row 1 is the header. One hub key per row. A missing row means “unset”.

| Column | Header | Contents |
|---|---|---|
| A | `key` | Hub key, exactly as stored in the browser blob |
| B | `valueJson` | JSON value |
| C | `updatedAt` | ISO-8601 UTC time written by the script |
| D | `updatedBy` | Label from the client. The hub sends `malta-hub` |

Keys the hub syncs:

| Key | Value |
|---|---|
| `targeting\|\|{product}\|\|{am}\|\|{providerId}` | `true` while Targeting is ticked. Untick deletes the row. |
| `amComment\|\|{product}\|\|{am}\|\|{providerId}` | Account comment string. |
| `{AM name}\|\|{KPI}` | Object for that AM’s KPI block: `rootCause`, `pipeline`, `forecast`, `confidence`, `amComment`, `notes`, and any legacy fields already on the block (`nextStep`, `rows`). |
| `amComment\|\|{product}\|\|{providerId}`, `nextStep\|\|…`, `next\|\|…` | Older comment keys. Still accepted so a browser that has them can upload them once. |

`{am}` is the canonical AM name already used by the hub (`Alena Tokareva`, `Rico Spagnol`, `Yousef Moungad`, `Gulcin Erguven`, `Fiona Borg`) or `unassigned`. Product and KPI names are the five hub KPIs. The script rejects any other key, so a caller with the token cannot write arbitrary rows, and cannot read the KPI tabs.

Overview Targeted counts are not stored. They are the number of `targeting||` ticks on that product’s target-list rows, summed across the five AMs, from this shared blob.

## Setup

1. Open the workbook above. Leave the name as it is.
2. **Extensions → Apps Script**. If a project is already bound to the sheet, add a script file. Otherwise the menu creates the bound project.
3. Replace the default file with `scripts/malta-hub-shared-state/Code.gs` from this repo. `appsscript.json` in that folder is the clasp manifest (`executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`) if you push with clasp. You do not need clasp.
4. In the Apps Script editor run `setupHubSharedStateTab` once and approve the spreadsheet permission. That inserts the `Hub shared state` tab. You can skip the manual run; the first successful web-app call creates the tab too.
5. **Project Settings → Script properties**. Add `HUB_SYNC_TOKEN` = a long random string (a password manager token is enough). This is not a Google OAuth client secret. Do not reuse a personal password.
6. **Deploy → New deployment → Select type: Web app**.
   - Execute as: **Me** (the Google account that can edit this workbook).
   - Who has access: **Anyone**.
   - Copy the **Web app** URL. It must end in `/exec`, not `/dev`.
7. Put that URL and the same token into `data/malta-mm/hub-sync.json` (`webAppUrl`, `token`).
8. Deploy the site the usual way (`bash scripts/deploy_data_to_boltable.sh`) so the hub and `malta-hub-sync.js` go out together. Until `webAppUrl` and `token` are both set, the page keeps using this device only and the header pill says team sync is not connected.

### What “Anyone” means

The static hub cannot complete a Google login, so the web app has to run without one. It executes as the deploying account and only touches `Hub shared state`. The token stops anonymous callers who do not have it. The token is visible to anyone who can open the hub or this repo after step 7. Treat it as a shared internal password for this tab, not as a secret that protects the rest of the spreadsheet.

If the browser console shows a CORS error, or the response is a Google sign-in page, the deployment access is not **Anyone**, or the URL is the `/dev` link. Create a new deployment after changing access; editing the old one is easy to miss.

### Check the web app before pointing the hub at it

```bash
curl -sL "$WEB_APP_URL?token=$HUB_SYNC_TOKEN&cb=$RANDOM"
```

A healthy read looks like `{"ok":true,"applied":false,"entries":{},...}`. `unauthorized` means the token does not match the script property.

```bash
curl -sL --post302 -X POST \
  -H 'Content-Type: text/plain;charset=utf-8' \
  --data "{\"token\":\"$HUB_SYNC_TOKEN\",\"updatedBy\":\"malta-hub\",\"upserts\":{\"Fiona Borg||Bolt Plus\":{\"notes\":\"setup check\",\"confidence\":\"High\",\"amComment\":\"\"}},\"deletes\":[]}" \
  "$WEB_APP_URL"
```

The response should include `"applied":true` and the same note inside `entries`. Delete it again with `"upserts":{}` and `"deletes":["Fiona Borg||Bolt Plus"]`. `--post302` matters: a plain `curl -L` turns the Apps Script redirect into a GET and the write never lands. The hub’s own check is the `"applied":true` flag; if that is missing it keeps the edit locally and shows a sync error.

## How the page behaves

- On open, the hub loads the sheet (about a four-second cap, then it paints whatever it already has and fills in when the sheet answers).
- Edits write to this device immediately, then POST the changed keys after a short pause.
- The header pill and the pill on each AM page say when the copy is shared, still saving, failed, or not connected. A successful save shows **Saved for the team**. A failed save shows **Team sync failed** and leaves the text on screen.
- Another open tab picks up changes on focus, when the tab becomes visible, and about every 20 seconds. A field you are typing in is not overwritten mid-keystroke.
- **Reset this page to pack defaults** deletes that AM’s `{name}||{KPI}` rows for the team. It does not clear Targeting ticks.

## One-time upload of notes already in a browser

The first time a browser connects, each syncable key that is present locally and missing on the sheet is uploaded. If the sheet already has that key, the sheet value stays. After a successful upload the browser will not push old local-only keys again.

That only collects notes stored in the browser that opened the updated hub. Ask each AM to open the hub once on the machine where they typed comments. Notes that live only on a computer that never opens this version are not copied in.

Two browsers that already disagree, and both upload before either has written that key, can overwrite each other. The last successful upload of that key wins. Once the key is on the sheet, later opens keep the sheet copy.

## Files

| File | Role |
|---|---|
| `malta-hub-sync.js` | Browser client (loaded by the hub page) |
| `malta-mm-performance.html` | Pill, toast, load/save, repaint |
| `data/malta-mm/hub-sync.json` | Web app URL and token |
| `scripts/malta-hub-shared-state/Code.gs` | Apps Script web app |
| `scripts/malta-hub-shared-state/appsscript.json` | Clasp manifest |

Logic check (no sheet required):

```bash
node scripts/malta-hub-shared-state/sync-merge.test.mjs
```
