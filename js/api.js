// ============================================================
// SDT Dashboard — data layer for Netlify + Firebase.
// Recreates the google.script.run bridge the UI already uses,
// backed by Firestore realtime listeners + serverless functions,
// so js/app.js runs unchanged from the Apps Script version.
// ============================================================
import { DEMO_MODE, firebaseConfig } from './firebase-config.js';

let db = null, fbAuthed = false;
let fs = null;                                  // firestore module namespace

// ---------------- realtime local caches ----------------
const CACHE = {
  trades: [],          // {id, time(ISO), acc, stock, ind, tf, lot, side, qty,
                       //  alertPx, pos, srcId, executed, futAtSignal, tradePx, execPl}
  legSizes: [],        // {id, acc, stock, ind, tf, totalQty}
  funds: {},           // acc -> {total, usedOverride}
  users: [],           // {name, role, accounts}
  master: null,        // {accounts, indicators, timeframes, stocks:[{stock,lot}]}
  history: [],         // alert creator history
  config: { adminPin: '0000' },
  kitePublic: { apiKey: '' },
  ready: false
};
let onDataChanged = () => {};
export function setOnDataChanged(fn){ onDataChanged = fn; }

const CONFIG = {
  USED_FUND_PCT: 0.30,
  SYMBOL_MAP: { NIFTY: '^NSEI', BANKNIFTY: '^NSEBANK' },
  SYMBOL_SUFFIX: '.NS',
  DEFAULT_USERS: [
    { name: 'Admin',   role: 'admin',    accounts: '*' },
    { name: 'Raj',     role: 'operator', accounts: '*' },
    { name: 'Dipti',   role: 'operator', accounts: '*' },
    { name: 'Pooja',   role: 'operator', accounts: '*' },
    { name: 'Ujjaval', role: 'operator', accounts: '*' },
    { name: 'Harsh',   role: 'operator', accounts: '*' }
  ],
  DEFAULT_MASTER: {
    accounts: ['CBQ', 'VEC', 'DF'],
    indicators: ['Para 0.01', 'Para 0.02', 'IM'],
    timeframes: ['5S', '10S', '15S', '11', '32', '34', '41', '42', '54', '63', '73'],
    stocks: [{ stock: 'NIFTY', lot: 65 }, { stock: 'ADANIENSOL', lot: 675 },
             { stock: 'ADANIENT', lot: 309 }]
  }
};

/* ==================== shared pure helpers (ported) ==================== */

