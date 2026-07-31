import { jsonResponse } from "../_lib/firestore.js";
import { kiteQuoteFut } from "../_lib/kite.js";

const SYMBOL_MAP = { NIFTY: "^NSEI", BANKNIFTY: "^NSEBANK" };
const INDICES = [
  { name: "NIFTY 50", sym: "^NSEI" },
  { name: "BANKNIFTY", sym: "^NSEBANK" },
  { name: "SENSEX", sym: "^BSESN" }
];

async function yahoo(sym) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(sym) + "?range=1d&interval=1d";
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) return null;
  const j = await r.json();
  const m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  if (!m || m.regularMarketPrice == null) return null;
  const price = Number(m.regularMarketPrice);
  const prev = m.chartPreviousClose != null ? Number(m.chartPreviousClose) : null;
  return {
    price,
    chg: prev != null ? price - prev : null,
    chgPct: prev ? (price - prev) / prev * 100 : null
  };
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const stocks = (url.searchParams.get("stocks") || "")
      .split(",").map(s => s.trim()).filter(Boolean);

    const indices = [];
    for (const ix of INDICES) {
      const q = await yahoo(ix.sym);
      indices.push({
        name: ix.name,
        price: q ? q.price : null,
        chg: q ? q.chg : null,
        chgPct: q ? q.chgPct : null
      });
    }

    const spot = {};
    for (const s of stocks) {
      const sym = SYMBOL_MAP[s] || (s + ".NS");
      const q = await yahoo(sym);
      if (q) spot[s] = { price: q.price, chg: q.chg };
    }

    let fut = {};
    try { fut = await kiteQuoteFut(env, stocks, false); } catch (e) {}
    stocks.forEach(s => {
      if (!fut[s] && spot[s]) {
        fut[s] = {
          price: spot[s].price,
          prev: spot[s].chg != null ? spot[s].price - spot[s].chg : null,
          src: "spot"
        };
      }
    });

    return jsonResponse(200, { indices, spot, fut }, { "Cache-Control": "public, max-age=10" });
  } catch (err) {
    return jsonResponse(500, { error: err && err.message ? err.message : String(err) });
  }
}
