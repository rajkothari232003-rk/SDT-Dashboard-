import { getDoc, jsonResponse, setDoc } from "../_lib/firestore.js";
import { authHeaders, futuresMap, getFutMonthOffset, getKeys, getSession, knownStocks, pickFut } from "../_lib/kite.js";

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function bodyJson(request) {
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}

async function actionFrom(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("action")) return url.searchParams.get("action");
  if (request.method === "POST") {
    const body = await bodyJson(request);
    return { action: body.action || "", body };
  }
  return "";
}

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url);
    const parsedAction = await actionFrom(request);
    const action = typeof parsedAction === "string" ? parsedAction : parsedAction.action;
    const postedBody = typeof parsedAction === "string" ? null : parsedAction.body;

    if (action === "status") {
      const keys = await getKeys(env);
      const sess = await getSession(env);
      const site = env.URL || url.origin || "";
      return jsonResponse(200, {
        configured: !!(keys.apiKey && keys.apiSecret),
        connected: !!sess,
        tokenDate: sess ? sess.tokenDate : "",
        apiKeyMasked: keys.apiKey ? keys.apiKey.slice(0, 4) + "...." : "",
        loginUrl: keys.apiKey
          ? "https://kite.zerodha.com/connect/login?v=3&api_key=" + encodeURIComponent(keys.apiKey)
          : "",
        webAppUrl: site,
        webhookUrl: site ? site + "/api/webhook?token=" + (env.WEBHOOK_TOKEN || "SET_WEBHOOK_TOKEN") : "",
        futMonthOffset: await getFutMonthOffset(env)
      });
    }

    if (action === "saveKeys") {
      const b = postedBody || await bodyJson(request);
      const app = await getDoc(env, "config/app");
      const pin = app ? String(app.adminPin || "0000") : "0000";
      if (String(b.pin || "") !== pin) return jsonResponse(403, { error: "Admin PIN incorrect." });
      if (!b.key || !b.secret) return jsonResponse(400, { error: "Both API key and secret are required." });
      await setDoc(env, "kite/keys", { apiKey: String(b.key).trim(), apiSecret: String(b.secret).trim() });
      return jsonResponse(200, { ok: true });
    }

    if (action === "exchange") {
      const reqTok = url.searchParams.get("request_token") || "";
      if (!reqTok) return jsonResponse(400, { error: "Missing request_token." });
      const keys = await getKeys(env);
      if (!keys.apiKey || !keys.apiSecret) return jsonResponse(400, { error: "Save API key & secret first." });
      const checksum = await sha256Hex(keys.apiKey + reqTok + keys.apiSecret);
      const r = await fetch("https://api.kite.trade/session/token", {
        method: "POST",
        headers: {
          "X-Kite-Version": "3",
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({ api_key: keys.apiKey, request_token: reqTok, checksum })
      });
      const body = await r.json();
      if (!r.ok || !body.data) return jsonResponse(400, { error: body.message || ("HTTP " + r.status) });
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      await setDoc(env, "kite/session", { accessToken: body.data.access_token, tokenDate: today });
      try {
        const headers = await authHeaders(env);
        const stocks = await knownStocks(env);
        if (headers && stocks.length) await futuresMap(env, stocks, headers, false);
      } catch (e) {}
      if (/text\/html/.test(request.headers.get("accept") || "")) {
        return Response.redirect(url.origin + "/?kite=ok", 302);
      }
      return jsonResponse(200, { ok: true });
    }

    if (action === "candles") {
      const b = postedBody || await bodyJson(request);
      const rows = Array.isArray(b.rows) ? b.rows.slice(0, 40) : [];
      const headers = await authHeaders(env);
      if (!headers) return jsonResponse(400, { error: "Kite session inactive - login in Settings first." });
      const stocks = [...new Set(rows.map(r => String(r.stock)))];
      const maps = await futuresMap(env, stocks, headers, false);
      const offset = await getFutMonthOffset(env);
      const out = {};
      for (const row of rows) {
        const when = new Date(row.time);
        if (isNaN(when.getTime())) continue;
        const fut = pickFut(maps[String(row.stock)], when, offset);
        if (!fut) continue;
        const day = when.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        const hm = when.toLocaleTimeString("en-GB",
          { timeZone: "Asia/Kolkata", hour12: false }).slice(0, 5);
        const from = day + " " + hm + ":00";
        const histUrl = "https://api.kite.trade/instruments/historical/" + fut.token +
          "/minute?from=" + encodeURIComponent(from) +
          "&to=" + encodeURIComponent(from);
        const r = await fetch(histUrl, { headers });
        if (!r.ok) continue;
        const data = ((await r.json()) || {}).data;
        const c = data && data.candles && data.candles[0];
        if (c) out[row.id] = Number(c[4]);
      }
      return jsonResponse(200, out);
    }

    return jsonResponse(400, { error: "Unknown action." });
  } catch (err) {
    return jsonResponse(500, { error: err && err.message ? err.message : String(err) });
  }
}