async function sha256Hex(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function parseSdtLine(line){
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
  return {
    acc: fields.ACC, stock: String(fields.STOCK).toUpperCase(),
    ind: fields.IND || '', tf: fields.TF || '', lot: num(fields.LOT),
    side: qty < 0 ? 'SELL' : 'BUY', qty: qty,
    price: num(fields.PRICE), pos: num(fields.POS), time: time
  };
}

export async function fingerprintOf(t){
  const parts = [t.acc, t.stock, t.ind, t.tf, t.qty, t.side, t.price,
                 t.time ? new Date(t.time).getTime() : ''];
  return 'fp' + (await sha256Hex(parts.join('|'))).slice(0, 30);
}

function legKey(acc, stock, ind, tf){
  return [acc, stock, ind, tf].map(v => String(v == null ? '' : v).trim()).join('||');
}
function isTodayISO(iso){
  const d = new Date(iso), n = new Date();
  return !isNaN(d) && d.getFullYear() === n.getFullYear() &&
         d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

/* ==================== position + P&L engines (ported) ==================== */

function computePositions(){
  const legs = {};
  CACHE.trades.forEach(r => {
    if (!r.acc || !r.stock || !r.qty) return;
    const key = legKey(r.acc, r.stock, r.ind, r.tf);
    if (!legs[key]) legs[key] = { acc: r.acc, stock: r.stock, ind: r.ind, tf: r.tf,
      lot: r.lot, sumQty: 0, maxAbs: 0 };
    const leg = legs[key];
    leg.sumQty += Number(r.qty) || 0;
    leg.maxAbs = Math.max(leg.maxAbs, Math.abs(leg.sumQty), Math.abs(Number(r.qty) || 0));
  });
  return Object.values(legs);
}

function tradePriceForPnl(r){
  if (r.tradePx !== '' && r.tradePx != null) return Number(r.tradePx);
  if (r.futAtSignal !== '' && r.futAtSignal != null) return Number(r.futAtSignal);
  if (r.alertPx !== '' && r.alertPx != null) return Number(r.alertPx);
  return null;
}

function applyAvgTrade(p, qty, price){
  if (p.pos === 0 || p.pos * qty > 0) {
    p.avg = (p.avg * Math.abs(p.pos) + price * Math.abs(qty)) /
            (Math.abs(p.pos) + Math.abs(qty));
    p.pos += qty;
  } else {
    const closeQty = Math.min(Math.abs(qty), Math.abs(p.pos));
    p.realized += (price - p.avg) * closeQty * (p.pos > 0 ? 1 : -1);
    p.pos += qty;
    if (p.pos !== 0 && p.pos * qty > 0) p.avg = price;
    if (p.pos === 0) p.avg = 0;
  }
}

function computePnl(futLtps){
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const startMs = dayStart.getTime();
  const map = {}; let skipped = 0;
  CACHE.trades.slice().sort((a, b) => a.time < b.time ? -1 : 1).forEach(r => {
    const qty = Number(r.qty) || 0;
    if (!r.acc || !r.stock || !qty) return;
    const key = r.acc + '||' + r.stock;
    if (!map[key]) map[key] = { acc: r.acc, stock: r.stock, carry: 0, trades: [] };
    const ms = new Date(r.time).getTime() || 0;
    if (ms < startMs) map[key].carry += qty;
    else map[key].trades.push(r);
  });
  const rows = Object.values(map).map(seed => {
    const l = futLtps[seed.stock];
    const ltp = l ? l.price : null, prev = l ? l.prev : null;
    const p = { acc: seed.acc, stock: seed.stock, pos: seed.carry,
      avg: seed.carry ? prev : 0, realized: 0, incomplete: false };
    if (seed.carry && (prev == null || isNaN(Number(prev)))) p.incomplete = true;
    seed.trades.forEach(r => {
      const qty = Number(r.qty) || 0;
      const price = tradePriceForPnl(r);
      if (price == null || isNaN(price) || p.avg == null || p.incomplete) {
        skipped++;
        p.pos += qty;
        p.incomplete = true;
        return;
      }
      applyAvgTrade(p, qty, Number(price));
    });
    const unreal = (ltp != null && p.pos !== 0 && !p.incomplete)
      ? p.pos * (ltp - p.avg)
      : (p.pos === 0 ? 0 : null);
    const total = unreal == null ? null : p.realized + unreal;
    return { acc: p.acc, stock: p.stock, pos: p.pos,
      avg: p.pos !== 0 && !p.incomplete ? p.avg : null, ltp, prev, src: l ? l.src : null,
      realized: p.realized, unrealized: unreal, dayPnl: total,
      total };
  }).filter(r => r.pos !== 0 || r.realized !== 0)
    .sort((a, b) => a.acc.localeCompare(b.acc) || a.stock.localeCompare(b.stock));
  return { rows, skipped };
}

function computeBookAvgByLeg(){
  const map = {};
  CACHE.trades.slice().sort((a, b) => a.time < b.time ? -1 : 1).forEach(r => {
    const qty = Number(r.qty) || 0;
    const price = tradePriceForPnl(r);
    if (!r.acc || !r.stock || !qty || price == null || isNaN(price)) return;
    const key = legKey(r.acc, r.stock, r.ind, r.tf);
    if (!map[key]) map[key] = { pos: 0, avg: 0, realized: 0 };
    const p = map[key];
    applyAvgTrade(p, qty, Number(price));
  });
  return map;
}

function recomputeExecPl(t){
  const fut = (t.futAtSignal === '' || t.futAtSignal == null) ? null : Number(t.futAtSignal);
  const man = (t.tradePx === '' || t.tradePx == null) ? null : Number(t.tradePx);
  const qty = Number(t.qty) || 0;
  if (fut == null || !fut || man == null || !qty) return null;
  const perUnit = qty > 0 ? (fut - man) : (man - fut);
  return (perUnit / fut) * 100;
}

/* ==================== quotes via serverless proxies ==================== */

let quoteCache = { t: 0, data: null };
async function fetchQuotes(stocks){
  // indices + spot LTPs (Yahoo, proxied) + futures LTP/prev (Kite, proxied)
  const now = Date.now();
  if (quoteCache.data && now - quoteCache.t < 12000 &&
      quoteCache.key === stocks.join(',')) return quoteCache.data;
  const r = await fetch('/api/quotes?stocks=' + encodeURIComponent(stocks.join(',')));
  if (!r.ok) throw new Error('quotes proxy HTTP ' + r.status);
  const data = await r.json();
  quoteCache = { t: now, key: stocks.join(','), data };
  return data;   // { indices:[...], spot:{S:{price,chg}}, fut:{S:{price,prev,src}} }
}

/* ==================== the Server (google.script.run backend) ==================== */

const Server = {

  async getUsers(){
    await ensureReady();
    return CACHE.users.length ? CACHE.users : CONFIG.DEFAULT_USERS;
  },

  async verifyAdminPin(pin){
    await ensureReady();
    return String(pin) === String(CACHE.config.adminPin || '0000');
  },

  async setAdminPin(oldPin, newPin){
    if (!(await Server.verifyAdminPin(oldPin))) throw new Error('Current PIN is incorrect.');
    const np = String(newPin || '').trim();
    if (np.length < 4) throw new Error('PIN must be at least 4 characters.');
    await setDoc('config', 'app', { adminPin: np }, true);
    CACHE.config.adminPin = np;
    return { ok: true };
  },

  async saveUserAccounts(pin, name, accounts){
    if (!(await Server.verifyAdminPin(pin))) throw new Error('Admin PIN incorrect.');
    await setDoc('users', name, { name,
      role: (CACHE.users.find(u => u.name === name) || {}).role || 'operator',
      accounts: String(accounts || '*').trim() || '*' }, true);
    return Server.getUsers();
  },

  async clearTradingData(pin){
    if (!(await Server.verifyAdminPin(pin))) throw new Error('Admin PIN incorrect.');
    const counts = {
      trades: await deleteCollection('trades'),
      legSizes: await deleteCollection('legSizes'),
      funds: await deleteCollection('funds'),
      alertHistory: await deleteCollection('alertHistory')
    };
    CACHE.trades = [];
    CACHE.legSizes = [];
    CACHE.funds = {};
    CACHE.history = [];
    onDataChanged();
    return { ok: true, counts };
  },

  async compactTradingData(pin){
    if (!(await Server.verifyAdminPin(pin))) throw new Error('Admin PIN incorrect.');
    const openLegs = computePositions().filter(l => Number(l.sumQty) !== 0);
    const avgMap = computeBookAvgByLeg();
    const now = new Date().toISOString();
    const snapshots = [];
    openLegs.forEach(l => {
      const qty = Number(l.sumQty) || 0;
      const key = legKey(l.acc, l.stock, l.ind, l.tf);
      const avg = avgMap[key] && avgMap[key].pos !== 0 ? Number(avgMap[key].avg) : null;
      snapshots.push({
        time: now,
        acc: l.acc,
        stock: l.stock,
        ind: l.ind,
        tf: l.tf,
        lot: l.lot === '' ? null : l.lot,
        side: qty < 0 ? 'SELL' : 'BUY',
        qty,
        alertPx: avg,
        pos: null,
        srcId: 'compact',
        executed: true,
        futAtSignal: null,
        tradePx: avg,
        execPl: null
      });
    });
    const deleted = await deleteCollection('trades');
    await deleteCollection('alertHistory');
    CACHE.trades = [];
    CACHE.history = [];
    let created = 0;
    for (const doc of snapshots) {
      const fp = await fingerprintOf({
        acc: doc.acc, stock: doc.stock, ind: doc.ind, tf: doc.tf,
        qty: doc.qty, side: doc.side, price: doc.tradePx, time: doc.time
      });
      await createDocIfAbsent('trades', fp, doc);
      created++;
    }
    onDataChanged();
    return { ok: true, deleted, created };
  },

  async getDashboardData(){
    await ensureReady();
    const overrides = {};
    CACHE.legSizes.forEach(l => {
      if (Number(l.totalQty) > 0) overrides[legKey(l.acc, l.stock, l.ind, l.tf)] = Number(l.totalQty);
    });

    // master legs always display
    const aggLegs = computePositions();
    const have = new Set(aggLegs.map(l => legKey(l.acc, l.stock, l.ind, l.tf)));
    CACHE.legSizes.forEach(m => {
      if (!have.has(legKey(m.acc, m.stock, m.ind, m.tf))) {
        aggLegs.push({ acc: m.acc, stock: m.stock, ind: m.ind, tf: m.tf,
          lot: '', sumQty: 0, maxAbs: 0 });
      }
    });
    aggLegs.sort((a, b) =>
      String(a.acc).localeCompare(String(b.acc)) ||
      String(a.stock).localeCompare(String(b.stock)) ||
      String(a.ind).localeCompare(String(b.ind)) ||
      (Number(a.tf) - Number(b.tf)) || String(a.tf).localeCompare(String(b.tf)));

    const allStocks = [...new Set(aggLegs.map(l => String(l.stock)))];
    let q = { indices: [], spot: {}, fut: {} };
    try { q = await fetchQuotes(allStocks); } catch (e) { /* offline-tolerant */ }

    const legs = aggLegs.map((leg, i) => {
      const qty = leg.sumQty;
      const spot = q.spot[String(leg.stock)];
      const rate = spot && spot.price != null ? spot.price : null;
      const key = legKey(leg.acc, leg.stock, leg.ind, leg.tf);
      const totalQty = (overrides[key] != null) ? overrides[key]
        : Math.max(leg.maxAbs || 0, Math.abs(qty));
      return { sr: i + 1, acc: String(leg.acc), stock: String(leg.stock),
        ind: String(leg.ind), tf: String(leg.tf),
        lot: leg.lot === '' ? '' : Number(leg.lot),
        qty, totalQty, manualSize: overrides[key] != null, rate,
        exposure: rate != null ? qty * rate : null,
        grossExposure: rate != null ? totalQty * rate : null };
    });

    const accMap = {};
    legs.forEach(l => {
      if (!accMap[l.acc]) accMap[l.acc] = { acc: l.acc, gross: 0, net: 0, legs: 0, missing: 0 };
      const a = accMap[l.acc];
      a.legs++;
      if (l.rate == null) { a.missing++; return; }
      a.gross += l.grossExposure; a.net += l.exposure;
    });
    const accounts = Object.values(accMap)
      .sort((x, y) => x.acc.localeCompare(y.acc))
      .map(a => Object.assign(a, { pct: a.gross > 0 ? Math.abs(a.net) / a.gross * 100 : 0 }));

    accounts.forEach(a => {
      const f = CACHE.funds[a.acc] || {};
      a.totalFund = (f.total != null && f.total !== '') ? Number(f.total) : null;
      a.usedManual = (f.usedOverride != null && f.usedOverride !== '');
      a.usedFund = a.usedManual ? Number(f.usedOverride) : a.gross * CONFIG.USED_FUND_PCT;
      a.netAvail = (a.totalFund != null) ? a.totalFund - a.usedFund : null;
    });

    const pnl = computePnl(q.fut || {});

    const notifications = CACHE.trades.slice()
      .sort((a, b) => a.time < b.time ? 1 : -1).slice(0, 120)
      .map(r => ({ row: r.id, time: r.time, acc: r.acc, stock: r.stock,
        ind: r.ind, tf: r.tf, lot: r.lot, side: r.side,
        qty: Number(r.qty) || 0, price: r.alertPx,
        executed: r.executed === true,
        tradePrice: (r.tradePx === '' || r.tradePx == null) ? null : Number(r.tradePx) }));

    return { indices: q.indices || [], accounts, legs, pnl,
             notifications, updated: new Date().toISOString() };
  },

  async saveManualPrice(id, price){
    const v = (price === '' || price == null) ? '' : Number(price);
    if (v !== '' && (isNaN(v) || v < 0)) throw new Error('Enter a valid price.');
    const t = CACHE.trades.find(x => x.id === id);
    if (!t) throw new Error('Trade not found.');
    const upd = { tradePx: v === '' ? null : v, executed: v !== '' };
    const merged = Object.assign({}, t, upd);
    upd.execPl = recomputeExecPl(merged);
    await setDoc('trades', id, upd, true);
    Object.assign(t, upd);
    return { row: id, fut: t.futAtSignal == null ? null : Number(t.futAtSignal),
             manual: v === '' ? null : v, loss: upd.execPl, executed: v !== '' };
  },

  async updateTrade(pin, id, p){
    if (!(await Server.verifyAdminPin(pin))) throw new Error('Admin PIN incorrect.');
    const t = CACHE.trades.find(x => x.id === id);
    if (!t) throw new Error('Trade not found.');
    const clean = s => String(s || '').replace(/\|/g, '').trim();
    const acc = clean(p.acc);
    const stock = clean(p.stock).toUpperCase();
    if (!acc || !stock) throw new Error('Account and Stock are required.');
    let qty = Math.abs(Number(p.qty));
    if (!qty || isNaN(qty)) throw new Error('Enter a valid Qty.');
    const side = String(p.side || '').toUpperCase().startsWith('S') ? 'SELL' : 'BUY';
    if (side === 'SELL') qty = -qty;
    const normNum = (v, label) => {
      if (v === '' || v == null) return null;
      const n = Number(v);
      if (isNaN(n) || n < 0) throw new Error('Enter a valid ' + label + '.');
      return n;
    };
    const when = p.time ? new Date(p.time) : new Date(t.time || Date.now());
    if (isNaN(when.getTime())) throw new Error('Enter a valid time.');
    const upd = {
      time: when.toISOString(),
      acc,
      stock,
      ind: clean(p.ind),
      tf: clean(p.tf),
      lot: normNum(p.lot, 'lot'),
      side,
      qty,
      alertPx: normNum(p.alertPx, 'alert price'),
      tradePx: normNum(p.tradePx, 'trade price'),
      pos: p.pos === '' || p.pos == null ? null : Number(p.pos)
    };
    if (upd.pos != null && isNaN(upd.pos)) throw new Error('Enter a valid position.');
    upd.executed = upd.tradePx != null;
    upd.execPl = recomputeExecPl(Object.assign({}, t, upd));
    await setDoc('trades', id, upd, true);
    Object.assign(t, upd);
    return { ok: true };
  },

  async deleteTrade(pin, id){
    if (!(await Server.verifyAdminPin(pin))) throw new Error('Admin PIN incorrect.');
    const t = CACHE.trades.find(x => x.id === id);
    if (!t) throw new Error('Trade not found.');
    await deleteDoc('trades', id);
    CACHE.trades = CACHE.trades.filter(x => x.id !== id);
    onDataChanged();
    return { ok: true };
  },

  async saveTotalQty(p){
    await ensureReady();
    const id = encodeURIComponent(legKey(p.acc, p.stock, p.ind, p.tf));
    const val = (p.val === '' || p.val == null) ? '' : Number(p.val);
    if (val !== '' && (isNaN(val) || val < 0)) throw new Error('Enter a valid quantity.');
    if (val === '') await deleteDoc('legSizes', id);
    else await setDoc('legSizes', id,
      { acc: p.acc, stock: p.stock, ind: p.ind, tf: p.tf, totalQty: val }, true);
    return { ok: true, override: val === '' ? null : val };
  },

  async getLegMaster(){
    await ensureReady();
    return CACHE.legSizes.map(l => ({ acc: l.acc, stock: l.stock,
      ind: l.ind, tf: l.tf, qty: Number(l.totalQty) || 0 }));
  },

  async saveFund(acc, total, used){
    const norm = v => (v === '' || v == null) ? null : Number(v);
    await setDoc('funds', acc, { total: norm(total), usedOverride: norm(used) }, true);
    CACHE.funds[acc] = { total: norm(total), usedOverride: norm(used) };
    return { ok: true };
  },

  async addManualTrade(p){
    const clean = s => String(s || '').replace(/\|/g, '').trim();
    const acc = clean(p.acc), stock = clean(p.stock).toUpperCase();
    if (!acc || !stock) throw new Error('Select an Account and a Stock.');
    let qty = Math.abs(Number(p.qty));
    if (!qty || isNaN(qty)) throw new Error('Enter a valid Qty.');
    if (String(p.side).toUpperCase().startsWith('S')) qty = -qty;
    const price = (p.price === '' || p.price == null) ? '' : Number(p.price);
    if (price !== '' && (isNaN(price) || price < 0)) throw new Error('Enter a valid price.');
    let when = p.time ? new Date(p.time) : new Date();
    if (isNaN(when.getTime())) when = new Date();
    const t = { acc, stock, ind: clean(p.ind), tf: clean(p.tf), qty,
      side: qty < 0 ? 'SELL' : 'BUY', price, time: when.toISOString() };
    const fp = await fingerprintOf(t);
    if (CACHE.trades.some(x => x.id === fp)) throw new Error('An identical trade already exists.');
    const doc = { time: t.time, acc, stock, ind: t.ind, tf: t.tf, lot: '',
      side: t.side, qty, alertPx: price === '' ? null : price, pos: null,
      srcId: 'manual', executed: true, futAtSignal: null,
      tradePx: price === '' ? null : price, execPl: null };
    await createDocIfAbsent('trades', fp, doc);
    return { ok: true };
  },

  /* ---------- alert creator (identical output to Apps Script version) ---------- */
  async getCreatorData(){
    await ensureReady();
    return { master: CACHE.master || CONFIG.DEFAULT_MASTER,
             history: CACHE.history.slice(0, 50) };
  },

  async saveMaster(m){
    const norm = a => [...new Set((a || []).map(s => String(s).trim()).filter(Boolean))];
    const master = {
      accounts: norm(m.accounts), indicators: norm(m.indicators),
      timeframes: norm(m.timeframes),
      stocks: (m.stocks || []).map(s => ({ stock: String(s.stock).trim().toUpperCase(),
        lot: Number(s.lot) || '' })).filter(s => s.stock)
    };
    await setDoc('config', 'master', master, false);
    CACHE.master = master;
    return master;
  },

  async createAlert(p){
    const clean = s => String(s || '').replace(/\|/g, '').trim();
    const multi = Array.isArray(p.accountsMulti)
      ? p.accountsMulti.map(x => ({ acc: clean(x.acc), qty: Math.abs(Number(x.qty)) }))
                       .filter(x => x.acc && x.qty)
      : null;
    const acc = multi ? multi.map(x => x.acc).join('+') : clean(p.acc);
    const stock = clean(p.stock).toUpperCase();
    const ind = clean(p.ind), tf = clean(p.tf);
    const lot = p.lot === '' || p.lot == null ? '' : Number(p.lot);
    const mode = String(p.mode || '').toUpperCase();
    if (!acc) throw new Error('Select an Account.');
    if (!stock) throw new Error('Select a Stock.');
    if (!['AUTO', 'BUY', 'SELL', 'BOTH', 'STRATEGY'].includes(mode)) throw new Error('Select a Side / Mode.');

    const stockField = p.usePlaceholders ? '{{ticker}}' : stock;
    const tfField = p.usePlaceholders ? '{{interval}}' : tf;
    const baseFor = a => 'SDT' + '|ACC=' + a + '|STOCK=' + stockField +
      (ind ? '|IND=' + ind : '') + (tf || p.usePlaceholders ? '|TF=' + tfField : '') +
      (lot !== '' ? '|LOT=' + lot : '');
    const buildMessage = sfx => multi
      ? multi.map(x => baseFor(x.acc) + sfx(x.qty)).join('\n')
      : baseFor(acc) + sfx(Math.abs(Number(p.qty)));
    const summaryFor = (sideText, priceText, qtyText) => {
      const accPart = multi ? multi.map(x => x.acc + ' ' + x.qty).join(' / ') : acc + ' ' + qtyText;
      return 'SDT: ' + [ind, stockField].filter(Boolean).join(' ') +
        ' - ' + tfField + ' - ' + sideText + ' -@ ' + priceText + ' | ' + accPart;
    };
    const PAD = '\n' + '\u200C\u00A0'.repeat(200) + '\n';
    const nameBase = ['SDT', acc, stock, ind, tf].filter(Boolean).join(' ');
    const results = [];
    const needQty = () => {
      if (!multi && (!Math.abs(Number(p.qty)) || isNaN(Number(p.qty)))) throw new Error('Enter a valid Qty.');
    };
    if (mode === 'AUTO') {
      needQty();
      results.push({ name: nameBase,
        message: summaryFor('{{strategy.order.action}}', '{{close}}', String(Math.abs(Number(p.qty)))) + PAD +
          buildMessage(q => '|QTY=' + q + '|SIDE={{strategy.order.action}}|PRICE={{close}}|TIME={{timenow}}') });
    } else if (mode === 'STRATEGY') {
      results.push({ name: nameBase,
        message: summaryFor('{{strategy.order.action}}', '{{strategy.order.price}}', '{{strategy.order.contracts}}') + PAD +
          buildMessage(() => '|QTY={{strategy.order.contracts}}|SIDE={{strategy.order.action}}' +
            '|POS={{strategy.position_size}}|PRICE={{strategy.order.price}}|TIME={{timenow}}') });
    } else {
      needQty();
      (mode === 'BOTH' ? ['BUY', 'SELL'] : [mode]).forEach(side => {
        results.push({ name: nameBase + (mode === 'BOTH' ? ' ' + side : ''),
          message: summaryFor(side, '{{close}}', String(Math.abs(Number(p.qty)))) + PAD +
            buildMessage(q => '|QTY=' + q + '|SIDE=' + side + '|PRICE={{close}}|TIME={{timenow}}') });
      });
    }
    const now = new Date().toISOString();
    for (const r of results) {
      const id = 'h' + Date.now() + Math.random().toString(36).slice(2, 7);
      const row = { time: now, acc, stock, ind, tf, lot,
        qty: mode === 'STRATEGY' ? 'strategy' : Math.abs(Number(p.qty)),
        mode, name: r.name, message: r.message };
      CACHE.history.unshift(row);
      setDoc('alertHistory', id, row, false).catch(() => {});
    }
    return results;
  },

  /* ---------- execution P/L ---------- */
  async getExecLossData(){
    await ensureReady();
    const rows = CACHE.trades.slice().sort((a, b) => a.time < b.time ? 1 : -1)
      .slice(0, 200).map(r => ({ row: r.id, time: r.time, acc: r.acc,
        stock: r.stock, tf: r.tf, qty: Number(r.qty) || 0, alertPrice: r.alertPx,
        fut: r.futAtSignal == null ? null : Number(r.futAtSignal),
        manual: r.tradePx == null ? null : Number(r.tradePx),
        loss: r.execPl == null ? null : Number(r.execPl) }));
    let kite = { configured: false, connected: false };
    try { kite = await (await fetch('/api/kite?action=status')).json(); } catch (e) {}
    return { rows, kite };
  },

  async runExecutionLoss(){
    const need = CACHE.trades.filter(t =>
      (t.futAtSignal == null || t.futAtSignal === '') && t.stock && t.time).slice(0, 40)
      .map(t => ({ id: t.id, stock: t.stock, time: t.time }));
    if (!need.length) return { updated: 0, remaining: 0 };
    const r = await fetch('/api/kite', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'candles', rows: need }) });
    if (!r.ok) throw new Error('Kite proxy HTTP ' + r.status + ' — activate the API in Settings.');
    const res = await r.json();                     // { id: futPrice }
    let updated = 0;
    for (const id of Object.keys(res)) {
      const t = CACHE.trades.find(x => x.id === id);
      if (!t || res[id] == null) continue;
      const upd = { futAtSignal: res[id] };
      upd.execPl = recomputeExecPl(Object.assign({}, t, upd));
      await setDoc('trades', id, upd, true);
      Object.assign(t, upd); updated++;
    }
    return { updated, remaining: Math.max(0,
      CACHE.trades.filter(t => t.futAtSignal == null).length - updated) };
  },

  /* ---------- kite settings ---------- */
  async getKiteStatus(){
    try { return await (await fetch('/api/kite?action=status')).json(); }
    catch (e) { return { configured: false, connected: false, webAppUrl: location.origin,
      webhookUrl: '(deploy functions first)' }; }
  },
  async saveKiteSettings(key, secret, pin){
    const r = await fetch('/api/kite', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'saveKeys', key, secret, pin }) });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || 'Could not save keys.');
    return Server.getKiteStatus();
  },
  async exchangeRequestToken(token){
    const r = await fetch('/api/kite?action=exchange&request_token=' + encodeURIComponent(token));
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return Server.getKiteStatus();
  },

  /* ---------- excel + snapshot ---------- */
  async exportExcel(fromStr, toStr){
    if (!fromStr) throw new Error('Pick a date first.');
    const from = new Date(fromStr + 'T00:00:00');
    const to = new Date((toStr || fromStr) + 'T23:59:59');
    if (to < from) throw new Error('"To" date is before "From" date.');
    const inR = t => { const d = new Date(t); return d >= from && d <= to; };
    const rows = CACHE.trades.filter(t => inR(t.time))
      .sort((a, b) => a.time < b.time ? -1 : 1);

    const wb = XLSX.utils.book_new();
    const tl = rows.map(r => ({ Time: new Date(r.time), Account: r.acc, Stock: r.stock,
      Indicator: r.ind, Timeframe: r.tf, Side: r.side, Qty: r.qty,
      'Alert Px': r.alertPx, Executed: r.executed ? 'Yes' : 'No',
      'Fut @ Signal': r.futAtSignal, 'Trade Px': r.tradePx, 'Exec P/L %': r.execPl }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tl), 'Trade Log');

    const legMap = {};
    rows.forEach(r => {
      const k = legKey(r.acc, r.stock, r.ind, r.tf);
      if (!legMap[k]) legMap[k] = { Account: r.acc, Stock: r.stock,
        Indicator: r.ind, Timeframe: r.tf, 'Net Qty': 0 };
      legMap[k]['Net Qty'] += Number(r.qty) || 0;
    });
    XLSX.utils.book_append_sheet(wb,
      XLSX.utils.json_to_sheet(Object.values(legMap)), 'Positions');

    const er = rows.filter(r => r.futAtSignal != null || r.tradePx != null)
      .map(r => ({ Time: new Date(r.time), Account: r.acc, Stock: r.stock,
        Timeframe: r.tf, Side: r.side, Qty: Math.abs(r.qty), 'Alert Px': r.alertPx,
        'Fut @ Signal': r.futAtSignal, 'Trade Px': r.tradePx, 'Exec P/L %': r.execPl }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(er), 'Execution P-L');

    const ch = CACHE.history.filter(h => inR(h.time));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ch), 'Alert Creator History');

    const out = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
    return { filename: 'SDT_' + fromStr + ((toStr && toStr !== fromStr) ? '_to_' + toStr : '') + '.xlsx',
      base64: out, counts: { trades: rows.length,
        positions: Object.keys(legMap).length, exec: er.length, creator: ch.length } };
  },

  async exportPositions(){
    // Export exactly the current dashboard open positions, not today's trade log.
    const openLegs = computePositions().filter(l => Number(l.sumQty) !== 0);
    const avgMap = computeBookAvgByLeg();
    const overrides = {};
    CACHE.legSizes.forEach(l => overrides[legKey(l.acc, l.stock, l.ind, l.tf)] = l.totalQty);
    const q = v => { v = String(v == null ? '' : v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const lines = ['Account,Stock,Indicator,Timeframe,Side,Net Qty,Avg Price,Total Qty'];
    openLegs.sort((a, b) =>
      String(a.acc).localeCompare(String(b.acc)) ||
      String(a.stock).localeCompare(String(b.stock)) ||
      String(a.ind).localeCompare(String(b.ind)) ||
      String(a.tf).localeCompare(String(b.tf))
    ).forEach(p => {
      const k = legKey(p.acc, p.stock, p.ind, p.tf);
      const avg = avgMap[k] && avgMap[k].pos !== 0 ? Math.round(avgMap[k].avg * 100) / 100 : '';
      lines.push([q(p.acc), q(p.stock), q(p.ind), q(p.tf),
        p.sumQty > 0 ? 'BUY' : 'SELL', Math.abs(p.sumQty),
        avg, overrides[k] != null ? overrides[k] : Math.max(p.maxAbs || 0, Math.abs(p.sumQty))].join(','));
    });
    const day = new Date().toISOString().slice(0, 10);
    return { filename: 'SDT_Positions_' + day + '.csv',
             csv: lines.join('\n'), count: lines.length - 1 };
  },

  async importPositions(csvText){
    const rows = parseCsv(String(csvText || ''));
    if (!rows.length) throw new Error('Empty file.');
    const head = rows[0].map(h => String(h).trim().toLowerCase());
    const col = n => head.indexOf(n);
    const iA = col('account'), iS = col('stock'), iI = col('indicator'),
          iT = col('timeframe'), iSd = col('side'), iQ = col('net qty'),
          iAv = col('avg price'), iTq = col('total qty');
    if (iA < 0 || iS < 0 || iSd < 0 || iQ < 0 || iAv < 0) {
      throw new Error('Not a positions file — headers must include Account, Stock, Side, Net Qty, Avg Price.');
    }
    const current = {};
    computePositions().forEach(l => {
      current[legKey(l.acc, l.stock, l.ind, l.tf)] = l.sumQty;
    });
    const now = new Date().toISOString();
    let imported = 0, skipped = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const acc = String(r[iA] || '').trim();
      const stock = String(r[iS] || '').trim().toUpperCase();
      const ind = iI >= 0 ? String(r[iI] || '').trim() : '';
      const tf = iT >= 0 ? String(r[iT] || '').trim() : '';
      let qty = Math.abs(Number(r[iQ]));
      const avg = Number(r[iAv]);
      if (!acc || !stock || !qty || isNaN(qty) || isNaN(avg)) { skipped++; continue; }
      if (String(r[iSd] || '').toUpperCase().indexOf('S') === 0) qty = -qty;
      const key = legKey(acc, stock, ind, tf);
      if (current[key]) { skipped++; continue; }
      const t = { acc, stock, ind, tf, qty, side: qty < 0 ? 'SELL' : 'BUY',
                  price: avg, time: now };
      const fp = await fingerprintOf(t);
      if (CACHE.trades.some(x => x.id === fp)) { skipped++; continue; }
      current[key] = qty;
      await createDocIfAbsent('trades', fp, { time: now, acc, stock, ind, tf, lot: '',
        side: t.side, qty, alertPx: avg, pos: null, srcId: 'import',
        executed: true, futAtSignal: null, tradePx: avg, execPl: null });
      imported++;
      if (iTq >= 0 && Number(r[iTq]) > 0) {
        try { await Server.saveTotalQty({ acc, stock, ind, tf, lot: '', val: Number(r[iTq]) }); }
        catch (e) {}
      }
    }
    return { imported, skipped };
  }
};

