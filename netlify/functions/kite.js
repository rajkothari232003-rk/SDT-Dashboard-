// ============================================================
// Kite proxy — the API secret and access token never reach the
// browser. GET  ?action=status | ?action=exchange&request_token=..
// POST {action:'saveKeys',key,secret,pin} | {action:'candles',rows:[...]}
// Zerodha app Redirect URL = https://YOURSITE/api/kite?action=exchange
// ============================================================
const crypto = require('crypto');
const { getDb } = require('./lib-firebase');
const { getKeys, getSession, authHeaders, futuresMap, pickFut } = require('./lib-kite');

const json = (code, obj) => ({ statusCode: code,
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  try {
    const qp = event.queryStringParameters || {};
    const action = qp.action ||
      (event.body ? (JSON.parse(event.body).action || '') : '');

    if (action === 'status') {
      const keys = await getKeys();
      const sess = await getSession();
      const site = process.env.URL || '';
      return json(200, {
        configured: !!(keys.apiKey && keys.apiSecret),
        connected: !!sess,
        tokenDate: sess ? sess.tokenDate : '',
        apiKeyMasked: keys.apiKey ? keys.apiKey.slice(0, 4) + '••••' : '',
        loginUrl: keys.apiKey
          ? 'https://kite.zerodha.com/connect/login?v=3&api_key=' +
            encodeURIComponent(keys.apiKey) : '',
        webAppUrl: site,
        webhookUrl: site ? site + '/api/webhook?token=' + (process.env.WEBHOOK_TOKEN || 'SET_WEBHOOK_TOKEN') : ''
      });
    }

    if (action === 'saveKeys') {
      const b = JSON.parse(event.body || '{}');
      const app = await getDb().collection('config').doc('app').get();
      const pin = app.exists ? String(app.data().adminPin || '0000') : '0000';
      if (String(b.pin || '') !== pin) return json(403, { error: 'Admin PIN incorrect.' });
      if (!b.key || !b.secret) return json(400, { error: 'Both API key and secret are required.' });
      await getDb().collection('kite').doc('keys')
        .set({ apiKey: String(b.key).trim(), apiSecret: String(b.secret).trim() });
      return json(200, { ok: true });
    }

    if (action === 'exchange') {
      const reqTok = qp.request_token || '';
      if (!reqTok) return json(400, { error: 'Missing request_token.' });
      const keys = await getKeys();
      if (!keys.apiKey || !keys.apiSecret) return json(400, { error: 'Save API key & secret first.' });
      const checksum = crypto.createHash('sha256')
        .update(keys.apiKey + reqTok + keys.apiSecret).digest('hex');
      const r = await fetch('https://api.kite.trade/session/token', {
        method: 'POST',
        headers: { 'X-Kite-Version': '3',
                   'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ api_key: keys.apiKey,
          request_token: reqTok, checksum }) });
      const body = await r.json();
      if (!r.ok || !body.data) return json(400, { error: body.message || ('HTTP ' + r.status) });
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      await getDb().collection('kite').doc('session')
        .set({ accessToken: body.data.access_token, tokenDate: today });
      // warm the instruments cache for known stocks (best-effort)
      try {
        const legs = await getDb().collection('legSizes').get();
        const master = await getDb().collection('config').doc('master').get();
        const stocks = new Set();
        legs.forEach(d => stocks.add(String(d.data().stock)));
        if (master.exists) (master.data().stocks || []).forEach(s => stocks.add(String(s.stock)));
        const headers = await authHeaders();
        if (headers && stocks.size) await futuresMap([...stocks], headers, false);
      } catch (e) {}
      // browser redirect flow: land back on the app
      if (event.headers && /text\/html/.test(event.headers.accept || '')) {
        return { statusCode: 302, headers: { Location: '/?kite=ok' }, body: '' };
      }
      return json(200, { ok: true });
    }

    if (action === 'candles') {
      // minute-candle close at each trade's timestamp (Run backfill)
      const b = JSON.parse(event.body || '{}');
      const rows = Array.isArray(b.rows) ? b.rows.slice(0, 40) : [];
      const headers = await authHeaders();
      if (!headers) return json(400, { error: 'Kite session inactive — login in Settings first.' });
      const stocks = [...new Set(rows.map(r => String(r.stock)))];
      const maps = await futuresMap(stocks, headers, false);
      const out = {};
      for (const row of rows) {
        const when = new Date(row.time);
        if (isNaN(when.getTime())) continue;
        const fut = pickFut(maps[String(row.stock)], when);
        if (!fut) continue;
        const day = when.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const hm = when.toLocaleTimeString('en-GB',
          { timeZone: 'Asia/Kolkata', hour12: false }).slice(0, 5);
        const from = day + ' ' + hm + ':00';
        const url = 'https://api.kite.trade/instruments/historical/' + fut.token +
          '/minute?from=' + encodeURIComponent(from) +
          '&to=' + encodeURIComponent(from);
        const r = await fetch(url, { headers });
        if (!r.ok) continue;
        const data = ((await r.json()) || {}).data;
        const c = data && data.candles && data.candles[0];
        if (c) out[row.id] = Number(c[4]);              // close
      }
      return json(200, out);
    }

    return json(400, { error: 'Unknown action.' });
  } catch (err) {
    return json(500, { error: err && err.message ? err.message : String(err) });
  }
};
