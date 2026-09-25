# Plate Ledger

Personal calorie & macro tracker: https://mvb1610.github.io/plate-ledger/

- **Food database**: Canadian Nutrient File 2026 + USDA SR28 (≈14,300 foods with vitamins & minerals), built into the app.
- **Diary**: kept on the device for speed and offline use, and synced to the signed-in Google account (Firebase, private per user).
- **Claude**: photo / text estimates, meal suggestions and the weekly review call the Anthropic API directly with the user's own key.

## How it's put together

| File | What it does |
| --- | --- |
| `index.html` | Layout and styles. No third-party scripts or stylesheets. |
| `app.js` | The whole app (vanilla JS, no framework, no Firebase SDK). |
| `sw.js` | Service worker: app shell and food data cached for offline use. Cache names are stamped with content hashes at build time. |
| `build_data.py` | Runs in GitHub Actions on every push: builds `data/cnf.json` + `data/usda.json`, the icons and self-hosted fonts, then stamps the cache versions. |
| `.github/workflows/pages.yml` | Build + deploy to GitHub Pages. |

### Sync (since 1.4)

Sign-in uses Google OAuth → Firebase Auth REST; sync uses the Firestore REST API directly
(`users/{uid}/days/{date}` and `users/{uid}/meta/*`, readable/writable only by that user).

- The first screen always comes from the device; nothing waits on the network.
- Edits are saved locally and queued; uploads are batched and survive closing the app.
- Pulls are incremental (documents changed since the last server read time, via a `_u` server timestamp),
  with a full check once a week.
- Every upload carries the version it was based on (`updateTime` precondition). If another device got there
  first, the app pulls, does a three-way merge (per food entry / per setting) and retries — nothing is overwritten.
- If the phone runs out of browser storage, the oldest days that are safely in the cloud are dropped locally and
  fetched again when opened.

## Updating the app

Commit changed files to `main`. The Pages workflow rebuilds everything and stamps new cache versions, so phones pick
up the update on their next launch automatically (no manual version bumps). The food data is only re-downloaded by
phones when the data itself changes.

## On a new phone

Open the link in Safari → Share → **Add to Home Screen** → open it → **Settings → Sign in with Google**.
Photo estimates need an Anthropic API key (Settings → Claude); it's saved to the account so it follows you to other devices.

## Cost

A photo estimate with Claude Sonnet is roughly 1–2 ¢; Haiku is about a third of that. Everything else is free.