function parseCsv(text){
  const rows = []; let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x !== '')) rows.push(row);
  return rows;
}

/* ==================== Firestore plumbing ==================== */

let readyResolve, readyPromise = new Promise(r => readyResolve = r);
async function ensureReady(){ return readyPromise; }

async function setDoc(coll, id, data, merge){
  if (DEMO_MODE) return;
  await fs.setDoc(fs.doc(db, coll, id), data, { merge: !!merge });
}
async function deleteDoc(coll, id){
  if (DEMO_MODE) return;
  await fs.deleteDoc(fs.doc(db, coll, id));
}
async function deleteCollection(coll){
  if (DEMO_MODE) return 0;
  const snap = await fs.getDocs(fs.collection(db, coll));
  let batch = fs.writeBatch(db);
  let pending = 0, count = 0;
  for (const d of snap.docs) {
    batch.delete(d.ref);
    pending++; count++;
    if (pending === 450) {
      await batch.commit();
      batch = fs.writeBatch(db);
      pending = 0;
    }
  }
  if (pending) await batch.commit();
  return count;
}
async function createDocIfAbsent(coll, id, data){
  if (DEMO_MODE) { CACHE.trades.push(Object.assign({ id }, data)); return; }
  await fs.setDoc(fs.doc(db, coll, id), data, { merge: false });
}

