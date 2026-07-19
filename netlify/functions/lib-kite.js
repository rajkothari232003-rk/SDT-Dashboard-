// Kite helpers shared by the kite + webhook functions.
// Keys + daily access token live in Firestore (kite/keys, kite/session),
// written only by these functions (clients are denied by rules).
const { getDb } = require('./lib-firebase');

async function getKeys(){
  const d = await getDb().collection('kite').doc('keys').get();
  return d.exists ? d.data() : {};
}
async function getSession(){
  const d = await getDb().collection('kite').doc('session').get();
  if (!d.exists) return null;
  const s = d.data();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return (s.tokenDate === today && s.accessToken) ? s : null;
}
async function authHeaders(){
  const keys = await getKeys();
  const sess = await getSession();
  if (!keys.apiKey || !sess) return null;
  return { 'X-Kite-Version': '3',
           'Authorization': 'token ' + keys.apiKey + ':' + sess.accessToken };
}

/** current-month futures contracts per stock, cached in Firestore for 6h */
async function futuresMap(stocks, headers, cacheOnly){
  const db = getDb();
  const out = {}; const miss = [];
  for (const s of stocks) {
    const d = await db.collection('kiteInstr').doc(s).get();
    if (d.exists && Date.now() - d.data().at < 6 * 3600 * 1000) out[s] = d.data().list;
    else miss.push(s);
  }
  if (!miss.length || cacheOnly || !headers) return out;

  const resp = await fetch('https://api.kite.trade/instruments/NFO', { headers });
  if (!resp.ok) throw new Error('instruments HTTP ' + resp.status);
  const text = await resp.text();
  const lines = text.split('\n');
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const patterns = {};
  miss.forEach(s => patterns[s] =
    new RegExp('^' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\d{2}[A-Z]{3}FUT$'));
  const map = {}; miss.forEach(s => map[s] = []);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.indexOf('FUT') === -1) continue;
    const parts = line.split(',');
    const sym = parts[2];
    for (const s of miss) {
      if (patterns[s].test(sym)) {
        let expiry = '';
        for (let j = 4; j < Math.min(parts.length, 9); j++) {
          if (dateRe.test(parts[j])) { expiry = parts[j]; break; }
        }
        if (expiry) map[s].push({ expiry, token: Number(parts[0]), symbol: sym });
        break;
      }
    }
  }
  for (const s of miss) {
    map[s].sort((a, b) => a.expiry.localeCompare(b.expiry));
    out[s] = map[s];
    await db.collection('kiteInstr').doc(s).set({ at: Date.now(), list: map[s] });
  }
  return out;
}

function pickFut(list, date){
  if (!list || !list.length) return null;
  const day = date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  for (const f of list) if (f.expiry >= day) return f;
  return null;
}

/** live LTP + previous close for the current-month future of each stock */
async function kiteQuoteFut(stocks, cacheOnly){
  const headers = await authHeaders();
  if (!headers) return {};
  const maps = await futuresMap(stocks, headers, !!cacheOnly);
  const symFor = {};
  stocks.forEach(s => { const f = pickFut(maps[s], new Date()); if (f) symFor[s] = f.symbol; });
  const syms = Object.values(symFor);
  if (!syms.length) return {};
  const url = 'https://api.kite.trade/quote?' +
    syms.map(s => 'i=' + encodeURIComponent('NFO:' + s)).join('&');
  const r = await fetch(url, { headers });
  if (!r.ok) return {};
  const data = ((await r.json()) || {}).data || {};
  const out = {};
  stocks.forEach(s => {
    const q = data['NFO:' + symFor[s]];
    if (q && q.last_price != null) {
      out[s] = { price: Number(q.last_price),
        prev: (q.ohlc && q.ohlc.close != null) ? Number(q.ohlc.close) : null, src: 'fut' };
    }
  });
  return out;
}

module.exports = { getKeys, getSession, authHeaders, futuresMap, pickFut, kiteQuoteFut };
