// Market data for the dashboard: NSE indices + spot LTPs via Yahoo
// (proxied — the browser can't call Yahoo directly), plus futures
// LTP + previous close via Kite when the session is active.
const { kiteQuoteFut } = require('./lib-kite');

const SYMBOL_MAP = { NIFTY: '^NSEI', BANKNIFTY: '^NSEBANK' };
const INDICES = [
  { name: 'NIFTY 50',  sym: '^NSEI' },
  { name: 'BANKNIFTY', sym: '^NSEBANK' },
  { name: 'SENSEX',    sym: '^BSESN' }
];

async function yahoo(sym){
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(sym) + '?range=1d&interval=1d';
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return null;
  const j = await r.json();
  const m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  if (!m || m.regularMarketPrice == null) return null;
  const price = Number(m.regularMarketPrice);
  const prev = m.chartPreviousClose != null ? Number(m.chartPreviousClose) : null;
  return { price, chg: prev != null ? price - prev : null,
           chgPct: prev ? (price - prev) / prev * 100 : null };
}

exports.handler = async (event) => {
  try {
    const stocks = ((event.queryStringParameters || {}).stocks || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    const indices = [];
    for (const ix of INDICES) {
      const q = await yahoo(ix.sym);
      indices.push({ name: ix.name,
        price: q ? q.price : null, chg: q ? q.chg : null, chgPct: q ? q.chgPct : null });
    }

    const spot = {};
    for (const s of stocks) {
      const sym = SYMBOL_MAP[s] || (s + '.NS');
      const q = await yahoo(sym);
      if (q) spot[s] = { price: q.price, chg: q.chg };
    }

    let fut = {};
    try { fut = await kiteQuoteFut(stocks, false); } catch (e) {}
    // spot fallback for P&L when the Kite session is inactive
    stocks.forEach(s => {
      if (!fut[s] && spot[s]) {
        fut[s] = { price: spot[s].price,
          prev: spot[s].chg != null ? spot[s].price - spot[s].chg : null, src: 'spot' };
      }
    });

    return { statusCode: 200, headers: { 'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=10' },
      body: JSON.stringify({ indices, spot, fut }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message || err) }) };
  }
};
