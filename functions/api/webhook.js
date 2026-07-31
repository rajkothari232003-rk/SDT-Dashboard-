import { createDoc, getDoc, textResponse } from "../_lib/firestore.js";
import { kiteQuoteFut } from "../_lib/kite.js";

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function parseSdtLine(line) {
  line = String(line || "");
  const at = line.indexOf("SDT|");
  if (at === -1) return null;
  const seg = line.slice(at).trim();
  const fields = {};
  seg.split("|").forEach(part => {
    const eq = part.indexOf("=");
    if (eq > 0) fields[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim();
  });
  if (!fields.ACC || !fields.STOCK || !fields.QTY) return null;
  let qty = Number(String(fields.QTY).replace(/,/g, ""));
  if (isNaN(qty) || !qty) return null;
  let side = (fields.SIDE || "").toUpperCase();
  if (side.indexOf("{") !== -1) side = "";
  if (side.startsWith("S")) qty = -Math.abs(qty);
  else if (side.startsWith("B") || side === "LONG") qty = Math.abs(qty);
  let time = "";
  if (fields.TIME) {
    const d = new Date(fields.TIME);
    if (!isNaN(d.getTime())) time = d.toISOString();
  }
  const num = v => {
    const n = Number(String(v || "").replace(/,/g, ""));
    return isNaN(n) ? "" : n;
  };
  return {
    acc: fields.ACC,
    stock: String(fields.STOCK).toUpperCase(),
    ind: fields.IND || "",
    tf: fields.TF || "",
    lot: num(fields.LOT),
    side: qty < 0 ? "SELL" : "BUY",
    qty,
    price: num(fields.PRICE),
    pos: num(fields.POS),
    time
  };
}

async function fingerprintOf(t) {
  const parts = [t.acc, t.stock, t.ind, t.tf, t.qty, t.side, t.price,
    t.time ? new Date(t.time).getTime() : ""];
  return "fp" + (await sha256Hex(parts.join("|"))).slice(0, 30);
}

export async function onRequestPost({ request, env }) {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") || "";
    if (!env.WEBHOOK_TOKEN || token !== env.WEBHOOK_TOKEN) {
      return textResponse(403, "forbidden");
    }
    const payload = await request.text();
    if (payload.indexOf("SDT|") === -1) return textResponse(200, "ignored");

    const trades = [];
    payload.split(/\r?\n/).forEach(l => {
      const t = parseSdtLine(l);
      if (t) trades.push(t);
    });
    if (!trades.length) {
      const t = parseSdtLine(payload.replace(/[\r\n]+/g, ""));
      if (t) trades.push(t);
    }
    if (!trades.length) return textResponse(200, "unparseable");

    let allowedAccounts = null;
    try {
      const master = await getDoc(env, "config/master");
      const accounts = master ? (master.accounts || []) : [];
      if (accounts.length) {
        allowedAccounts = new Set(accounts.map(a => String(a || "").trim().toUpperCase()).filter(Boolean));
      }
    } catch (e) {}

    const filteredTrades = allowedAccounts
      ? trades.filter(t => allowedAccounts.has(String(t.acc || "").trim().toUpperCase()))
      : trades;
    const ignored = trades.length - filteredTrades.length;
    if (!filteredTrades.length) return textResponse(200, "ignored account" + (ignored ? ":" + ignored : ""));

    let futFor = {};
    try {
      const nowMs = Date.now();
      const fresh = filteredTrades.every(t => !t.time || (nowMs - new Date(t.time).getTime()) < 90000);
      if (fresh) futFor = await kiteQuoteFut(env, [...new Set(filteredTrades.map(t => t.stock))], true);
    } catch (e) {}

    let logged = 0;
    let dup = 0;
    for (const t of filteredTrades) {
      const fp = await fingerprintOf(t);
      const fut = futFor[t.stock] ? futFor[t.stock].price : null;
      const doc = {
        time: t.time || new Date().toISOString(),
        acc: t.acc,
        stock: t.stock,
        ind: t.ind,
        tf: t.tf,
        lot: t.lot === "" ? null : t.lot,
        side: t.side,
        qty: t.qty,
        alertPx: t.price === "" ? null : t.price,
        pos: t.pos === "" ? null : t.pos,
        srcId: "wh",
        executed: false,
        futAtSignal: fut,
        tradePx: null,
        execPl: null
      };
      const created = await createDoc(env, "trades", fp, doc);
      if (created) logged++;
      else dup++;
    }
    return textResponse(200, "ok:" + logged + (dup ? " dup:" + dup : "") + (ignored ? " ignored:" + ignored : ""));
  } catch (err) {
    return textResponse(500, "error:" + (err && err.message ? err.message : String(err)));
  }
}

export function onRequest(context) {
  if (context.request.method !== "POST") return textResponse(405, "POST only");
  return onRequestPost(context);
}
