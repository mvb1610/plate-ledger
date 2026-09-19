# Plate Ledger

Personal calorie & macro tracker. Runs entirely in the browser: the food database
(Canadian Nutrient File 2026 + USDA SR28) ships with the app, the diary is stored on
the device, and photo / text estimates call the Anthropic API directly with your own key.

## Put it online with GitHub Pages (once, ~10 minutes)

1. Create a free account at github.com if you don't have one.
2. Click **New repository**, name it `plate-ledger`, keep it **Public**
   (Pages is free only for public repos), click **Create repository**.
3. On the new repo page click **uploading an existing file**, drag ALL the files and
   folders from this `plate-ledger-app` folder onto the page (index.html, app.js, sw.js,
   manifest.json, README.md, .nojekyll, the `data` folder and the `icons` folder),
   then click **Commit changes**.
   - If the browser upload refuses the folders, use GitHub Desktop or, in Terminal:
     ```
     cd "path/to/plate-ledger-app"
     git init && git add -A && git commit -m "Plate Ledger"
     git branch -M main
     git remote add origin https://github.com/YOUR-USER/plate-ledger.git
     git push -u origin main
     ```
4. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   Branch: `main`, folder `/ (root)`, **Save**.
5. After a minute the page shows your link: `https://YOUR-USER.github.io/plate-ledger/`

## On each phone

1. Open the link in Safari (iPhone) or Chrome (Android).
2. **Settings** tab → paste an Anthropic API key (console.anthropic.com → API keys;
   add a few dollars of credit) → **Save & test**.
3. Share button → **Add to Home Screen**. Opens full-screen, camera works, works offline
   for search and logging (estimates need internet).

Each phone keeps its own diary. Use **Settings → Backup (JSON)** now and then; the backup
never includes the API key.

## Updating the app

Replace the changed files in the repo (usually `app.js` and `index.html`) and bump the
`CACHE` name in `sw.js` so phones pick up the new version on next open.

## Cost

A photo estimate with Claude Sonnet is roughly 1–3 ¢; Haiku is about a third of that.
Search, logging, trends and export are free and offline.
