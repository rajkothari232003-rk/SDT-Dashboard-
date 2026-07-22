
let DATA = { indices:[], accounts:[], legs:[], notifications:[], updated:null };
let CREATOR = { master: {accounts:[],indicators:[],timeframes:[],stocks:[]}, history: [] };
let MASTER_EDIT = null;
let GENERATED = [];
let creatorLoaded = false;
let VIEW = 'detail';                 // positions view: 'detail' | 'cond'
const COLLAPSED = new Set();         // collapsed account groups
function setView(v){
  VIEW = v;
  document.getElementById('vDetail').classList.toggle('on', v==='detail');
  document.getElementById('vCond').classList.toggle('on', v==='cond');
  render();
}
function toggleAcc(a){
  if (COLLAPSED.has(a)) COLLAPSED.delete(a); else COLLAPSED.add(a);
  render();
}

/* ---------- helpers ---------- */
function cls(v){ return v > 0 ? 'up' : (v < 0 ? 'down' : 'flat'); }
function isToday(iso){
  const d = new Date(iso), n = new Date();
  return !isNaN(d.getTime()) && d.getFullYear() === n.getFullYear() &&
         d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}
function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmt(v, dec){
  const n = Number(v);
  if (v == null || v === '' || isNaN(n)) return '—';
  return n.toLocaleString('en-IN', {minimumFractionDigits: dec ?? 0, maximumFractionDigits: dec ?? 2});
}
function money(v){
  const n = Number(v);
  if (v == null || isNaN(n)) return '—';
  const a = Math.abs(n), sign = n < 0 ? '−' : '';
  if (a >= 1e7) return sign + '₹' + (a/1e7).toLocaleString('en-IN',{maximumFractionDigits:2}) + ' Cr';
  if (a >= 1e5) return sign + '₹' + (a/1e5).toLocaleString('en-IN',{maximumFractionDigits:2}) + ' L';
  return sign + '₹' + a.toLocaleString('en-IN',{maximumFractionDigits:0});
}
function tfmt(iso){
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return esc(iso);
  return d.toLocaleDateString('en-IN',{day:'2-digit',month:'short'}) + ' ' +
         d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});
}
function showErr(msg){
  const el = document.getElementById('err');
  el.textContent = msg; el.style.display = 'block';
  window.scrollTo({top:0});
}
function clearErr(){ document.getElementById('err').style.display = 'none'; }
function togglePanel(open){
  document.getElementById('panel').classList.toggle('open', open);
  document.getElementById('overlay').classList.toggle('show', open);
}
function copyText(text, btn){
  const done = () => {
    const old = btn.textContent; btn.textContent = 'Copied ✓';
    setTimeout(() => btn.textContent = old, 1400);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done){
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch(e) {}
  document.body.removeChild(ta);
}

/* ---------- tabs ---------- */
const TABS = { dash:'Dash', pl:'Pl', create:'Create', exec:'Exec', alerts:'Alerts', manual:'Manual', download:'Download', settings:'Settings' };
function showTab(which){
  Object.keys(TABS).forEach(k => {
    document.getElementById('view' + TABS[k]).hidden = (k !== which);
    document.getElementById('tab'  + TABS[k]).classList.toggle('active', k === which);
  });
  if (which === 'create' && !creatorLoaded) loadCreator();
  if (which === 'exec') loadExec();
  if (which === 'alerts') renderAlerts();
  if (which === 'manual') loadManual();
  if (which === 'pl') renderPnl();
  if (which === 'download' && !document.getElementById('dlFrom').value) {
    const t = new Date(), p = v => String(v).padStart(2, '0');
    document.getElementById('dlFrom').value = t.getFullYear() + '-' + p(t.getMonth()+1) + '-' + p(t.getDate());
  }
  if (which === 'settings') loadSettings();
}

/* ---------- dashboard ---------- */
function load(manual){
  const btn = document.getElementById('refreshBtn');
  if (manual){ btn.disabled = true; btn.textContent = 'Refreshing…'; }
  google.script.run
    .withSuccessHandler(d => {
      DATA = d;
      DATA.legs.forEach((l, i) => l._i = i);
      clearErr();
      buildFilters(); render();
      const ts = new Date(d.updated);
      document.getElementById('updated').textContent =
        'Last refresh ' + ts.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      document.getElementById('expStamp').textContent =
        'SDT Dashboard · ' + ts.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) +
        ' ' + ts.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});
      btn.disabled = false; btn.textContent = 'Refresh';
    })
    .withFailureHandler(e => {
      showErr('Could not load data: ' + (e && e.message ? e.message : e) + '. Will retry automatically.');
      btn.disabled = false; btn.textContent = 'Refresh';
    })
    .getDashboardData();
}

function buildFilters(){
  const accSel = document.getElementById('fAcc');
  const stkSel = document.getElementById('fStock');
  const keepA = accSel.value, keepS = stkSel.value;
  const accs = [...new Set(DATA.legs.map(l => l.acc))].sort();
  const stks = [...new Set(DATA.legs.map(l => l.stock))].sort();
  accSel.innerHTML = '<option value="">All accounts</option>' +
    accs.map(a => `<option ${a===keepA?'selected':''} value="${esc(a)}">${esc(a)}</option>`).join('');
  stkSel.innerHTML = '<option value="">All stocks</option>' +
    stks.map(s => `<option ${s===keepS?'selected':''} value="${esc(s)}">${esc(s)}</option>`).join('');
}

