# SDT Dashboard — Netlify + Firebase Edition

Same app, same layout, same mechanisms — now a static web app on Netlify with
Firestore as the database and serverless functions for the TradingView webhook
and all Zerodha (Kite) calls. Realtime: every trade pushes to all open screens
in under a second (no more polling delay).

## Folder map
```
index.html                  the app (UI unchanged from the Apps Script version)
js/firebase-config.js       <- YOU fill this in (or DEMO_MODE=true to preview)
js/api.js                   data layer (Firestore + /api functions), installs the
                            google.script.run shim so app.js runs unmodified
js/app.js                   all UI logic (ported 1:1)
netlify/functions/webhook.js   TradingView POST -> parse -> dedupe -> Firestore
netlify/functions/kite.js      Kite proxy (keys, daily login, minute candles)
netlify/functions/quotes.js    indices + spot (Yahoo) + futures LTP/prev (Kite)
netlify.toml               routes /api/* to the functions
firestore.rules            security rules (paste into Firebase console)
gmail-backup/Code.gs       OPTIONAL email backup bridge (recommended)
```

## 1. Firebase (10 min)
1. https://console.firebase.google.com -> Add project (any name; Analytics off is fine).
2. Build -> **Firestore Database** -> Create (production mode, region asia-south1).
3. Firestore -> Rules tab -> paste the contents of `firestore.rules` -> Publish.
4. Build -> **Authentication** -> Get started -> Sign-in method -> enable **Anonymous**.
5. Project settings (gear) -> Your apps -> **</> Web** -> register -> copy the
   `firebaseConfig` object into `js/firebase-config.js`.
6. Project settings -> **Service accounts** -> Generate new private key ->
   downloads a JSON file. You'll paste its ENTIRE contents into a Netlify env var.

## 2. Netlify (10 min)
1. Push this folder to a GitHub repo (or drag-drop deploy, but Git is better).
2. https://app.netlify.com -> Add new site -> Import from Git -> pick the repo.
   Build command: (leave empty)  Publish directory: `.`
3. Site settings -> **Environment variables** -> add:
   - `FIREBASE_SERVICE_ACCOUNT` = the full JSON from step 1.6 (paste as one value)
   - `WEBHOOK_TOKEN` = a long random string (this protects the webhook)
4. Deploy. Your app is live at `https://YOURSITE.netlify.app`.
   (Optional: Domain settings -> add a custom domain.)

## 3. First run
1. Open the site -> user picker appears -> **Admin**, PIN **0000**
   (change it immediately in Settings). Users Raj/Dipti/Pooja/Ujjaval/Harsh and
   your Master lists are auto-seeded on first load.
2. Settings -> Kite section -> enter **API key + API secret** (same Zerodha app
   as before) -> Save. IMPORTANT: in your Kite Connect app settings on
   developers.kite.trade, change the **Redirect URL** to:
   `https://YOURSITE.netlify.app/api/kite?action=exchange`
3. Daily activation is unchanged: Settings -> Login to Zerodha -> approve ->
   you land back on the app connected, futures cache pre-warmed.

## 4. TradingView
Point every alert's **Webhook URL** to:
`https://YOURSITE.netlify.app/api/webhook?token=YOUR_WEBHOOK_TOKEN`
(the exact URL shows in Settings once deployed). Message format unchanged —
the Alert Creator generates identical messages, human summary line included.

## 5. OPTIONAL but recommended: Gmail backup
Keep "Send email" ON in TradingView alerts. Paste `gmail-backup/Code.gs` into a
new project at script.google.com, fill WEBHOOK_URL, add a time trigger
(forwardAlerts, every minute). If a webhook POST ever drops, the email path
delivers it within a minute — fingerprint doc-ids make duplicates impossible.

## 6. Migrating your current data
Old app -> Download tab -> **Export open positions** -> new app -> Download tab
-> **Import**. Positions, average prices, and Total Qty sizes carry over.
Run both systems in parallel for a day (TradingView allows only one webhook URL
per alert, so switch alerts over leg by leg, or all at once after one test).

## Notes & trade-offs
- Cost: Netlify free tier + Firebase Spark handles this easily; Functions cold
  starts add ~1s to the FIRST alert after a quiet period (rarely matters in
  market hours).
- Security model: same as before — the URL + user picker + admin PIN. Anonymous
  Firebase auth blocks random internet writes; the webhook needs the token;
  Kite secret/token never reach any browser. For per-person logins later,
  Firebase Auth email/password can be added without UI changes.
- DEMO preview: set `DEMO_MODE = true` in js/firebase-config.js and open
  index.html — full UI with sample data, nothing saved.
