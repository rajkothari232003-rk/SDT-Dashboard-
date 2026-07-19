/**
 * OPTIONAL Gmail backup bridge (recommended). A tiny Apps Script that
 * forwards TradingView alert emails into the same webhook — fingerprint
 * doc-ids in Firestore make duplicates impossible when the direct webhook
 * already delivered. Setup: paste into script.google.com, fill the two
 * constants, add a 1-minute time trigger for forwardAlerts.
 */
const WEBHOOK_URL = 'https://YOURSITE.netlify.app/api/webhook?token=YOUR_WEBHOOK_TOKEN';
const GMAIL_QUERY = 'from:tradingview.com SDT newer_than:1d';
const LABEL = 'SDT-Forwarded';

function forwardAlerts() {
  const label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  const threads = GmailApp.search(GMAIL_QUERY + ' -label:' + LABEL, 0, 20);
  threads.forEach(th => {
    th.getMessages().forEach(m => {
      const text = (m.getSubject() || '') + '\n' + (m.getPlainBody() || '');
      if (text.indexOf('SDT|') === -1) return;
      UrlFetchApp.fetch(WEBHOOK_URL, {
        method: 'post', contentType: 'text/plain',
        payload: text, muteHttpExceptions: true
      });
    });
    th.addLabel(label);
  });
}