function render(){
  document.getElementById('indices').innerHTML = DATA.indices.map(ix => {
    const c = ix.chg == null ? 'flat' : cls(ix.chg);
    const arrow = ix.chg == null ? '' : (ix.chg > 0 ? '▲ ' : (ix.chg < 0 ? '▼ ' : ''));
    const ch = ix.chg == null ? '' :
      `<span class="ch num ${c}">${arrow}<span class="abs">${fmt(Math.abs(ix.chg),2)} </span><span class="pct">(${fmt(Math.abs(ix.chgPct),2)}%)</span></span>`;
    return `<div class="idx"><div class="nm">${esc(ix.name)}</div>
      <div><span class="px num">${ix.price==null?'—':fmt(ix.price,2)}</span>${ch}</div></div>`;
  }).join('');

  const fa = document.getElementById('fAcc').value;
  const fs = document.getElementById('fStock').value;

  const accs = DATA.accounts.filter(a => !fa || a.acc === fa);

  // per-account day-wise P&L (sum of the P&L tab's rows)
  const accDay = {};
  ((DATA.pnl && DATA.pnl.rows) || []).forEach(r => {
    if (!(r.acc in accDay)) accDay[r.acc] = 0;
    if (r.dayPnl == null) accDay[r.acc] = null;
    else if (accDay[r.acc] != null) accDay[r.acc] += r.dayPnl;
  });

  // funds display in Cr format; click to edit
  const fundCell = (a, field) => {
    const val = field === 'total' ? a.totalFund : a.usedFund;
    const ov = field === 'used' && a.usedManual;
    const title = field === 'total' ? 'Total fund — click to edit'
      : (a.usedManual ? 'Used fund (manual) — click to edit' : 'Used fund (default 30% of exposure) — click to edit');
    return `<span class="editmoney num ${ov?'ov':''}" title="${title}"
      onclick="editFund(this,'${esc(a.acc)}','${field}')">${val==null?'set…':money(val)}</span>`;
  };
  document.getElementById('expBody').innerHTML = accs.length
    ? accs.map(a => `
      <tr>
        <td><b>${esc(a.acc)}</b>${a.missing ? ' <span title="legs missing a market rate" style="color:#b07b00">⚠${a.missing}</span>' : ''}</td>
        <td class="r">${fundCell(a,'total')}</td>
        <td class="r">${fundCell(a,'used')}</td>
        <td class="r num ${a.netAvail==null?'':cls(a.netAvail)}"><b>${a.netAvail==null?'—':money(a.netAvail)}</b></td>
        <td class="r num ${cls(a.net)}"><b>${a.net>0?'+':''}${money(a.net)}</b></td>
        <td class="r num"><b>${money(a.gross)}</b></td>
        <td class="r num ${cls(a.net)}">${fmt(a.pct,1)}%</td>
        <td class="r num ${accDay[a.acc]==null?'':cls(accDay[a.acc])}"><b>${accDay[a.acc]==null?'—':(accDay[a.acc]>0?'+':'')+money(accDay[a.acc])}</b></td>
      </tr>`).join('')
    : '<tr><td colspan="8" class="empty">No positions yet. Fire a TradingView alert to begin.</td></tr>';

  document.getElementById('expCards').innerHTML = accs.length
    ? accs.map(a => `
      <div class="mcard">
        <div class="mc1"><span class="grow"><b>${esc(a.acc)}</b></span>
          <span class="num ${accDay[a.acc]==null?'':cls(accDay[a.acc])}"><b>Day ${accDay[a.acc]==null?'—':(accDay[a.acc]>0?'+':'')+money(accDay[a.acc])}</b></span></div>
        <div class="mc3"><span class="num"><span class="lbl">Total Fund</span> ${fundCell(a,'total')}</span>
          <span class="num"><span class="lbl">Used</span> ${fundCell(a,'used')}</span></div>
        <div class="mc3"><span class="num"><span class="lbl">Available</span>
            <b class="${a.netAvail==null?'':cls(a.netAvail)}">${a.netAvail==null?'set Total Fund':money(a.netAvail)}</b></span>
          <span class="num"><span class="lbl">Net</span>
            <b class="${cls(a.net)}">${a.net>0?'+':''}${money(a.net)}</b></span></div>
        <div class="mc2 num">Total Exposure <b>${money(a.gross)}</b> · Net/Total ${fmt(a.pct,1)}%</div>
      </div>`).join('')
    : '<div class="mcard"><div class="mc2">No positions yet.</div></div>';

  renderPnl();
  renderGrid();

  const fside = document.getElementById('fSide').value;
  let legs = DATA.legs.filter(l => (!fa || l.acc===fa) && (!fs || l.stock===fs) &&
    (!fside || (fside==='buy' ? l.qty > 0 : l.qty < 0)));

  // Condensed view: totals across all indicators & timeframes per Account × Stock
  if (VIEW === 'cond') {
    const g = {};
    legs.forEach(l => {
      const k = l.acc + '||' + l.stock;
      if (!g[k]) g[k] = { acc:l.acc, stock:l.stock, inds:new Set(), tfs:new Set(),
                          qty:0, totalQty:0, rate:l.rate, exposure:0, expNull:true };
      const x = g[k];
      x.inds.add(l.ind); x.tfs.add(l.tf);
      x.qty += l.qty; x.totalQty += l.totalQty || 0;
      if (l.rate != null) x.rate = l.rate;
      if (l.exposure != null) { x.exposure += l.exposure; x.expNull = false; }
    });
    legs = Object.values(g).map(x => ({
      acc:x.acc, stock:x.stock,
      ind:x.inds.size + ' ind', tf:x.tfs.size + ' TF',
      qty:x.qty, totalQty:x.totalQty, rate:x.rate,
      exposure:x.expNull ? null : x.exposure
    }));
  }

  // group by account with collapsible header rows
  const byAcc = {};
  legs.forEach(l => { (byAcc[l.acc] ||= []).push(l); });
  const accNames = Object.keys(byAcc).sort();

  let html = '', sr = 0;
  accNames.forEach(a => {
    const rows = byAcc[a];
    const net = rows.reduce((s,l)=>s+l.qty,0);
    const exp = rows.some(l=>l.exposure!=null) ? rows.reduce((s,l)=>s+(l.exposure||0),0) : null;
    const closed = COLLAPSED.has(a);
    html += `
      <tr class="acc-row" onclick="toggleAcc('${esc(a)}')">
        <td colspan="5"><span class="car">${closed?'▸':'▾'}</span>${esc(a)}
          <span class="dim" style="font-weight:500">· ${rows.length} row${rows.length===1?'':'s'}</span></td>
        <td class="r num dim">${fmt(rows.reduce((s,l)=>s+(l.totalQty||0),0),0)}</td>
        <td class="r num ${cls(net)}">${net>0?'+':''}${fmt(net,0)}</td>
        <td></td>
        <td class="r num ${cls(exp ?? 0)}"><b>${exp==null?'—':money(exp)}</b></td>
      </tr>`;
    if (!closed) rows.forEach(l => {
      sr++;
      html += `
      <tr>
        <td class="dim num">${sr}</td>
        <td class="dim">${esc(l.acc)}</td>
        <td>${esc(l.stock)}</td>
        <td class="dim">${esc(l.ind)}</td>
        <td class="r dim num">${esc(l.tf)}</td>
        <td class="r">${VIEW==='cond' || l._i==null
          ? '<span class="dim num">'+fmt(l.totalQty,0)+'</span>'
          : `<input type="number" min="0" step="1" class="num" title="One-side size — edit to override"
               style="width:84px;text-align:right;padding:4px 7px;${l.manualSize?'border-color:var(--blue);':''}"
               value="${l.totalQty??''}" onclick="event.stopPropagation()"
               onchange="saveTQ(${l._i}, this)">`}</td>
        <td class="r"><span class="pill num ${cls(l.qty)}"><span class="${cls(l.qty)}">${l.qty>0?'+':''}${fmt(l.qty,0)}</span></span></td>
        <td class="r dim num">${l.rate==null?'—':fmt(l.rate,2)}</td>
        <td class="r num ${cls(l.exposure ?? 0)}"><b>${l.exposure==null?'—':money(l.exposure)}</b></td>
      </tr>`;
    });
  });
  document.getElementById('legsBody').innerHTML = html ||
    '<tr><td colspan="9" class="empty">No trades yet. Fire a TradingView alert to see it here.</td></tr>';

  // mobile cards mirror the same grouping
  let mob = '';
  accNames.forEach(a => {
    const rows = byAcc[a];
    const net = rows.reduce((s,l)=>s+l.qty,0);
    const closed = COLLAPSED.has(a);
    mob += `
      <div class="mcard" onclick="toggleAcc('${esc(a)}')" style="background:#eef2f8;cursor:pointer">
        <div class="mc1"><span class="car">${closed?'▸':'▾'}</span>
          <span class="grow"><b>${esc(a)}</b> <span class="dim">· ${rows.length} row${rows.length===1?'':'s'}</span></span>
          <span class="num ${cls(net)}"><b>${net>0?'+':''}${fmt(net,0)}</b></span></div>
      </div>`;
    if (!closed) rows.forEach(l => {
      mob += `
      <div class="mcard">
        <div class="mc1"><span class="grow">${esc(l.stock)}</span>
          <span class="pill num ${cls(l.qty)}"><span class="${cls(l.qty)}">${l.qty>0?'+':''}${fmt(l.qty,0)}</span></span></div>
        <div class="mc2">${esc(l.ind)} · TF ${esc(l.tf)} · <span class="num">Total Qty
          ${VIEW==='cond' || l._i==null ? fmt(l.totalQty,0)
            : `<input type="number" min="0" step="1" class="num"
                 style="width:76px;text-align:right;padding:3px 6px;${l.manualSize?'border-color:var(--blue);':''}"
                 value="${l.totalQty??''}" onclick="event.stopPropagation()"
                 onchange="saveTQ(${l._i}, this)">`}</span></div>
        <div class="mc3"><span class="num"><span class="lbl">LTP</span> <b>${l.rate==null?'—':fmt(l.rate,2)}</b></span>
          <span class="num"><span class="lbl">Exposure</span> <b class="${cls(l.exposure ?? 0)}">${l.exposure==null?'—':money(l.exposure)}</b></span></div>
      </div>`;
    });
  });
  document.getElementById('legsCards').innerHTML = mob ||
    '<div class="mcard"><div class="mc2">No trades yet. Fire a TradingView alert to see it here.</div></div>';

  const pendingNotes = DATA.notifications.filter(n => !n.executed && isToday(n.time)
    && visibleToUser(n.acc));

  // operator mode: pending alerts take over the main dashboard area
  const isOp = CURRENT_USER && CURRENT_USER.role !== 'admin';
  document.getElementById('opPendingWrap').hidden = !isOp;
  if (isOp) {
    document.getElementById('opPending').innerHTML = pendingNotes.length
      ? pendingNotes.map(n => `
        <div class="mcard">
          <div class="mc1"><span class="grow"><b>${esc(n.acc)}</b> · ${esc(n.stock)}</span>
            <span style="font-size:11px;color:var(--soft)">${tfmt(n.time)}</span></div>
          <div class="mc2 num"><b class="${n.qty<0?'down':'up'}">${n.qty<0?'SELL':'BUY'}</b>
            ${fmt(Math.abs(n.qty),0)}${n.price!=='' && n.price!=null ? ' @ ' + fmt(n.price,2) : ''}
            · ${esc(n.ind)}${n.ind && n.tf ? ' · ' : ''}${n.tf ? 'TF ' + esc(n.tf) : ''}</div>
          <div class="nprice num"><span class="lbl">Trade Px</span>
            <input type="number" step="0.05" min="0" placeholder="fill price"
              value="${n.tradePrice==null?'':n.tradePrice}"
              onchange="savePrice('${n.row}', this)" aria-label="Actual trade price"></div>
        </div>`).join('')
      : '<div class="mcard"><div class="mc2">No pending alerts for your accounts — all caught up ✓</div></div>';
  }
  const pending = pendingNotes.length;
  const pc = document.getElementById('pendCount');
  pc.textContent = pending + ' pending';
  pc.classList.toggle('zero', pending === 0);
  const badge = document.getElementById('bellBadge');
  badge.style.display = pending ? 'flex' : 'none';
  badge.textContent = pending;

  // entering the actual trade price marks the alert executed and removes
  // it from this panel; the price flows to Execution Loss and Alerts tabs
  document.getElementById('nlist').innerHTML = pendingNotes.length
    ? pendingNotes.map(n => `
      <div class="nitem" id="n${n.row}">
        <div class="nbody">
          <div class="nl1"><span>${esc(n.acc)} · ${esc(n.stock)}</span>
            <span class="t">${tfmt(n.time)}</span></div>
          <div class="nl2 num">
            <span class="${n.qty<0?'down':'up'}"><b>${n.qty<0?'SELL':'BUY'}</b></span>
            ${fmt(Math.abs(n.qty),0)}${n.price!=='' && n.price!=null ? ' @ ' + fmt(n.price,2) : ''}
          </div>
          <div class="nl3">${esc(n.ind)}${n.ind && n.tf ? ' · ' : ''}${n.tf ? 'TF ' + esc(n.tf) : ''}</div>
          <div class="nprice num"><span class="lbl">Trade Px</span>
            <input type="number" step="0.05" min="0" placeholder="fill price"
              value="${n.tradePrice==null?'':n.tradePrice}"
              onchange="savePrice('${n.row}', this)" aria-label="Actual trade price"></div>
        </div>
      </div>`).join('')
    : '<div class="empty">No pending alerts — enter a trade price to clear an alert. History is on the Alerts tab.</div>';

  if (!document.getElementById('viewAlerts').hidden) renderAlerts();
}

