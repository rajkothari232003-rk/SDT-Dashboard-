# SDT Dashboard Cloudflare Setup

This keeps the app behavior the same as Netlify:

- Dashboard stays as the same static app.
- `/api/quotes` gives index, spot and futures prices.
- `/api/kite` handles Zerodha Kite keys, daily login and candles.
- `/api/webhook` receives TradingView alerts.
- Firebase Firestore remains the database.
- `_routes.json` sends only `/api/*` to Functions, so normal dashboard files stay static.

## 1. Create Cloudflare Pages project

1. Open Cloudflare Dashboard.
2. Go to Workers & Pages.
3. Create application.
4. Select Pages.
5. Connect the GitHub repository.
6. Build settings:
   - Framework preset: None
   - Build command: leave blank
   - Build output directory: `.`
   - Functions directory: `functions` if Cloudflare asks.

## 2. Add environment variables

In Cloudflare Pages project settings, add these variables/secrets:

- `FIREBASE_SERVICE_ACCOUNT`
  - Full Firebase service account JSON.
- `WEBHOOK_TOKEN`
  - Same private webhook token used before.
- `URL`
  - Your new Cloudflare app URL, for example `https://your-project.pages.dev`.

Do not put extra quotes around the JSON value unless Cloudflare keeps them as part of the value.

## 3. Update Zerodha redirect URL

In Zerodha Kite developer app, set Redirect URL to:

`https://your-project.pages.dev/api/kite?action=exchange`

Replace `your-project.pages.dev` with the real Cloudflare URL.

## 4. Update TradingView webhook URL

Use:

`https://your-project.pages.dev/api/webhook?token=YOUR_WEBHOOK_TOKEN`

## 5. First test

1. Open the Cloudflare app URL.
2. Login as admin.
3. Go to Settings.
4. Save Kite API key and secret if needed.
5. Click Login to Zerodha.
6. Send one test TradingView alert.
7. Confirm it appears in Alerts and Dashboard.

Keep Netlify unchanged until Cloudflare is tested fully.

## Daily change workflow

The GitHub workflow stays the same:

1. Make code changes locally.
2. Commit in GitHub Desktop.
3. Push to GitHub.
4. Cloudflare Pages deploys the new version automatically.
