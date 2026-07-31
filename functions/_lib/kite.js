import { getDoc, listDocs, setDoc } from "./firestore.js";

async function getKeys(env) {
  return (await getDoc(env, "kite/keys")) || {};
}

async function getSession(env) {
  const s = await getDoc(env, "kite/session");
  if (!s) return null;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return s.tokenDate === today && s.accessToken ? s : null;
}

async function authHeaders(env) {
  const keys = await getKeys(env);
  const sess = await getSession(env);
  if (!keys.apiKey || !sess) return null;
  return {
    "X-Kite-Version": "3",
    Authorization: "token " + keys.apiKey + ":" + sess.accessToken
  };
}

async function getFutMonthOffset(env) {
  try {
    const d = await getDoc(env, "config/app");
    const n = d ? Number(d.futMonthOffset) : 0;
    return Math.max(0, Math.min(2, isNaN(n) ? 0 : n));
  } catch (e) {
    return 0;
  }
}

async function futuresMap(env, stocks, headers, cacheOnly) {
  const out = {};
  const miss = [];
  for (const s of stocks) {
    const d = await getDoc(env, "kiteInstr/" + s);
    if (d && Date.now() - Number(d.at || 0) < 6 * 3600 * 1000) out[s] = d.list || [];
    else miss.push(s);
  }
  if (!miss.length || cacheOnly || !headers) return out;

  const resp = await fetch("https://api.kite.trade/instruments/NFO", { headers });
  if (!resp.ok) throw new Error("instruments HTTP " + resp.status);
  const text = await resp.text();
  const lines = text.split("\n");
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const patterns = {};
  miss.forEach(s => {
    patterns[s] = new RegExp("^" + s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\d{2}[A-Z]{3}FUT$");
  });
  const map = {};
  miss.forEach(s => { map[s] = []; });
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.indexOf("FUT") === -1) continue;
    const parts = line.split(",");
    const sym = parts[2];
    for (const s of miss) {
      if (patterns[s].test(sym)) {
        let expiry = "";
        for (let j = 4; j < Math.min(parts.length, 9); j++) {
          if (dateRe.test(parts[j])) {
            expiry = parts[j];
            break;
          }
        }
        if (expiry) map[s].push({ expiry, token: Number(parts[0]), symbol: sym });
        break;
      }
    }
  }
  for (const s of miss) {
    map[s].sort((a, b) => a.expiry.localeCompare(b.expiry));
    out[s] = map[s];
    await setDoc(env, "kiteInstr/" + s, { at: Date.now(), list: map[s] });
  }
  return out;
}

function pickFut(list, date, offset) {
  if (!list || !list.length) return null;
  const day = date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const live = list.filter(f => f.expiry >= day);
  return live[Math.max(0, Math.min(2, Number(offset) || 0))] || live[0] || null;
}

async function kiteQuoteFut(env, stocks, cacheOnly) {
  const headers = await authHeaders(env);
  if (!headers) return {};
  const maps = await futuresMap(env, stocks, headers, !!cacheOnly);
  const offset = await getFutMonthOffset(env);
  const symFor = {};
  stocks.forEach(s => {
    const f = pickFut(maps[s], new Date(), offset);
    if (f) symFor[s] = f.symbol;
  });
  const syms = Object.values(symFor);
  if (!syms.length) return {};
  const url = "https://api.kite.trade/quote?" +
    syms.map(s => "i=" + encodeURIComponent("NFO:" + s)).join("&");
  const r = await fetch(url, { headers });
  if (!r.ok) return {};
  const data = ((await r.json()) || {}).data || {};
  const out = {};
  stocks.forEach(s => {
    const q = data["NFO:" + symFor[s]];
    if (q && q.last_price != null) {
      out[s] = {
        price: Number(q.last_price),
        prev: q.ohlc && q.ohlc.close != null ? Number(q.ohlc.close) : null,
        src: "fut"
      };
    }
  });
  return out;
}

async function knownStocks(env) {
  const stocks = new Set();
  const legs = await listDocs(env, "legSizes").catch(() => []);
  legs.forEach(d => {
    if (d.data && d.data.stock) stocks.add(String(d.data.stock));
  });
  const master = await getDoc(env, "config/master").catch(() => null);
  if (master && Array.isArray(master.stocks)) {
    master.stocks.forEach(s => stocks.add(String(s.stock || s)));
  }
  return [...stocks].filter(Boolean);
}

export { authHeaders, futuresMap, getFutMonthOffset, getKeys, getSession, knownStocks, kiteQuoteFut, pickFut };