/* ---------- alerts history tab (last 7 days) ---------- */
function syncAlertFilter(id, values, label){
  const el = document.getElementById(id);
  if (!el) return;
  const current = el.value;
  el.innerHTML = `<option value="">${label}</option>` +
    values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  if (current && values.includes(current)) el.value = current;
}
function clearAlertFilters(){
  ['alAcc','alStock','alInd','alTf','alStatus'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  renderAlerts();
}
function renderAlerts(){
  const baseNotes = DATA.notifications.filter(n => isToday(n.time) && visibleToUser(n.acc));
  const uniq = key => [...new Set(baseNotes.map(n => String(n[key] || '')).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  syncAlertFilter('alAcc', uniq('acc'), 'All accounts');
  syncAlertFilter('alStock', uniq('stock'), 'All stocks');
  syncAlertFilter('alInd', uniq('ind'), 'All indicators');
  syncAlertFilter('alTf', uniq('tf'), 'All timeframes');
  const fAcc = document.getElementById('alAcc')?.value || '';
  const fStock = document.getElementById('alStock')?.value || '';
  const fInd = document.getElementById('alInd')?.value || '';
  const fTf = document.getElementById('alTf')?.value || '';
  const fStatus = document.getElementById('alStatus')?.value || '';
  const notes = baseNotes.filter(n =>
    (!fAcc || n.acc === fAcc) &&
    (!fStock || n.stock === fStock) &&
    (!fInd || String(n.ind || '') === fInd) &&
    (!fTf || String(n.tf || '') === fTf) &&
    (!fStatus || (fStatus === 'executed' ? n.executed : !n.executed)));
  const canManage = CURRENT_USER && CURRENT_USER.role === 'admin';
  document.getElementById('alertsBody').innerHTML = notes.length
    ? notes.map(n => `
      <tr style="${n.executed ? 'opacity:.6' : ''}">
        <td class="dim">${tfmt(n.time)}</td>
        <td><b>${esc(n.acc)}</b></td>
        <td>${esc(n.stock)}</td>
        <td class="dim">${esc(n.ind)}</td>
        <td class="r dim num">${esc(n.tf)}</td>
        <td class="${n.qty<0?'down':'up'}"><b>${n.qty<0?'SELL':'BUY'}</b></td>
        <td class="r num">${fmt(Math.abs(n.qty),0)}</td>
        <td class="r dim num">${n.price!=='' && n.price!=null ? fmt(n.price,2) : '—'}</td>
        <td class="r"><input type="number" step="0.05" min="0" class="num" placeholder="—"
          style="width:92px;text-align:right;padding:5px 8px"
          value="${n.tradePrice==null?'':n.tradePrice}"
          onchange="savePrice('${n.row}', this)" aria-label="Actual trade price"></td>
        ${canManage ? `<td class="r">
          <button class="btn sm" onclick="openTradeEdit('${n.row}')">Edit</button>
          <button class="btn sm" onclick="deleteTradeRow('${n.row}', this)">Delete</button>
        </td>` : '<td></td>'}
      </tr>`).join('')
    : '<tr><td colspan="10" class="empty">No alerts today.</td></tr>';

  document.getElementById('alertsCards').innerHTML = notes.length
    ? notes.map(n => `
      <div class="mcard" style="${n.executed ? 'opacity:.6' : ''}">
        <div class="mc1">
          <span class="grow"><b>${esc(n.acc)}</b> · ${esc(n.stock)}</span>
          <span style="font-size:11px;color:var(--soft);font-weight:500">${tfmt(n.time)}</span></div>
        <div class="mc2 num"><b class="${n.qty<0?'down':'up'}">${n.qty<0?'SELL':'BUY'}</b>
          ${fmt(Math.abs(n.qty),0)}${n.price!=='' && n.price!=null ? ' @ ' + fmt(n.price,2) : ''}
          · ${esc(n.ind)}${n.ind && n.tf ? ' · ' : ''}${n.tf ? 'TF ' + esc(n.tf) : ''}</div>
        <div class="mc3"><span class="num"><span class="lbl">Trade Px</span>
          <input type="number" step="0.05" min="0" class="num" placeholder="fill price"
            style="width:96px;text-align:right;padding:5px 8px"
            value="${n.tradePrice==null?'':n.tradePrice}"
            onchange="savePrice('${n.row}', this)" aria-label="Actual trade price"></span>
          <span>${n.executed?'<b class="up">✓ Executed</b>':'<b class="down">Pending</b>'}</span></div>
      </div>`).join('')
    : '<div class="mcard"><div class="mc2">No alerts today.</div></div>';
}

function dtLocal(iso){
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function openTradeEdit(row){
  const n = DATA.notifications.find(x => x.row === row);
  if (!n) { showErr('Trade not found.'); return; }
  document.getElementById('teId').value = row;
  document.getElementById('teAcc').value = n.acc || '';
  document.getElementById('teStock').value = n.stock || '';
  document.getElementById('teInd').value = n.ind || '';
  document.getElementById('teTf').value = n.tf || '';
  document.getElementById('teSide').value = n.qty < 0 ? 'SELL' : 'BUY';
  document.getElementById('teQty').value = Math.abs(Number(n.qty) || 0);
  document.getElementById('teAlertPx').value = n.price == null || n.price === '' ? '' : n.price;
  document.getElementById('teTradePx').value = n.tradePrice == null ? '' : n.tradePrice;
  document.getElementById('teTime').value = dtLocal(n.time);
  document.getElementById('tradeEditModal').hidden = false;
}
function closeTradeEdit(){
  document.getElementById('tradeEditModal').hidden = true;
}
function saveTradeEdit(btn){
  clearErr();
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'Saving...';
  const payload = {
    acc: document.getElementById('teAcc').value,
    stock: document.getElementById('teStock').value,
    ind: document.getElementById('teInd').value,
    tf: document.getElementById('teTf').value,
    side: document.getElementById('teSide').value,
    qty: document.getElementById('teQty').value,
    alertPx: document.getElementById('teAlertPx').value,
    tradePx: document.getElementById('teTradePx').value,
    time: document.getElementById('teTime').value
  };
  google.script.run
    .withSuccessHandler(() => {
      btn.disabled = false;
      btn.textContent = old;
      closeTradeEdit();
      render();
      if (!document.getElementById('viewExec').hidden) loadExec();
    })
    .withFailureHandler(e => {
      btn.disabled = false;
      btn.textContent = old;
      showErr('Could not save trade: ' + (e && e.message ? e.message : e));
    })
    .updateTrade(ADMIN_PIN_CACHE, document.getElementById('teId').value, payload);
}
function deleteTradeRow(row, btn){
  clearErr();
  if (!confirm('Delete this trade? Dashboard positions will recalculate immediately.')) return;
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'Deleting...';
  google.script.run
    .withSuccessHandler(() => {
      btn.disabled = false;
      btn.textContent = old;
      render();
      if (!document.getElementById('viewExec').hidden) loadExec();
    })
    .withFailureHandler(e => {
      btn.disabled = false;
      btn.textContent = old;
      showErr('Could not delete trade: ' + (e && e.message ? e.message : e));
    })
    .deleteTrade(ADMIN_PIN_CACHE, row);
}

/**
 * One entry point for the actual trade price — used by the Notifications
 * panel, the Alerts tab and the Execution Loss tab. Entering a price marks
 * the alert executed (it leaves the pending panel); clearing returns it.
 */
function savePrice(row, input){
  const val = input.value === '' ? '' : Number(input.value);
  input.disabled = true;
  google.script.run
    .withSuccessHandler(res => {
      const n = DATA.notifications.find(x => x.row === res.row);
      if (n) { n.tradePrice = res.manual; n.executed = res.executed; }
      if (EXEC.rows) {
        const er = EXEC.rows.find(x => x.row === res.row);
        if (er) { er.manual = res.manual; er.loss = res.loss; }
      }
      render();
      if (!document.getElementById('viewExec').hidden) renderExec();
    })
    .withFailureHandler(e => {
      input.disabled = false;
      showErr('Could not save price: ' + (e && e.message ? e.message : e));
    })
    .saveManualPrice(row, val);
}

/* ---------- creator tab ---------- */
function loadCreator(){
  google.script.run
    .withSuccessHandler(d => {
      CREATOR = d;
      MASTER_EDIT = JSON.parse(JSON.stringify(d.master));
      creatorLoaded = true;
      renderCreatorForm(); renderMaster(); renderHistory();
    })
    .withFailureHandler(e => showErr('Could not load creator data: ' + (e && e.message ? e.message : e)))
    .getCreatorData();
}

function fillSelect(id, values, keep){
  const sel = document.getElementById(id);
  const prev = keep ? sel.value : '';
  sel.innerHTML = values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  if (prev && values.includes(prev)) sel.value = prev;
}

function renderCreatorForm(){
  const m = CREATOR.master;
  fillSelect('cAcc', m.accounts, true);
  fillSelect('cInd', m.indicators, true);
  fillSelect('cTf',  m.timeframes, true);
  fillSelect('cStock', m.stocks.map(s => s.stock), true);
  stockChanged();
  modeChanged();
}

function stockChanged(){
  const stock = document.getElementById('cStock').value;
  const rec = CREATOR.master.stocks.find(s => s.stock === stock);
  document.getElementById('cLot').value = rec && rec.lot ? rec.lot : '';
  lotsChanged();
}
function lotsChanged(){
  const lot = Number(document.getElementById('cLot').value) || 0;
  const lots = Number(document.getElementById('cLots').value) || 1;
  if (lot) document.getElementById('cQty').value = lot * lots;
}
function modeChanged(){
  const strat = document.getElementById('cMode').value === 'STRATEGY';
  const multi = document.getElementById('cMulti').checked;
  document.getElementById('cQty').disabled = strat || multi;
  document.getElementById('cLots').disabled = strat || multi;
}
function multiChanged(){
  const on = document.getElementById('cMulti').checked;
  document.getElementById('cAcc').disabled = on;
  const box = document.getElementById('multiQtys');
  box.hidden = !on;
  if (on) {
    const lot = Number(document.getElementById('cLot').value) || 0;
    box.innerHTML = '<span class="hint" style="width:100%">Qty per account (one SDT line each — all logged from a single email):</span>' +
      CREATOR.master.accounts.map((a,i) => `
        <span class="num" style="display:inline-flex;align-items:center;gap:6px">
          <b style="font-size:12.5px">${esc(a)}</b>
          <input type="number" min="0" step="1" class="mq num" data-acc="${esc(a)}"
            value="${lot || ''}" style="width:90px;text-align:right;padding:6px 8px"></span>`).join('');
  } else box.innerHTML = '';
  modeChanged();
}

function generate(){
  clearErr();
  const btn = document.getElementById('genBtn');
  btn.disabled = true; btn.textContent = 'Generating…';
  const multiOn = document.getElementById('cMulti').checked;
  const accountsMulti = multiOn
    ? [...document.querySelectorAll('#multiQtys .mq')]
        .map(i => ({ acc: i.dataset.acc, qty: i.value }))
        .filter(x => Number(x.qty) > 0)
    : null;
  if (multiOn && (!accountsMulti || !accountsMulti.length)) {
    showErr('Enter a Qty for at least one account.');
    btn.disabled = false; btn.textContent = 'Generate alert code';
    return;
  }
  const payload = {
    accountsMulti: accountsMulti,
    acc:   document.getElementById('cAcc').value,
    stock: document.getElementById('cStock').value,
    ind:   document.getElementById('cInd').value,
    tf:    document.getElementById('cTf').value,
    lot:   document.getElementById('cLot').value,
    qty:   document.getElementById('cQty').value,
    mode:  document.getElementById('cMode').value,
    usePlaceholders: document.getElementById('cPh').checked
  };
  google.script.run
    .withSuccessHandler(results => {
      GENERATED = results;
      renderGenerated();
      btn.disabled = false; btn.textContent = 'Generate alert code';
      loadCreatorHistoryOnly();
    })
    .withFailureHandler(e => {
      showErr((e && e.message ? e.message : e));
      btn.disabled = false; btn.textContent = 'Generate alert code';
    })
    .createAlert(payload);
}

function renderGenerated(){
  document.getElementById('genOut').innerHTML = GENERATED.map((g, i) => `
    <div class="code">
      <div class="chead">
        <span class="cname" title="${esc(g.name)}">${esc(g.name)}</span>
        <button class="btn sm" onclick="copyText(GENERATED[${i}].name, this)">Copy name</button>
        <button class="btn sm primary" onclick="copyText(GENERATED[${i}].message, this)">Copy message</button>
      </div>
      <pre>${esc(g.message)}</pre>
    </div>`).join('');
}

function loadCreatorHistoryOnly(){
  google.script.run
    .withSuccessHandler(d => { CREATOR.history = d.history; renderHistory(); })
    .getCreatorData();
}

function renderHistory(){
  const h = CREATOR.history.filter(r => isToday(r.time));
  document.getElementById('histBody').innerHTML = h.length
    ? h.map((r, i) => `
      <tr>
        <td class="dim">${tfmt(r.time)}</td>
        <td><b>${esc(r.acc)}</b></td>
        <td>${esc(r.stock)}</td>
        <td class="dim">${esc(r.ind)}</td>
        <td class="r dim num">${esc(r.tf)}</td>
        <td class="dim">${esc(r.mode)}</td>
        <td class="r num">${esc(r.qty)}</td>
        <td class="dim" style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(r.name)}</td>
        <td><button class="btn sm" onclick="copyText(CREATOR.history[${i}].message, this)">Copy</button></td>
      </tr>`).join('')
    : '<tr><td colspan="9" class="empty">Nothing generated yet — create your first alert above.</td></tr>';

  document.getElementById('histCards').innerHTML = h.length
    ? h.map((r, i) => `
      <div class="mcard">
        <div class="mc1"><span class="grow">${esc(r.name)}</span>
          <button class="btn sm" onclick="copyText(CREATOR.history[${i}].message, this)">Copy</button></div>
        <div class="mc2">${tfmt(r.time)} · <b>${esc(r.acc)}</b> · ${esc(r.stock)} · ${esc(r.ind)} · TF ${esc(r.tf)} · ${esc(r.mode)} · Qty ${esc(r.qty)}</div>
      </div>`).join('')
    : '<div class="mcard"><div class="mc2">Nothing generated yet — create your first alert above.</div></div>';
}

/* ---------- master editor ---------- */
function renderMaster(){
  const m = MASTER_EDIT;
  const listCol = (title, key) => `
    <div class="mcol">
      <h3>${title}</h3>
      <div class="mlist">
        ${m[key].map((v, i) => `
          <div class="mitem"><span>${esc(v)}</span>
            <button class="x" onclick="mRemove('${key}',${i})" aria-label="Remove">✕</button></div>`).join('')}
      </div>
      <div class="madd">
        <input type="text" id="madd_${key}" placeholder="Add…">
        <button class="btn sm" onclick="mAdd('${key}')">Add</button>
      </div>
    </div>`;

  const stockCol = `
    <div class="mcol">
      <h3>Stocks &amp; lot sizes</h3>
      <div class="mlist">
        ${m.stocks.map((s, i) => `
          <div class="mitem"><span>${esc(s.stock)} <span style="color:var(--soft)">· lot ${esc(s.lot)}</span></span>
            <button class="x" onclick="mRemove('stocks',${i})" aria-label="Remove">✕</button></div>`).join('')}
      </div>
      <div class="madd">
        <input type="text" id="madd_stock" placeholder="Stock…" style="flex:1.4">
        <input type="number" id="madd_lot" placeholder="Lot" style="width:70px">
        <button class="btn sm" onclick="mAddStock()">Add</button>
      </div>
    </div>`;

  document.getElementById('mgrid').innerHTML =
    listCol('Accounts', 'accounts') +
    stockCol +
    listCol('Indicators', 'indicators') +
    listCol('Timeframes', 'timeframes');
}

function mAdd(key){
  const inp = document.getElementById('madd_' + key);
  const v = inp.value.replace(/\|/g,'').trim();
  if (!v) return;
  if (!MASTER_EDIT[key].includes(v)) MASTER_EDIT[key].push(v);
  inp.value = '';
  renderMaster();
}
function mAddStock(){
  const sInp = document.getElementById('madd_stock');
  const lInp = document.getElementById('madd_lot');
  const stock = sInp.value.replace(/\|/g,'').trim().toUpperCase();
  const lot = Number(lInp.value) || '';
  if (!stock) return;
  const ex = MASTER_EDIT.stocks.find(x => x.stock === stock);
  if (ex) ex.lot = lot; else MASTER_EDIT.stocks.push({stock, lot});
  sInp.value = ''; lInp.value = '';
  renderMaster();
}
function mRemove(key, i){
  MASTER_EDIT[key].splice(i, 1);
  renderMaster();
}
function persistMaster(){
  clearErr();
  google.script.run
    .withSuccessHandler(saved => {
      CREATOR.master = saved;
      MASTER_EDIT = JSON.parse(JSON.stringify(saved));
      renderCreatorForm(); renderMaster();
      const tag = document.getElementById('msaved');
      tag.hidden = false; setTimeout(() => tag.hidden = true, 1800);
    })
    .withFailureHandler(e => showErr('Could not save master: ' + (e && e.message ? e.message : e)))
    .saveMaster(MASTER_EDIT);
}

/* ---------- execution loss tab ---------- */
let EXEC = { rows: [], kite: {} };

function loadExec(){
  google.script.run
    .withSuccessHandler(d => { EXEC = d; renderExec(); })
    .withFailureHandler(e => showErr('Could not load execution data: ' + (e && e.message ? e.message : e)))
    .getExecLossData();
}

function renderExec(){
  const k = EXEC.kite || {};
  const st = document.getElementById('execKite');
  if (k.connected) {
    st.innerHTML = '<b style="color:var(--up)">● Zerodha connected</b> (today)';
  } else if (k.configured) {
    st.innerHTML = '<b style="color:var(--down)">● Not active today</b> — activate in Settings before Run';
  } else {
    st.innerHTML = '<b style="color:var(--down)">● Not configured</b> — add API keys in Settings';
  }
  document.getElementById('runBtn').disabled = !k.connected;

  const rows = EXEC.rows.filter(r => isToday(r.time));
  let wNum = 0, wDen = 0, counted = 0;   // value-weighted average slippage %
  document.getElementById('execBody').innerHTML = rows.length
    ? rows.map(r => {
        const side = r.qty < 0 ? 'SELL' : 'BUY';
        let perUnit = null;   // + = execution profit, - = execution loss
        if (r.fut != null && r.manual != null && r.qty !== 0) {
          perUnit = r.qty > 0 ? (r.fut - r.manual) : (r.manual - r.fut);
          wNum += perUnit * Math.abs(r.qty);
          wDen += r.fut * Math.abs(r.qty);
          counted++;
        }
        return `
        <tr>
          <td class="dim">${tfmt(r.time)}</td>
          <td><b>${esc(r.acc)}</b></td>
          <td>${esc(r.stock)}</td>
          <td class="r dim num">${esc(r.tf)}</td>
          <td class="${r.qty<0?'down':'up'}"><b>${side}</b></td>
          <td class="r num">${fmt(Math.abs(r.qty),0)}</td>
          <td class="r dim num">${r.alertPrice==null?'—':fmt(r.alertPrice,2)}</td>
          <td class="r num">${r.fut==null?'<span class="dim">pending</span>':fmt(r.fut,2)}</td>
          <td class="r"><input type="number" step="0.05" min="0" class="num"
            style="width:96px;text-align:right;padding:5px 8px"
            value="${r.manual==null?'':r.manual}"
            onchange="savePrice('${r.row}', this)" aria-label="My trade price"></td>
          <td class="r num ${perUnit==null?'':(perUnit>0?'up':(perUnit<0?'down':''))}">${perUnit==null?'—':(perUnit>0?'+':'')+fmt(perUnit,2)}</td>
          <td class="r num ${r.loss==null?'':(r.loss>0?'up':(r.loss<0?'down':''))}"><b>${r.loss==null?'—':(r.loss>0?'+':'')+fmt(r.loss,2)+'%'}</b></td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="11" class="empty">No trades today. Older data is available in the Download tab.</td></tr>';

  document.getElementById('execCards').innerHTML = rows.length
    ? rows.map(r => {
        const side = r.qty < 0 ? 'SELL' : 'BUY';
        return `
        <div class="mcard">
          <div class="mc1"><span class="grow"><b>${esc(r.acc)}</b> · ${esc(r.stock)}</span>
            <span class="t" style="font-size:11px;color:var(--soft);font-weight:500">${tfmt(r.time)}</span></div>
          <div class="mc2 num"><b class="${r.qty<0?'down':'up'}">${side}</b> ${fmt(Math.abs(r.qty),0)}
            · Alert ${r.alertPrice==null?'—':fmt(r.alertPrice,2)}
            · Fut ${r.fut==null?'<i>pending</i>':fmt(r.fut,2)}</div>
          <div class="mc3">
            <span class="num"><span class="lbl">My Price</span>
              <input type="number" step="0.05" min="0" class="num"
                style="width:96px;text-align:right;padding:5px 8px"
                value="${r.manual==null?'':r.manual}"
                onchange="savePrice('${r.row}', this)" aria-label="My trade price"></span>
            <span class="num"><span class="lbl">P/L</span>
              <b class="${r.loss==null?'':(r.loss>0?'up':(r.loss<0?'down':''))}">${r.loss==null?'—':(r.loss>0?'+':'')+fmt(r.loss,2)+'%'}</b></span>
          </div>
        </div>`;
      }).join('')
    : '<div class="mcard"><div class="mc2">No trades yet.</div></div>';

  const avgPct = wDen ? (wNum / wDen) * 100 : null;
  document.getElementById('execTotal').innerHTML = counted
    ? `Avg execution P/L, value-weighted (${counted} filled): <b class="${avgPct>0?'up':(avgPct<0?'down':'')}">${avgPct>0?'+':''}${fmt(avgPct,2)}%</b> <span class="dim">(+ = profit, − = loss)</span>`
    : '';
}

function runExec(){
  clearErr();
  const btn = document.getElementById('runBtn');
  const info = document.getElementById('runInfo');
  btn.disabled = true; btn.textContent = 'Running…'; info.textContent = '';
  google.script.run
    .withSuccessHandler(res => {
      btn.disabled = false; btn.textContent = 'Run — fetch futures prices';
      info.textContent = 'Fetched ' + res.fetched +
        (res.failed ? ', failed ' + res.failed : '') +
        (res.remaining ? ', remaining ' + res.remaining + ' (run again)' : '') + '.';
      if (res.errors && res.errors.length) showErr('Some rows failed: ' + res.errors.join(' · '));
      loadExec();
    })
    .withFailureHandler(e => {
      btn.disabled = false; btn.textContent = 'Run — fetch futures prices';
      showErr((e && e.message ? e.message : e));
    })
    .runExecutionLoss();
}



/* ---------- settings tab ---------- */
let KSTATUS = {};

function loadSettings(){
  google.script.run
    .withSuccessHandler(s => { KSTATUS = s; renderSettings(); })
    .withFailureHandler(e => showErr('Could not load settings: ' + (e && e.message ? e.message : e)))
    .getKiteStatus();
  if (!creatorLoaded) loadCreator();   // Master editor lives here now
  else renderMaster();
}

function renderSettings(){
  const s = KSTATUS;
  const st = document.getElementById('kStatus');
  if (s.connected) {
    st.innerHTML = '<b style="color:var(--up)">● Connected</b> — session active for today (' + esc(s.tokenDate) + ')';
  } else if (s.configured) {
    st.innerHTML = '<b style="color:var(--down)">● Not connected today</b> — keys saved (' + esc(s.apiKeyMasked) + '), login to activate';
  } else {
    st.innerHTML = '<b style="color:var(--down)">● Not configured</b> — save your API key and secret first';
  }
  document.getElementById('kLoginBtn').disabled = !s.configured;
  document.getElementById('kAppUrl').textContent = s.webAppUrl || '(deploy the web app to get the URL)';
  document.getElementById('whUrl').value = s.webhookUrl || '(deploy the web app first)';
}

function saveKeys(){
  clearErr();
  google.script.run
    .withSuccessHandler(s => {
      KSTATUS = s; renderSettings();
      const tag = document.getElementById('ksaved');
      tag.hidden = false; setTimeout(() => tag.hidden = true, 1800);
      document.getElementById('kSecret').value = '';
    })
    .withFailureHandler(e => showErr((e && e.message ? e.message : e)))
    .saveKiteSettings(document.getElementById('kKey').value,
                      document.getElementById('kSecret').value, ADMIN_PIN_CACHE);
}

function kiteLogin(){
  if (KSTATUS.loginUrl) window.open(KSTATUS.loginUrl, '_blank');
  // after they log in and come back, refresh the status
  setTimeout(loadSettings, 15000);
}

function connectToken(){
  clearErr();
  const tok = document.getElementById('kReqTok').value.trim();
  if (!tok) { showErr('Paste the request_token first.'); return; }
  google.script.run
    .withSuccessHandler(s => {
      KSTATUS = s; renderSettings();
      document.getElementById('kReqTok').value = '';
    })
    .withFailureHandler(e => showErr('Connection failed: ' + (e && e.message ? e.message : e)))
    .exchangeRequestToken(tok);
}

/* ---------- users & roles ---------- */
let USERS = [];
let CURRENT_USER = null;    // {name, role, accounts:'*'|'A,B'}
let ADMIN_PIN_CACHE = '';

function userAccSet(){
  if (!CURRENT_USER || CURRENT_USER.accounts === '*') return null;   // all
  return new Set(CURRENT_USER.accounts.split(',').map(s => s.trim()).filter(Boolean));
}
function visibleToUser(acc){
  const s = userAccSet();
  return !s || s.has(acc);
}

let bootWatchdog = null;
function bootUsers(){
  // watchdog: if the server call silently dies (typical cause: browser is
  // signed into multiple Google accounts), surface it instead of spinning
  clearTimeout(bootWatchdog);
  bootWatchdog = setTimeout(() => {
    document.getElementById('gateUsers').innerHTML =
      '<div class="hint" style="line-height:1.5"><b>The server did not respond.</b><br>' +
      'Most common cause: this browser is signed into more than one Google account, ' +
      'which breaks Apps Script calls silently.<br><br>' +
      '<b>Quick fixes:</b><br>' +
      '1. Open this URL in an <b>Incognito window</b> signed into only the sheet-owner account, or<br>' +
      '2. Sign out of the other Google accounts in this browser, or<br>' +
      '3. Use the account-scoped URL: change <span class="num">/macros/s/</span> to ' +
      '<span class="num">/macros/u/0/s/</span> in the address bar (try u/1, u/2 for other slots).<br><br>' +
      '<button class="btn primary" onclick="bootUsers()">Retry</button></div>';
  }, 10000);
  google.script.run
    .withSuccessHandler(us => {
      clearTimeout(bootWatchdog);
      USERS = us;
      let saved = null;
      try { saved = JSON.parse(sessionStorage.getItem('sdtUser') || 'null'); } catch (e) {}
      if (saved && saved.role !== 'admin') {
        const u = USERS.find(x => x.name === saved.name);
        if (u) { enterAs(u); return; }
      }
      document.getElementById('gateUsers').innerHTML = USERS.map((u, i) => `
        <button class="gate-btn" onclick="gatePick(${i})">${esc(u.name)}
          <span class="role">${u.role}</span></button>`).join('');
    })
    .withFailureHandler(e => {
      clearTimeout(bootWatchdog);
      document.getElementById('gateUsers').innerHTML =
        '<div class="hint" style="line-height:1.5"><b>Could not load users.</b><br>' +
        'Server said: <span class="num">' + esc(e && e.message ? e.message : String(e)) + '</span><br><br>' +
        'If this mentions a missing sheet or function, open the Google Sheet and run ' +
        '<b>SDT → Run setup</b>, then reload. ' +
        '<button class="btn sm" onclick="bootUsers()">Retry</button></div>';
    })
    .getUsers();
}

let gatePendingAdmin = null;
function gatePick(i){
  const u = USERS[i];
  if (u.role === 'admin') {
    gatePendingAdmin = u;
    document.getElementById('gatePin').hidden = false;
    document.getElementById('gatePinInp').focus();
    return;
  }
  enterAs(u);
}
function gateAdminGo(){
  const pin = document.getElementById('gatePinInp').value;
  google.script.run
    .withSuccessHandler(ok => {
      if (!ok) { document.getElementById('gatePinErr').textContent = 'Incorrect PIN.'; return; }
      ADMIN_PIN_CACHE = pin;
      enterAs(gatePendingAdmin);
    })
    .withFailureHandler(e => document.getElementById('gatePinErr').textContent =
      (e && e.message ? e.message : 'PIN check failed.'))
    .verifyAdminPin(pin);
}
function enterAs(u){
  CURRENT_USER = u;
  try { sessionStorage.setItem('sdtUser', JSON.stringify({name:u.name, role:u.role})); } catch (e) {}
  document.getElementById('userGate').style.display = 'none';
  const chip = document.getElementById('userChip');
  chip.hidden = false;
  chip.textContent = u.name + (u.role === 'admin' ? ' · admin' : '');
  document.body.classList.toggle('op', u.role !== 'admin');
  renderUsersAdmin();
  render();
}

/* ---------- admin: user routing ---------- */
function renderUsersAdmin(){
  const box = document.getElementById('usersAdminBox');
  const isAdmin = CURRENT_USER && CURRENT_USER.role === 'admin';
  box.hidden = !isAdmin;
  const dataBox = document.getElementById('dataAdminBox');
  if (dataBox) dataBox.hidden = !isAdmin;
  if (!isAdmin) return;
  const accs = (DATA.accounts || []).map(a => a.acc);
  document.getElementById('usersBody').innerHTML = USERS.map((u, i) => {
    const all = u.accounts === '*';
    const set = new Set(all ? [] : u.accounts.split(',').map(s => s.trim()));
    return `<tr>
      <td><b>${esc(u.name)}</b></td>
      <td class="dim">${u.role}</td>
      <td>
        <label class="chk" style="margin-right:10px"><input type="checkbox"
          ${all?'checked':''} onchange="uAll(${i}, this)"> All accounts</label>
        <span id="uAccs${i}" style="${all?'opacity:.4;pointer-events:none':''}">
        ${accs.map(a => `<label class="chk" style="margin-right:8px"><input type="checkbox"
          data-acc="${esc(a)}" ${set.has(a)?'checked':''}> ${esc(a)}</label>`).join('')}
        </span>
      </td>
      <td><button class="btn sm" onclick="uSave(${i}, this)">Save</button></td>
    </tr>`;
  }).join('');
}
function uAll(i, box){
  const span = document.getElementById('uAccs' + i);
  span.style.opacity = box.checked ? '.4' : '1';
  span.style.pointerEvents = box.checked ? 'none' : 'auto';
}
function uSave(i, btn){
  const row = btn.closest('tr');
  const all = row.querySelector('input[type=checkbox]').checked;
  const accs = all ? '*' :
    [...row.querySelectorAll('input[data-acc]:checked')].map(x => x.dataset.acc).join(',');
  if (!accs) { showErr('Pick at least one account, or tick All accounts.'); return; }
  btn.disabled = true; btn.textContent = 'Saving…';
  google.script.run
    .withSuccessHandler(us => { USERS = us; btn.disabled = false; btn.textContent = 'Save';
      if (CURRENT_USER) {
        const me = USERS.find(x => x.name === CURRENT_USER.name);
        if (me) CURRENT_USER = me;
      }
      renderUsersAdmin(); render(); })
    .withFailureHandler(e => { btn.disabled = false; btn.textContent = 'Save';
      showErr((e && e.message ? e.message : e)); })
    .saveUserAccounts(ADMIN_PIN_CACHE, USERS[i].name, accs);
}
function changePin(){
  const np = document.getElementById('pinNew').value;
  google.script.run
    .withSuccessHandler(() => { ADMIN_PIN_CACHE = np;
      const t = document.getElementById('pinSaved');
      t.hidden = false; setTimeout(() => t.hidden = true, 1600);
      document.getElementById('pinNew').value = ''; })
    .withFailureHandler(e => showErr((e && e.message ? e.message : e)))
    .setAdminPin(ADMIN_PIN_CACHE, np);
}
function clearTradingData(btn){
  clearErr();
  const ok = confirm('Delete all trades, pending alerts, positions, funds and alert history? Users, master lists and Kite settings will stay saved.');
  if (!ok) return;
  const typed = prompt('Type DELETE to confirm.');
  if (typed !== 'DELETE') return;
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'Deleting...';
  google.script.run
    .withSuccessHandler(res => {
      btn.disabled = false;
      btn.textContent = old;
      const c = (res && res.counts) || {};
      const msg = 'Deleted: ' +
        (c.trades || 0) + ' trades, ' +
        (c.legSizes || 0) + ' position overrides, ' +
        (c.funds || 0) + ' funds rows, ' +
        (c.alertHistory || 0) + ' alert history rows.';
      const out = document.getElementById('clearDataSaved');
      if (out) {
        out.textContent = msg;
        out.hidden = false;
        setTimeout(() => out.hidden = true, 6000);
      }
      render();
    })
    .withFailureHandler(e => {
      btn.disabled = false;
      btn.textContent = old;
      showErr('Could not delete data: ' + (e && e.message ? e.message : e));
    })
    .clearTradingData(ADMIN_PIN_CACHE);
}

/* ---------- live P&L ---------- */
let PLVIEW = 'acc';
function setPlView(v){
  PLVIEW = v;
  document.getElementById('plAcc').classList.toggle('on', v==='acc');
  document.getElementById('plScrip').classList.toggle('on', v==='scrip');
  renderPnl();
}
function plc(v){ return v==null?'':(v>0?'up':(v<0?'down':'flat')); }
function plfmt(v){ return v==null?'—':(v>0?'+':'')+money(v); }
function renderPnl(){
  const pnl = DATA.pnl || { rows: [], skipped: 0 };
  let rows = pnl.rows;
  const anySpot = rows.some(r => r.src === 'spot');
  document.getElementById('plNote').textContent =
    (anySpot ? 'LTP: spot fallback (login to Zerodha for futures rates)' : (rows.length ? 'LTP: current-month futures' : '')) +
    (pnl.skipped ? ' · ' + pnl.skipped + ' unpriced trade(s) skipped' : '');
  if (PLVIEW === 'acc') {
    const g = {};
    rows.forEach(r => {
      if (!g[r.acc]) g[r.acc] = { acc:r.acc, realized:0, unrealized:0, day:0,
                                  incomplete:false, dayIncomplete:false };
      const a = g[r.acc];
      a.realized += r.realized;
      if (r.unrealized == null) a.incomplete = true; else a.unrealized += r.unrealized;
      if (r.dayPnl == null) a.dayIncomplete = true; else a.day += r.dayPnl;
    });
    rows = Object.values(g).map(a => ({ acc:a.acc, stock:null, realized:a.realized,
      unrealized:a.incomplete?null:a.unrealized,
      dayPnl:a.dayIncomplete?null:a.day,
      total:a.incomplete?null:a.realized+a.unrealized }));
  }
  const scrip = PLVIEW !== 'acc';
  ['plStockTh','plPosTh','plPrevTh','plAvgTh','plLtpTh'].forEach(id =>
    document.getElementById(id).style.display = scrip ? '' : 'none');
  document.getElementById('plBody').innerHTML = rows.length
    ? rows.map(r => `
      <tr>
        <td><b>${esc(r.acc)}</b></td>
        ${!scrip ? '' : '<td>'+esc(r.stock)+(r.src==='spot'?' <span class="dim" style="font-size:10px">(spot)</span>':'')+'</td>' +
          '<td class="r"><span class="pill num '+cls(r.pos)+'"><span class="'+cls(r.pos)+'">'+(r.pos>0?'+':'')+fmt(r.pos,0)+'</span></span></td>' +
          '<td class="r dim num">'+(r.prev==null?'—':fmt(r.prev,2))+'</td>' +
          '<td class="r dim num">'+(r.avg==null?'—':fmt(r.avg,2))+'</td>' +
          '<td class="r dim num">'+(r.ltp==null?'—':fmt(r.ltp,2))+'</td>'}
        <td class="r num ${plc(r.dayPnl)}"><b>${plfmt(r.dayPnl)}</b></td>
        <td class="r num ${plc(r.realized)}">${plfmt(r.realized)}</td>
        <td class="r num ${plc(r.unrealized)}">${plfmt(r.unrealized)}</td>
        <td class="r num ${plc(r.total)}"><b>${plfmt(r.total)}</b></td>
      </tr>`).join('')
    : '<tr><td colspan="9" class="empty">No priced trades yet — P&L appears once trades carry a price.</td></tr>';
  document.getElementById('plCards').innerHTML = rows.length
    ? rows.map(r => `
      <div class="mcard">
        <div class="mc1"><span class="grow"><b>${esc(r.acc)}</b>${r.stock?' · '+esc(r.stock):''}</span>
          <span class="num ${plc(r.dayPnl)}"><b>Day ${plfmt(r.dayPnl)}</b></span></div>
        ${r.stock && r.ltp!=null ? '<div class="mc2 num">Pos '+(r.pos>0?'+':'')+fmt(r.pos,0)+' · Prev '+(r.prev==null?'—':fmt(r.prev,2))+' · LTP '+fmt(r.ltp,2)+'</div>' : ''}
        <div class="mc3"><span class="num"><span class="lbl">Realized</span>
            <b class="${plc(r.realized)}">${plfmt(r.realized)}</b></span>
          <span class="num"><span class="lbl">Unrealized</span>
            <b class="${plc(r.unrealized)}">${plfmt(r.unrealized)}</b></span>
          <span class="num"><span class="lbl">Total</span>
            <b class="${plc(r.total)}">${plfmt(r.total)}</b></span></div>
      </div>`).join('')
    : '<div class="mcard"><div class="mc2">No priced trades yet.</div></div>';
}

/* ---------- position grid (stock x timeframe, long/short) ---------- */
function indShort(ind){
  const s = String(ind || '').trim();
  if (!s) return '';
  const para = s.match(/^para\s*([0-9.]+)/i);
  if (para) return 'P' + para[1];
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 6).toUpperCase();
  return parts.map(p => (/^[0-9.]+$/.test(p) ? p : p[0])).join('').slice(0, 8).toUpperCase();
}
function renderGrid(){
  const agg = {};
  DATA.legs.forEach(l => {
    const s = (agg[l.stock] ||= {});
    const tf = String(l.tf || '');
    const ind = String(l.ind || '');
    const t = (s[tf] ||= {});
    t[ind] = (t[ind] || 0) + l.qty;
  });
  const stocks = Object.keys(agg).sort();
  document.getElementById('gridBox').innerHTML = stocks.length
    ? stocks.map(st => {
        const tfs = Object.keys(agg[st]).sort((a,b)=>(Number(a)-Number(b))||a.localeCompare(b));
        return `<div class="grow-row"><span class="stk">${esc(st)}</span>
          <span class="chipwrap">${tfs.map(tf => {
            const byInd = agg[st][tf];
            const inds = Object.keys(byInd).sort();
            return inds.map(ind => {
              const q = byInd[ind];
              const c = q > 0 ? 'long' : (q < 0 ? 'short' : '');
              const label = esc(tf) + (inds.length > 1 ? ` (${esc(indShort(ind))})` : '');
              const full = [tf, ind].filter(Boolean).join(' · ');
              return `<span class="tfchip ${c}" title="${esc(full)} net ${q>0?'+':''}${fmt(q,0)}">${label}</span>`;
            }).join('');
          }).join('')}</span></div>`;
      }).join('')
    : '<div class="empty">No positions yet.</div>';
}

/* ---------- account funds ---------- */
function editFund(span, acc, field){
  const a = DATA.accounts.find(x => x.acc === acc);
  if (!a) return;
  const raw = field === 'total'
    ? (a.totalFund == null ? '' : a.totalFund)
    : Math.round(a.usedFund);
  const inp = document.createElement('input');
  inp.type = 'number'; inp.min = '0'; inp.step = '1000';
  inp.className = 'num';
  inp.style.cssText = 'width:120px;text-align:right;padding:4px 7px';
  inp.value = raw;
  inp.setAttribute('aria-label', field === 'total' ? 'Total fund' : 'Used fund');
  inp.onchange = () => saveFundVal(acc, field, inp);
  inp.onblur = () => { if (!inp.disabled) render(); };   // no change -> restore display
  span.replaceWith(inp);
  inp.focus(); inp.select();
}

function saveFundVal(acc, field, input){
  const a = DATA.accounts.find(x => x.acc === acc);
  if (!a) return;
  const val = input.value === '' ? '' : Number(input.value);
  const total = field === 'total' ? val : (a.totalFund == null ? '' : a.totalFund);
  const used  = field === 'used'  ? val : (a.usedManual ? a.usedFund : '');
  input.disabled = true;
  google.script.run
    .withSuccessHandler(() => {
      if (field === 'total') a.totalFund = val === '' ? null : val;
      if (field === 'used') { a.usedManual = val !== '';
        a.usedFund = val === '' ? a.gross * 0.30 : val; }
      a.netAvail = a.totalFund == null ? null : a.totalFund - a.usedFund;
      render(); load(false);
    })
    .withFailureHandler(e => { input.disabled = false;
      showErr('Could not save fund: ' + (e && e.message ? e.message : e)); })
    .saveFund(acc, total, used);
}

/* ---------- manual entry tab ---------- */
let LEGMASTER = [];

function loadManual(){
  const fill = () => {
    const m = CREATOR.master;
    fillSelect('mAcc', m.accounts, true);
    fillSelect('mStock', m.stocks.map(s=>s.stock), true);
    fillSelect('mInd', m.indicators, true);
    fillSelect('mTf', m.timeframes, true);
    fillSelect('lmAcc', m.accounts, true);
    fillSelect('lmStock', m.stocks.map(s=>s.stock), true);
    fillSelect('lmInd', m.indicators, true);
    fillSelect('lmTf', m.timeframes, true);
    if (!document.getElementById('mTime').value) {
      const n = new Date(), p = v => String(v).padStart(2,'0');
      document.getElementById('mTime').value =
        n.getFullYear()+'-'+p(n.getMonth()+1)+'-'+p(n.getDate())+'T'+p(n.getHours())+':'+p(n.getMinutes());
    }
  };
  if (!creatorLoaded) {
    google.script.run.withSuccessHandler(d => {
      CREATOR = d; MASTER_EDIT = JSON.parse(JSON.stringify(d.master));
      creatorLoaded = true; renderCreatorForm(); fill();
    }).getCreatorData();
  } else fill();

  google.script.run
    .withSuccessHandler(rows => { LEGMASTER = rows; renderLegMaster(); })
    .withFailureHandler(e => showErr('Could not load positions master: ' + (e && e.message ? e.message : e)))
    .getLegMaster();
}

function renderLegMaster(){
  document.getElementById('legMasterBody').innerHTML = LEGMASTER.length
    ? LEGMASTER.map((r, i) => `
      <tr>
        <td><b>${esc(r.acc)}</b></td>
        <td>${esc(r.stock)}</td>
        <td class="dim">${esc(r.ind)}</td>
        <td class="r dim num">${esc(r.tf)}</td>
        <td class="r num">${fmt(r.qty,0)}</td>
        <td><button class="btn sm" onclick="removeLeg(${i}, this)">✕ Remove</button></td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="empty">No legs yet — add every chart you run above.</td></tr>';
}

function addLegMaster(){
  clearErr();
  const p = { acc: document.getElementById('lmAcc').value,
              stock: document.getElementById('lmStock').value,
              ind: document.getElementById('lmInd').value,
              tf: document.getElementById('lmTf').value,
              lot: '', val: document.getElementById('lmQty').value };
  if (!Number(p.val)) { showErr('Enter the Total Qty (one side) for this leg.'); return; }
  google.script.run
    .withSuccessHandler(() => {
      const tag = document.getElementById('lmSaved');
      tag.hidden = false; setTimeout(() => tag.hidden = true, 1600);
      loadManual(); load(false);
    })
    .withFailureHandler(e => showErr((e && e.message ? e.message : e)))
    .saveTotalQty(p);
}

function removeLeg(i, btn){
  const r = LEGMASTER[i];
  btn.disabled = true; btn.textContent = 'Removing…';
  google.script.run
    .withSuccessHandler(() => { loadManual(); load(false); })
    .withFailureHandler(e => { btn.disabled = false; btn.textContent = '✕ Remove';
      showErr((e && e.message ? e.message : e)); })
    .saveTotalQty({ acc: r.acc, stock: r.stock, ind: r.ind, tf: r.tf, lot: '', val: '' });
}

function addManual(){
  clearErr();
  const btn = document.getElementById('mAddBtn');
  btn.disabled = true; btn.textContent = 'Adding…';
  google.script.run
    .withSuccessHandler(() => {
      btn.disabled = false; btn.textContent = 'Add trade';
      const tag = document.getElementById('mSaved');
      tag.hidden = false; setTimeout(() => tag.hidden = true, 1600);
      document.getElementById('mQty').value = '';
      document.getElementById('mPrice').value = '';
      load(false);
    })
    .withFailureHandler(e => {
      btn.disabled = false; btn.textContent = 'Add trade';
      showErr((e && e.message ? e.message : e));
    })
    .addManualTrade({
      acc: document.getElementById('mAcc').value,
      stock: document.getElementById('mStock').value,
      ind: document.getElementById('mInd').value,
      tf: document.getElementById('mTf').value,
      side: document.getElementById('mSide').value,
      qty: document.getElementById('mQty').value,
      price: document.getElementById('mPrice').value,
      time: document.getElementById('mTime').value
    });
}

/* ---------- editable Total Qty (one-side size) ---------- */
function recomputeAccountsLocal(){
  const m = {};
  DATA.legs.forEach(l => {
    const a = (m[l.acc] ||= { acc:l.acc, gross:0, net:0, legs:0, missing:0 });
    a.legs++;
    if (l.rate == null) { a.missing++; return; }
    a.gross += (l.totalQty || 0) * l.rate;
    a.net   += (l.exposure || 0);
  });
  DATA.accounts = Object.values(m).sort((x,y)=>x.acc.localeCompare(y.acc))
    .map(a => ({...a, pct: a.gross > 0 ? Math.abs(a.net)/a.gross*100 : 0}));
}

function saveTQ(i, input){
  const leg = DATA.legs[i];
  if (!leg) return;
  const val = input.value === '' ? '' : Number(input.value);
  input.disabled = true;
  google.script.run
    .withSuccessHandler(res => {
      leg.totalQty = res.override != null ? res.override
        : Math.abs(leg.qty);               // cleared -> approximate until next refresh
      leg.manualSize = res.override != null;
      leg.grossExposure = leg.rate != null ? leg.totalQty * leg.rate : null;
      recomputeAccountsLocal();
      render();
      load(false);                          // authoritative values in background
    })
    .withFailureHandler(e => {
      input.disabled = false;
      showErr('Could not save Total Qty: ' + (e && e.message ? e.message : e));
    })
    .saveTotalQty({ acc: leg.acc, stock: leg.stock, ind: leg.ind,
                    tf: leg.tf, lot: leg.lot ?? '', val: val });
}

/* ---------- download tab ---------- */
function doDownload(){
  clearErr();
  const f = document.getElementById('dlFrom').value;
  const t = document.getElementById('dlTo').value;
  if (!f) { showErr('Pick a From date.'); return; }
  const btn = document.getElementById('dlBtn');
  const st = document.getElementById('dlStatus');
  btn.disabled = true; btn.textContent = 'Preparing…'; st.textContent = '';
  google.script.run
    .withSuccessHandler(res => {
      const bytes = Uint8Array.from(atob(res.base64), c => c.charCodeAt(0));
      const blob = new Blob([bytes],
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = res.filename;
      document.body.appendChild(a); a.click(); a.remove();
      btn.disabled = false; btn.textContent = 'Download Excel';
      st.textContent = 'Downloaded ' + res.filename + ' — ' + res.counts.trades +
        ' trades, ' + res.counts.positions + ' positions, ' + res.counts.exec + ' exec rows.';
    })
    .withFailureHandler(e => {
      btn.disabled = false; btn.textContent = 'Download Excel';
      showErr('Download failed: ' + (e && e.message ? e.message : e));
    })
    .exportExcel(f, t);
}

/* ---------- positions snapshot export / import ---------- */
function exportPos(){
  clearErr();
  const btn = document.getElementById('expPosBtn');
  const st = document.getElementById('posSnapStatus');
  btn.disabled = true; btn.textContent = 'Exporting…';
  google.script.run
    .withSuccessHandler(res => {
      btn.disabled = false; btn.textContent = 'Export open positions';
      if (!res.count) { st.textContent = 'No open positions to export.'; return; }
      const blob = new Blob([res.csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = res.filename;
      document.body.appendChild(a); a.click(); a.remove();
      st.textContent = 'Exported ' + res.count + ' open position(s) → ' + res.filename;
    })
    .withFailureHandler(e => { btn.disabled = false; btn.textContent = 'Export open positions';
      showErr('Export failed: ' + (e && e.message ? e.message : e)); })
    .exportPositions();
}

function importPos(){
  clearErr();
  const f = document.getElementById('impFile').files[0];
  const st = document.getElementById('posSnapStatus');
  if (!f) { showErr('Choose the exported CSV file first.'); return; }
  const btn = document.getElementById('impPosBtn');
  btn.disabled = true; btn.textContent = 'Importing…';
  const reader = new FileReader();
  reader.onerror = () => { btn.disabled = false; btn.textContent = 'Import';
    showErr('Could not read the file.'); };
  reader.onload = () => {
    google.script.run
      .withSuccessHandler(res => {
        btn.disabled = false; btn.textContent = 'Import';
        st.textContent = 'Imported ' + res.imported + ' position(s)' +
          (res.skipped ? ' · skipped ' + res.skipped + ' (already open / invalid)' : '') + ' ✓';
        document.getElementById('impFile').value = '';
        load(false);
      })
      .withFailureHandler(e => { btn.disabled = false; btn.textContent = 'Import';
        showErr('Import failed: ' + (e && e.message ? e.message : e)); })
      .importPositions(reader.result);
  };
  reader.readAsText(f);
}

/* ---------- share exposure as image ---------- */
function loadScript(src){
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}
async function shareElement(elId, filename, btn){
  try {
    btn.disabled = true; btn.textContent = 'Preparing…';
    if (!window.html2canvas) {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
    }
    const el = document.getElementById(elId);
    const canvas = await html2canvas(el, { backgroundColor: '#f6f8fa', scale: 2 });
    canvas.toBlob(async blob => {
      const file = new File([blob], filename, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: 'SDT Dashboard — Account Exposure' }); }
        catch (e) { /* user cancelled the share sheet */ }
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        showErr('Sharing is not supported in this browser — the image was downloaded instead; attach it in WhatsApp.');
      }
      btn.disabled = false; btn.textContent = 'Share';
    }, 'image/png');
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Share';
    showErr('Could not create the image: ' + e.message);
  }
}

/* ---------- global error surface ---------- */
window.onerror = function(msg, src, line){
  try { showErr('App error: ' + msg + ' (line ' + line + ')'); } catch (e) {}
};

/* ---------- boot ---------- */
load(false);
bootUsers();
if (location.search.indexOf('kite=ok') !== -1) {
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
}
setInterval(() => load(false), 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(false); });