export async function initData(){
  if (DEMO_MODE) { seedDemo(); CACHE.ready = true; readyResolve(); return; }

  const appMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
  const authMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
  fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');

  const app = appMod.initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);
  await authMod.signInAnonymously(auth);
  fbAuthed = true;
  db = fs.getFirestore(app);

  // seed users + master on first run
  const usersSnap = await fs.getDocs(fs.collection(db, 'users'));
  if (usersSnap.empty) {
    for (const u of CONFIG.DEFAULT_USERS) await setDoc('users', u.name, u, false);
  }
  const masterDoc = await fs.getDoc(fs.doc(db, 'config', 'master'));
  if (!masterDoc.exists()) await setDoc('config', 'master', CONFIG.DEFAULT_MASTER, false);
  const appDoc = await fs.getDoc(fs.doc(db, 'config', 'app'));
  if (!appDoc.exists()) await setDoc('config', 'app', { adminPin: '0000' }, false);

  // realtime listeners keep CACHE fresh and re-render the UI instantly
  fs.onSnapshot(fs.query(fs.collection(db, 'trades'), fs.orderBy('time', 'asc')), snap => {
    CACHE.trades = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
    markReady(); onDataChanged();
  });
  fs.onSnapshot(fs.collection(db, 'legSizes'), snap => {
    CACHE.legSizes = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
    onDataChanged();
  });
  fs.onSnapshot(fs.collection(db, 'funds'), snap => {
    CACHE.funds = {};
    snap.docs.forEach(d => CACHE.funds[d.id] = d.data());
    onDataChanged();
  });
  fs.onSnapshot(fs.collection(db, 'users'), snap => {
    CACHE.users = snap.docs.map(d => d.data());
  });
  fs.onSnapshot(fs.doc(db, 'config', 'master'), d => { if (d.exists()) CACHE.master = d.data(); });
  fs.onSnapshot(fs.doc(db, 'config', 'app'), d => { if (d.exists()) CACHE.config = d.data(); });
  fs.onSnapshot(fs.query(fs.collection(db, 'alertHistory'),
      fs.orderBy('time', 'desc'), fs.limit(50)), snap => {
    CACHE.history = snap.docs.map(d => d.data());
  });
}
let readyDone = false;
function markReady(){ if (!readyDone) { readyDone = true; CACHE.ready = true; readyResolve(); } }

