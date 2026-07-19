// ============================================================
// TradingView webhook -> Firestore. POST /api/webhook?token=...
// One SDT| line per account = one trade doc. Doc id = content
// fingerprint, so duplicates (retries, or the Gmail backup
// delivering the same alert) are rejected by Firestore itself.
// Also live-stamps Fut @ Signal from Kite when a session is
// active (cached instruments only; 90s staleness guard).
// ============================================================
const crypto = require('crypto');
const { getDb } = require('./lib-firebase');
const { kiteQuoteFut } = require('./lib-kite');

function parseSdtLine(line){
  line = String(line || '');
  const at = line.indexOf('SDT|');
  if (at === -1) return null;
  const seg = line.slice(at).trim();
  const fields = {};
  seg.split('|').forEach(part => {
    const eq = part.indexOf('=');
    if (eq > 0) fields[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim();
  });
  if (!fields.ACC || !fields.STOCK || !fields.QTY) return null;
  let qty = Number(String(fields.QTY).replace(/,/g, ''));
  if (isNaN(qty) || !qty) return null;
  let side = (fields.SIDE || '').toUpperCase();
  if (side.indexOf('{') !== -1) side = '';
  if (side.startsWith('S')) qty = -Math.abs(qty);
  else if (side.startsWith('B') || side === 'LONG') qty = Math.abs(qty);
  let time = '';
  if (fields.TIME) {
    const d = new Date(fields.TIME);
    if (!isNaN(d.getTime())) time = d.toISOString();
  }
  const num = v => { const n = Number(String(v || '').replace(/,/g, '')); return isNaN(n) ? '' : n; };
  return { acc: fields.ACC, stock: String(fields.STOCK).toUpperCase(),
    ind: fields.IND || '', tf: fields.TF || '', lot: num(fields.LOT),
    side: qty < 0 ? 'SELL' : 'BUY', qty,
    price: num(fields.PRICE), pos: num(fields.POS), time };
}

function fingerprintOf(t){
  const parts = [t.acc, t.stock, t.ind, t.tf, t.qty, t.side, t.price,
                 t.time ? new Date(t.time).getTime() : ''];
  return 'fp' + crypto.createHash('sha256')
    .update(parts.join('|')).digest('hex').slice(0, 30);
}

exports.handler = async (event) => {
  const out = (code, body) => ({ statusCode: code, body });
  try {
    if (event.httpMethod !== 'POST') return out(405, 'POST only');
    const token = (event.queryStringParameters || {}).token || '';
    if (!process.env.WEBHOOK_TOKEN || token !== process.env.WEBHOOK_TOKEN) {
      return out(403, 'forbidden');
    }
    const payload = event.body || '';
    if (payload.indexOf('SDT|') === -1) return out(200, 'ignored');

    const trades = [];
    payload.split(/\r?\n/).forEach(l => { const t = parseSdtLine(l); if (t) trades.push(t); });
    if (!trades.length) {
      const t = parseSdtLine(payload.replace(/[\r\n]+/g, ''));
      if (t) trades.push(t);
    }
    if (!trades.length) return out(200, 'unparseable');

    // live Fut @ Signal (best-effort; never blocks the write)
    let futFor = {};
    try {
      const nowMs = Date.now();
      const fresh = trades.every(t => !t.time || (nowMs - new Date(t.time).getTime()) < 90000);
      if (fresh) {
        futFor = await kiteQuoteFut([...new Set(trades.map(t => t.stock))], true /*cacheOnly*/);
      }
    } catch (e) { /* pending; Run backfills */ }

    const db = getDb();
    let logged = 0, dup = 0;
    for (const t of trades) {
      const fp = fingerprintOf(t);
      const fut = futFor[t.stock] ? futFor[t.stock].price : null;
      const doc = {
        time: t.time || new Date().toISOString(),
        acc: t.acc, stock: t.stock, ind: t.ind, tf: t.tf, lot: t.lot === '' ? null : t.lot,
        side: t.side, qty: t.qty,
        alertPx: t.price === '' ? null : t.price,
        pos: t.pos === '' ? null : t.pos,
        srcId: 'wh', executed: false,
        futAtSignal: fut, tradePx: null, execPl: null
      };
      try {
        await db.collection('trades').doc(fp).create(doc);   // create() = fail on exist
        logged++;
      } catch (e) {
        if (e.code === 6 || /already exists/i.test(String(e.message))) dup++;
        else throw e;
      }
    }
    return out(200, 'ok:' + logged + (dup ? ' dup:' + dup : ''));
  } catch (err) {
    return out(500, 'error:' + (err && err.message ? err.message : String(err)));
  }
};