/* ==================== DEMO fixtures (preview without Firebase) ==================== */
function seedDemo(){
  const T = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
  CACHE.users = CONFIG.DEFAULT_USERS;
  CACHE.master = CONFIG.DEFAULT_MASTER;
  CACHE.funds = { CBQ: { total: 20000000, usedOverride: 4500000 } };
  const mk = (id, h, m, acc, stock, ind, tf, qty, px, exec, tpx, fut) => ({
    id, time: T(h, m), acc, stock, ind, tf, lot: 675, side: qty < 0 ? 'SELL' : 'BUY',
    qty, alertPx: px, pos: null, srcId: 'wh', executed: exec,
    futAtSignal: fut == null ? null : fut, tradePx: tpx == null ? null : tpx,
    execPl: null });
  CACHE.trades = [
    mk('t1',  9, 36, 'CBQ', 'NIFTY', 'Para 0.02', '5S',  1350, 24010.2, true, 24011.0, 24010.5),
    mk('t2', 11, 23, 'CBQ', 'NIFTY', 'Para 0.02', '5S', -1350, 24090.4, true, 24089.2, 24091.0),
    mk('t3', 13, 58, 'VEC', 'NIFTY', 'Para 0.02', '5S',   675, 24050.0, true, 24051.5, 24049.8),
    mk('t4', 14, 42, 'CBQ', 'NIFTY', 'Para 0.02', '5S',  1350, 24155.3, false, null, 24156.1),
    mk('t5', 14, 42, 'DF',  'NIFTY', 'Para 0.02', '5S',   130, 24155.3, false, null, 24156.1)
  ];
  CACHE.legSizes = [{ id: 'x', acc: 'CBQ', stock: 'RELIANCE',
    ind: 'Para 0.01', tf: '11', totalQty: 500 }];
  // demo quote source
  quoteCache = { t: Date.now() + 1e9, key: '', data: {
    indices: [
      { name: 'NIFTY 50', price: 24216.75, chg: 9.85, chgPct: 0.04 },
      { name: 'BANKNIFTY', price: 57970.15, chg: -75.75, chgPct: -0.13 },
      { name: 'SENSEX', price: 77685.31, chg: 115.92, chgPct: 0.15 }
    ],
    spot: { NIFTY: { price: 24216.75, chg: 9.85 }, RELIANCE: { price: 1523.4, chg: -4.2 } },
    fut: { NIFTY: { price: 24231.1, prev: 24205.4, src: 'fut' },
           RELIANCE: { price: 1525.9, prev: 1528.3, src: 'fut' } }
  }};
  fetchQuotes = async () => quoteCache.data;
}

/* ==================== google.script.run shim ==================== */
/* app.js was written for Apps Script; this recreates its bridge 1:1. */
function makeRunner(){
  const build = (ok, fail) => new Proxy({}, {
    get(_, prop){
      if (prop === 'withSuccessHandler') return f => build(f, fail);
      if (prop === 'withFailureHandler') return f => build(ok, f);
      return (...args) => {
        Promise.resolve().then(() => Server[prop](...args))
          .then(res => { if (ok) ok(res); })
          .catch(err => { if (fail) fail({ message: err && err.message ? err.message : String(err) });
                          else console.error('[SDT]', prop, err); });
      };
    }
  });
  return build(null, null);
}
window.google = { script: { run: makeRunner() } };

// realtime: any Firestore change re-renders through the app's own load()
setOnDataChanged(() => { try { if (window.load) window.load(false); } catch (e) {} });

initData().catch(e => {
  const el = document.getElementById('gateUsers');
  if (el) el.innerHTML = '<div class="hint"><b>Firebase init failed:</b> ' +
    (e && e.message ? e.message : e) +
    '<br>Check js/firebase-config.js values, or set DEMO_MODE=true to preview.</div>';
});
