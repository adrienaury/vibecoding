/* =========================================================================
   IRRViz 2 — câblage de l'interface.
   ========================================================================= */

(function(){
"use strict";

const U = IRR.util, M = IRR.model, CSV = IRR.csv;
const { DAY } = U;
const store = IRR.store.createStore();
const S = () => store.state;   // position active
const G = () => store.global;  // préférences communes (thème, panneau, proxy)
const $ = id => document.getElementById(id);

const el = {
  layout: document.querySelector(".layout"),
  panel: $("sidePanel"), backdrop: $("backdrop"), btnPanel: $("btnPanel"),
  btnUndo: $("btnUndo"), btnRedo: $("btnRedo"),
  dataMenu: $("dataMenu"), btnDataMenu: $("btnDataMenu"),
  posMenu: $("posMenu"), btnPosMenu: $("btnPosMenu"), posName: $("posName"), posSub: $("posSub"), posItems: $("posItems"),
  posDialog: $("posDialog"), posForm: $("posForm"), posDialogTitle: $("posDialogTitle"), posNameInput: $("posNameInput"),
  posCopyRow: $("posCopyRow"), posCopySettings: $("posCopySettings"), posCopyFrom: $("posCopyFrom"),
  posDialogHint: $("posDialogHint"), posDialogOk: $("posDialogOk"),
  btnTheme: $("btnTheme"), btnHelp: $("btnHelp"),
  txList: $("txList"), txCount: $("txCount"), btnAddTx: $("btnAddTx"), btnImportOpen: $("btnImportOpen"),
  chips: $("thresholdChips"), thresholdForm: $("thresholdForm"), newThreshold: $("newThreshold"), btnResetThresholds: $("btnResetThresholds"),
  feeInput: $("feeInput"), horizonInput: $("horizonInput"), quickRange: $("quickRange"),
  assetForm: $("assetForm"), tickerInput: $("tickerInput"), btnClearAsset: $("btnClearAsset"), btnLoadAsset: $("btnLoadAsset"),
  assetStatus: $("assetStatus"), proxyDot: $("proxyDot"), proxyPort: $("proxyPort"), btnCheckProxy: $("btnCheckProxy"),
  assetCard: document.querySelector('details.card[data-card="asset"]'),
  srcYahoo: $("srcYahoo"), srcManual: $("srcManual"), srcPanelYahoo: $("srcPanelYahoo"), srcPanelManual: $("srcPanelManual"),
  btnImportPrices: $("btnImportPrices"), btnExportPrices: $("btnExportPrices"), btnClearPrices: $("btnClearPrices"),
  manualHint: $("manualHint"), proxyDetails: $("proxyDetails"),
  importTitle: $("importTitle"), priceName: $("priceName"), priceModeRow: $("priceModeRow"),
  kpis: $("kpis"), legend: $("legend"),
  tglBands: $("tglBands"), tglLabels: $("tglLabels"), tglCandles: $("tglCandles"),
  btnZoomIn: $("btnZoomIn"), btnZoomOut: $("btnZoomOut"), btnResetView: $("btnResetView"),
  chartWrap: $("chartWrap"), chartSvg: $("chartSvg"), tooltip: $("tooltip"), emptyState: $("emptyState"),
  importDialog: $("importDialog"), importForm: $("importForm"), csvText: $("csvText"), csvFile: $("csvFile"),
  dropzone: $("dropzone"), importPreview: $("importPreview"), importDedupe: $("importDedupe"), btnImportConfirm: $("btnImportConfirm"),
  helpDialog: $("helpDialog"), restoreFile: $("restoreFile"), toasts: $("toasts"),
};

const mqLight = window.matchMedia("(prefers-color-scheme: light)");
const mqMobile = window.matchMedia("(max-width: 900px)");

let model = null;
// Cours affichés : { source: "yahoo" | "manual", kind: "ohlc" | "close", ticker (libellé), candles,
// currency, name, exchange, fetchedAt, cached, fileName, importedAt }
let assetData = null;
let assetState = { status: "idle", message: "" };
let proxyOk = null;
let highlightId = null;

/* =====================================================================
   Toasts
   ===================================================================== */

function toast(message, { type = "info", action = null, timeout = 5000 } = {}){
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.setAttribute("role", type === "error" ? "alert" : "status");
  const msg = document.createElement("span");
  msg.className = "toast-msg";
  msg.textContent = message;
  t.appendChild(msg);
  if(action){
    const b = document.createElement("button");
    b.className = "toast-action";
    b.textContent = action.label;
    b.addEventListener("click", () => { action.fn(); close(); });
    t.appendChild(b);
  }
  const x = document.createElement("button");
  x.className = "toast-close";
  x.setAttribute("aria-label", "Fermer");
  x.innerHTML = `<svg class="ic"><use href="#i-x"/></svg>`;
  x.addEventListener("click", () => close());
  t.appendChild(x);
  el.toasts.appendChild(t);
  while(el.toasts.children.length > 4) el.toasts.firstElementChild.remove();
  requestAnimationFrame(() => t.classList.add("in"));
  let timer = setTimeout(close, timeout);
  t.addEventListener("mouseenter", () => clearTimeout(timer));
  t.addEventListener("mouseleave", () => { timer = setTimeout(close, 2500); });
  function close(){
    clearTimeout(timer);
    t.classList.remove("in");
    setTimeout(() => t.remove(), 220);
  }
}

// Action « Annuler » d'une notification : elle s'applique à la position concernée,
// même si l'utilisateur a changé de position entre-temps.
function undoAction(){
  const id = store.activeId;
  return { label: "Annuler", fn: () => { if(store.activeId !== id) store.switchTo(id); store.undo(); } };
}

/* =====================================================================
   Thème
   ===================================================================== */

function effectiveTheme(){
  const t = G().ui.theme;
  return t === "auto" ? (mqLight.matches ? "light" : "dark") : t;
}

function applyTheme(){
  const t = G().ui.theme;
  if(t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  const icon = { auto: "#i-auto", light: "#i-sun", dark: "#i-moon" }[t];
  const label = { auto: "automatique (système)", light: "clair", dark: "sombre" }[t];
  el.btnTheme.innerHTML = `<svg class="ic"><use href="${icon}"/></svg>`;
  el.btnTheme.title = `Thème : ${label} (T)`;
  const meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.content = effectiveTheme() === "light" ? "#f5f7fb" : "#0b0e14";
}

function cycleTheme(){
  const order = ["auto", "light", "dark"];
  const next = order[(order.indexOf(G().ui.theme) + 1) % order.length];
  store.setUi(s => { s.ui.theme = next; });
  applyTheme();
  toast(`Thème ${{ auto: "automatique", light: "clair", dark: "sombre" }[next]}`, { timeout: 1600 });
}

/* =====================================================================
   Panneau latéral
   ===================================================================== */

function setDrawer(open){
  document.body.classList.toggle("drawer-open", open);
  el.backdrop.hidden = !open;
}

function togglePanel(){
  if(mqMobile.matches) setDrawer(!document.body.classList.contains("drawer-open"));
  else store.setUi(s => { s.ui.panelCollapsed = !s.ui.panelCollapsed; });
}

function applyPanelState(){
  el.layout.classList.toggle("panel-collapsed", !mqMobile.matches && G().ui.panelCollapsed);
  el.btnPanel.setAttribute("aria-expanded", String(mqMobile.matches ? document.body.classList.contains("drawer-open") : !G().ui.panelCollapsed));
}

function ensurePanelVisible(){
  if(mqMobile.matches) setDrawer(true);
  else if(G().ui.panelCollapsed) store.setUi(s => { s.ui.panelCollapsed = false; });
}

function openCard(name){
  const card = document.querySelector(`details.card[data-card="${name}"]`);
  if(card && !card.open) card.open = true;
  return card;
}

/* =====================================================================
   Transactions
   ===================================================================== */

const KIND_LABEL = { buy: "Achat", sell: "Vente", income: "Flux +", cost: "Flux −" };

function sortedTransactions(){
  return S().transactions
    .map((t, i) => ({ t, i, ms: U.isoToMs(t.iso) }))
    .sort((a, b) => {
      const av = Number.isFinite(a.ms), bv = Number.isFinite(b.ms);
      if(av !== bv) return av ? -1 : 1;
      return (av ? a.ms - b.ms : 0) || a.i - b.i;
    })
    .map(x => x.t);
}

function numToInput(v){ return v === 0 ? "" : String(v).replace(".", ","); }

function txRowHtml(tx){
  const id = U.escapeHtml(tx.id);
  return `<div class="tx-row" role="listitem" data-id="${id}">
    <div class="tx-line">
      <input type="date" class="tx-date" value="${U.escapeHtml(tx.iso || "")}" aria-label="Date" required />
      <span class="tx-kind"></span>
      <span class="tx-warn" hidden><svg class="ic"><use href="#i-warn"/></svg></span>
      <span class="tx-actions">
        <button class="icon-btn tiny" data-act="dup" title="Dupliquer" aria-label="Dupliquer"><svg class="ic"><use href="#i-copy"/></svg></button>
        <button class="icon-btn tiny danger" data-act="del" title="Supprimer" aria-label="Supprimer"><svg class="ic"><use href="#i-trash"/></svg></button>
      </span>
    </div>
    <div class="tx-fields">
      <label><span>Montant net</span><span class="input-affix"><input type="text" inputmode="decimal" class="tx-amount" placeholder="0" value="${numToInput(tx.amount)}" /><span class="suffix">€</span></span></label>
      <label><span>Quantité</span><input type="text" inputmode="decimal" class="tx-qty" placeholder="0" value="${numToInput(tx.quantity)}" /></label>
    </div>
    <div class="tx-meta"><span class="tx-price"></span><span class="tx-pos"></span></div>
  </div>`;
}

function renderTxList(){
  // Préserve le focus (le tri par date peut réordonner les lignes).
  const active = document.activeElement;
  const activeRow = active && active.closest && active.closest(".tx-row");
  const focus = activeRow ? { id: activeRow.dataset.id, cls: active.className.split(" ")[0], sel: [active.selectionStart, active.selectionEnd] } : null;

  const list = sortedTransactions();
  el.txList.innerHTML = list.map(txRowHtml).join("") ||
    `<div class="tx-empty">Aucune transaction pour l'instant.</div>`;
  el.txCount.textContent = list.length;
  refreshTxMeta();

  if(focus){
    const row = el.txList.querySelector(`.tx-row[data-id="${CSS.escape(focus.id)}"]`);
    const input = row && row.querySelector(`.${focus.cls}`);
    if(input){
      input.focus({ preventScroll: true });
      try{ if(input.type === "text") input.setSelectionRange(focus.sel[0], focus.sel[1]); }catch(e){ /* ignore */ }
    }
  }
}

// Met à jour les infos dérivées (type, prix unitaire, position, alertes) sans reconstruire la liste.
function refreshTxMeta(){
  const byId = new Map();
  if(model) model.points.forEach(p => byId.set(p.id, p));
  el.txList.querySelectorAll(".tx-row").forEach(row => {
    const tx = S().transactions.find(t => t.id === row.dataset.id);
    if(!tx) return;
    const p = byId.get(tx.id);
    const kind = M.txKind(tx);
    const kindEl = row.querySelector(".tx-kind");
    kindEl.className = `tx-kind k-${kind}`;
    kindEl.textContent = KIND_LABEL[kind];
    const price = M.impliedPrice(tx);
    row.querySelector(".tx-price").textContent = price != null ? `PU ${U.fmtEUR3.format(price)}` : "";
    row.querySelector(".tx-pos").textContent = p ? `Position ${U.fmtNum.format(p.cumQty)}` : "";

    const warns = [];
    if(!Number.isFinite(U.isoToMs(tx.iso))) warns.push("Date manquante ou invalide : transaction ignorée.");
    if(tx.amount === 0 && tx.quantity === 0) warns.push("Montant et quantité nuls.");
    if(tx.quantity > 0 && tx.amount > 0) warns.push("Achat avec un montant positif : un décaissement devrait être négatif.");
    if(tx.quantity < 0 && tx.amount < 0) warns.push("Vente avec un montant négatif : un encaissement devrait être positif.");
    if(p && p.cumQty < 0) warns.push("La position devient négative après cette transaction.");
    const w = row.querySelector(".tx-warn");
    w.hidden = !warns.length;
    w.title = warns.join("\n");
    row.classList.toggle("has-warn", warns.length > 0);
    row.classList.toggle("is-hl", tx.id === highlightId);
  });
}

function addTransaction(){
  const id = U.makeId();
  store.update(s => { s.transactions.push({ id, iso: U.msToIso(U.todayMs()), amount: 0, quantity: 0 }); });
  ensurePanelVisible();
  openCard("tx");
  requestAnimationFrame(() => focusTx(id, ".tx-amount"));
}

function focusTx(id, selector){
  const row = el.txList.querySelector(`.tx-row[data-id="${CSS.escape(id)}"]`);
  if(!row) return;
  row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash");
  if(selector){ const i = row.querySelector(selector); if(i) i.focus({ preventScroll: true }); }
}

function selectTxFromChart(id){
  ensurePanelVisible();
  openCard("tx");
  requestAnimationFrame(() => focusTx(id));
}

function onTxInput(e){
  const input = e.target;
  const row = input.closest(".tx-row");
  if(!row) return;
  const id = row.dataset.id;
  const isAmt = input.classList.contains("tx-amount"), isQty = input.classList.contains("tx-qty");
  if(!isAmt && !isQty) return;
  const raw = input.value.trim();
  const v = raw === "" ? 0 : U.parseNum(raw);
  input.classList.toggle("invalid", !Number.isFinite(v));
  if(!Number.isFinite(v)) return;
  const field = isAmt ? "amount" : "quantity";
  store.update(s => {
    const tx = s.transactions.find(t => t.id === id);
    if(tx) tx[field] = v;
  }, { key: `${field}:${id}`, kind: "soft" });
}

function onTxChange(e){
  const input = e.target;
  const row = input.closest(".tx-row");
  if(!row) return;
  const id = row.dataset.id;
  const tx = S().transactions.find(t => t.id === id);
  if(!tx) return;
  if(input.classList.contains("tx-date")){
    if(input.value === tx.iso) return;
    store.update(s => { s.transactions.find(t => t.id === id).iso = input.value; });
  } else if(input.classList.contains("tx-amount") || input.classList.contains("tx-qty")){
    // Normalise l'affichage au relâchement du champ.
    if(!input.classList.contains("invalid")) input.value = numToInput(input.classList.contains("tx-amount") ? tx.amount : tx.quantity);
  }
}

function onTxClick(e){
  const btn = e.target.closest("button[data-act]");
  if(!btn) return;
  const id = btn.closest(".tx-row").dataset.id;
  if(btn.dataset.act === "del"){
    store.update(s => { s.transactions = s.transactions.filter(t => t.id !== id); });
    toast("Transaction supprimée", { action: undoAction() });
  } else if(btn.dataset.act === "dup"){
    const src = S().transactions.find(t => t.id === id);
    const nid = U.makeId();
    store.update(s => {
      const i = s.transactions.findIndex(t => t.id === id);
      s.transactions.splice(i + 1, 0, { id: nid, iso: src.iso, amount: src.amount, quantity: src.quantity });
    });
    requestAnimationFrame(() => focusTx(nid, ".tx-amount"));
  }
}

function onTxKeydown(e){
  const input = e.target;
  if(e.key !== "Enter" || input.tagName !== "INPUT") return;
  const row = input.closest(".tx-row");
  if(!row) return;
  e.preventDefault();
  if(input.classList.contains("tx-date")) row.querySelector(".tx-amount").focus();
  else if(input.classList.contains("tx-amount")) row.querySelector(".tx-qty").focus();
  else if(input.classList.contains("tx-qty")){
    const next = row.nextElementSibling;
    if(next && next.classList.contains("tx-row")) next.querySelector(".tx-amount").focus();
    else addTransaction();
  }
}

function setHighlight(id){
  if(highlightId === id) return;
  highlightId = id;
  el.txList.querySelectorAll(".tx-row").forEach(r => r.classList.toggle("is-hl", r.dataset.id === id));
  pushChart();
}

/* =====================================================================
   Seuils
   ===================================================================== */

function sortedThresholds(){ return S().thresholds.slice().sort((a, b) => a - b); }
function visibleThresholds(){ return sortedThresholds().filter(v => !S().hiddenThresholds.includes(v)); }

function renderChips(){
  const light = effectiveTheme() === "light";
  el.chips.innerHTML = sortedThresholds().map(v => {
    const hidden = S().hiddenThresholds.includes(v);
    const color = U.colorForReturn(v, light ? -0.22 : 0);
    return `<div class="chip${hidden ? " is-hidden" : ""}" data-v="${v}" style="--c:${color}">
      <button class="chip-swatch" data-act="toggle" title="${hidden ? "Afficher" : "Masquer"} la courbe" aria-pressed="${!hidden}" aria-label="${hidden ? "Afficher" : "Masquer"} le seuil ${v} %"></button>
      <input type="text" inputmode="decimal" value="${String(v).replace(".", ",")}" aria-label="Seuil en %" />
      <span class="chip-unit">%</span>
      <button class="chip-del" data-act="del" title="Supprimer" aria-label="Supprimer le seuil ${v} %"><svg class="ic"><use href="#i-x"/></svg></button>
    </div>`;
  }).join("");
}

function toggleThreshold(v){
  store.update(s => {
    s.hiddenThresholds = s.hiddenThresholds.includes(v) ? s.hiddenThresholds.filter(x => x !== v) : s.hiddenThresholds.concat(v);
  });
}

function validThreshold(v){
  if(!Number.isFinite(v)){ toast("Valeur de seuil invalide.", { type: "error" }); return false; }
  if(v <= -100){ toast("Un seuil doit être supérieur à −100 %.", { type: "error" }); return false; }
  if(v > 1000){ toast("Un seuil doit être inférieur à 1 000 %.", { type: "error" }); return false; }
  return true;
}

function initThresholds(){
  el.chips.addEventListener("click", e => {
    const btn = e.target.closest("button[data-act]");
    if(!btn) return;
    const v = Number(btn.closest(".chip").dataset.v);
    if(btn.dataset.act === "toggle") toggleThreshold(v);
    else if(btn.dataset.act === "del"){
      store.update(s => {
        s.thresholds = s.thresholds.filter(x => x !== v);
        s.hiddenThresholds = s.hiddenThresholds.filter(x => x !== v);
      });
      toast(`Seuil ${U.fmtThreshold(v)} supprimé`, { action: undoAction() });
    }
  });
  el.chips.addEventListener("change", e => {
    const input = e.target.closest("input");
    if(!input) return;
    const old = Number(input.closest(".chip").dataset.v);
    const nv = U.parseNum(input.value);
    if(nv === old) return;
    if(!validThreshold(nv) || (S().thresholds.includes(nv) && (toast("Ce seuil existe déjà.", { type: "error" }), true))){
      input.value = String(old).replace(".", ",");
      return;
    }
    store.update(s => {
      s.thresholds = s.thresholds.map(x => x === old ? nv : x);
      s.hiddenThresholds = s.hiddenThresholds.map(x => x === old ? nv : x);
    });
  });
  el.chips.addEventListener("keydown", e => {
    if(e.key === "Enter" && e.target.tagName === "INPUT") e.target.blur();
  });
  el.thresholdForm.addEventListener("submit", e => {
    e.preventDefault();
    const v = U.parseNum(el.newThreshold.value);
    if(!validThreshold(v)) return;
    if(S().thresholds.includes(v)){ toast("Ce seuil existe déjà.", { type: "error" }); return; }
    store.update(s => { s.thresholds.push(v); });
    el.newThreshold.value = "";
  });
  el.btnResetThresholds.addEventListener("click", () => {
    store.update(s => { s.thresholds = IRR.store.DEFAULT_THRESHOLDS.slice(); s.hiddenThresholds = []; });
    toast("Seuils par défaut rétablis", { action: undoAction() });
  });
}

/* =====================================================================
   Paramètres (frais, horizon)
   ===================================================================== */

function renderSettings(){
  if(document.activeElement !== el.feeInput) el.feeInput.value = String(S().feePercent).replace(".", ",");
  el.horizonInput.value = S().horizonIso || U.msToIso(U.todayMs() + 365 * DAY);
  const horizon = U.isoToMs(S().horizonIso || "");
  el.quickRange.querySelectorAll("button").forEach(b => {
    b.classList.toggle("active", Number.isFinite(horizon) && horizon === U.addMonths(U.todayMs(), Number(b.dataset.m)));
  });
}

function initSettings(){
  el.feeInput.addEventListener("input", () => {
    const v = el.feeInput.value.trim() === "" ? 0 : U.parseNum(el.feeInput.value);
    const ok = Number.isFinite(v) && v >= 0 && v < 99;
    el.feeInput.classList.toggle("invalid", !ok);
    if(ok) store.update(s => { s.feePercent = v; }, { key: "fee", kind: "soft" });
  });
  el.feeInput.addEventListener("blur", () => {
    el.feeInput.classList.remove("invalid");
    el.feeInput.value = String(S().feePercent).replace(".", ",");
  });
  el.horizonInput.addEventListener("change", () => {
    const iso = el.horizonInput.value;
    store.update(s => { s.horizonIso = Number.isFinite(U.isoToMs(iso)) ? iso : null; });
    chart.resetView("x");
  });
  el.quickRange.addEventListener("click", e => {
    const b = e.target.closest("button");
    if(!b) return;
    const iso = U.msToIso(U.addMonths(U.todayMs(), Number(b.dataset.m)));
    store.update(s => { s.horizonIso = iso; });
    chart.resetView("x");
  });
}

/* =====================================================================
   Actif (Yahoo Finance)
   ===================================================================== */

function setProxyDot(ok){
  proxyOk = ok;
  el.proxyDot.className = "proxy-dot" + (ok === true ? " ok" : ok === false ? " ko" : "");
  el.proxyDot.title = ok === true ? "Proxy local connecté" : ok === false ? "Proxy local non détecté" : "État du proxy inconnu";
}

async function checkProxy(verbose){
  const ok = await IRR.asset.checkProxy(G().proxyPort);
  setProxyDot(ok);
  if(verbose) toast(ok ? `Proxy détecté sur le port ${G().proxyPort}.` : `Aucun proxy sur le port ${G().proxyPort}. Lancez « python proxy.py ».`, { type: ok ? "success" : "error" });
  return ok;
}

function renderSource(){
  const manual = S().priceSource === "manual";
  el.srcYahoo.setAttribute("aria-selected", String(!manual));
  el.srcManual.setAttribute("aria-selected", String(manual));
  el.srcPanelYahoo.hidden = manual;
  el.srcPanelManual.hidden = !manual;
  el.proxyDetails.hidden = manual;
  el.manualHint.hidden = !manual;
  el.assetCard.dataset.source = manual ? "manual" : "yahoo";
  const hasManual = manual && assetData && assetData.source === "manual";
  el.btnExportPrices.hidden = !hasManual;
  el.btnClearPrices.hidden = !hasManual;
  el.btnImportPrices.querySelector("span").textContent = hasManual ? "Mettre à jour…" : "Importer un historique…";
}

function renderAssetStatus(){
  const st = assetState;
  let html = "";
  renderSource();
  if(assetData && assetData.source === "manual"){
    const cs = assetData.candles, first = cs[0], last = cs[cs.length - 1];
    html = `<div class="asset-title"><b>${U.escapeHtml(assetData.ticker)}</b>${assetData.fileName ? ` <span>${U.escapeHtml(assetData.fileName)}</span>` : ""}</div>`;
    html += `<div class="asset-line">${cs.length} cours ${assetData.kind === "ohlc" ? "OHLC" : "de clôture"} du ${U.fmtDate(first.ms)} au ${U.fmtDate(last.ms)}</div>`;
    html += `<div class="asset-line">Dernier cours ${U.fmtEUR3.format(last.close)}${assetData.importedAt ? ` · importé le ${U.fmtDate(assetData.importedAt)}` : ""}</div>`;
    if(last.ms < U.todayMs() - 45 * DAY){
      html += `<div class="asset-line warn"><svg class="ic"><use href="#i-warn"/></svg> Dernier cours ancien : la plus-value et le TRI actuels sont calculés avec ce cours.</div>`;
    }
    el.assetStatus.innerHTML = html;
    el.tglCandles.hidden = false;
    return;
  }
  if(S().priceSource === "manual"){
    el.assetStatus.innerHTML = `<span class="muted">Aucun historique importé pour cette position.</span>`;
    el.tglCandles.hidden = true;
    return;
  }
  if(st.status === "loading"){
    html = `<span class="spinner" aria-hidden="true"></span> Chargement de ${U.escapeHtml(st.ticker)}…`;
  } else if(assetData){
    const last = assetData.candles[assetData.candles.length - 1];
    const title = [assetData.name, assetData.exchange].filter(Boolean).map(U.escapeHtml).join(" · ");
    html = `<div class="asset-title"><b>${U.escapeHtml(assetData.ticker)}</b>${title ? ` <span>${title}</span>` : ""}</div>`;
    html += `<div class="asset-line">${assetData.candles.length} séances · dernier cours ${U.fmtEUR3.format(last.close).replace("€", assetData.currency && assetData.currency !== "EUR" ? U.escapeHtml(assetData.currency) : "€")} le ${U.fmtDate(last.ms)}</div>`;
    if(assetData.cached){
      html += `<div class="asset-line warn">Données en cache du ${U.fmtDate(assetData.fetchedAt)} à ${new Date(assetData.fetchedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}.</div>`;
    }
    if(assetData.currency && assetData.currency !== "EUR"){
      html += `<div class="asset-line warn"><svg class="ic"><use href="#i-warn"/></svg> Cotation en ${U.escapeHtml(assetData.currency)} alors que vos montants sont en euros : la comparaison n'a de sens que si les devises concordent.</div>`;
    }
  }
  if(st.status === "error"){
    html += `<div class="asset-line error">${U.escapeHtml(st.message)}</div>`;
  }
  if(!html) html = `<span class="muted">Superposez les cours journaliers de l'actif pour les comparer aux prix seuils.</span>`;
  el.assetStatus.innerHTML = html;
  el.tglCandles.hidden = !assetData;
}

let assetRequest = 0;
async function loadAsset(ticker, { silent = false } = {}){
  const sym = (ticker || "").trim().toUpperCase();
  if(!sym) return clearAsset();
  if(sym !== S().assetTicker) store.update(s => { s.assetTicker = sym; }, { kind: "none" });
  if(!assetData || assetData.ticker !== sym){
    const cache = store.readCandleCache(sym);
    assetData = cache ? { source: "yahoo", kind: "ohlc", ticker: sym, candles: cache.candles, currency: cache.currency, fetchedAt: cache.fetchedAt, cached: true } : null;
  }
  const req = ++assetRequest;
  const posId = store.activeId;
  assetState = { status: "loading", ticker: sym };
  renderAssetStatus(); pushChart(); renderKpis(); renderLegend();
  try{
    const res = await IRR.asset.fetchCandles({ ticker: sym, port: G().proxyPort, transactions: S().transactions, horizonIso: S().horizonIso });
    setProxyDot(true);
    // Le cache et le nom automatique concernent la position qui a lancé la requête,
    // même si l'utilisateur a changé de position pendant le téléchargement.
    const owner = store.positions.find(p => p.id === posId);
    if(owner && owner.assetTicker === sym){
      store.writeCandleCache(sym, res.candles, res.currency, posId);
      store.autoNamePosition(posId, sym);
    }
    if(req !== assetRequest) return;
    if(S().priceSource !== "yahoo") return;
    assetData = Object.assign(res, { source: "yahoo", kind: "ohlc", fetchedAt: Date.now(), cached: false });
    assetState = { status: "ok" };
    if(!silent) toast(`${sym} : ${res.candles.length} séances chargées`, { type: "success", timeout: 2500 });
  }catch(err){
    if(req !== assetRequest) return;
    if(err.code === "proxy") setProxyDot(false);
    assetState = { status: "error", message: err.message };
    if(!silent) toast(err.message, { type: "error", timeout: 7000 });
  }
  renderAssetStatus(); pushChart(); renderKpis(); renderLegend();
}

function clearAsset(){
  assetRequest++;
  assetData = null;
  assetState = { status: "idle" };
  el.tickerInput.value = "";
  store.clearCandleCache();
  store.update(s => { s.assetTicker = ""; }, { kind: "none" });
  renderAssetStatus(); pushChart(); renderKpis(); renderLegend();
}

// (Re)charge les cours de la position active selon sa source : historique importé,
// ou cache Yahoo puis téléchargement si un symbole est défini.
function syncAsset(){
  assetRequest++;
  assetData = null;
  assetState = { status: "idle" };
  el.tickerInput.value = S().assetTicker;
  if(S().priceSource === "manual"){
    const rec = store.readManualPrices();
    if(rec) assetData = manualAssetData(rec);
  } else if(S().assetTicker){
    loadAsset(S().assetTicker, { silent: true });
    return;
  }
  renderAssetStatus();
}

function manualAssetData(rec){
  return { source: "manual", kind: rec.kind, ticker: rec.name, candles: rec.candles, currency: null, fileName: rec.fileName, importedAt: rec.importedAt };
}

function refreshAssetViews(){ renderAssetStatus(); pushChart(); renderKpis(); renderLegend(); }

// Exécute `fn` sur la position `posId` (bascule dessus si besoin) : utilisé par les « Annuler ».
function onPosition(posId, fn){
  if(store.activeId !== posId && !store.switchTo(posId)) return;
  fn();
}

function setPriceSource(src, posId = store.activeId){
  onPosition(posId, () => {
    if(S().priceSource === src) return;
    store.update(s => { s.priceSource = src; }, { undoable: false, kind: "none" });
    if(src === "yahoo" && proxyOk == null) checkProxy(false);
    syncAsset();
    refreshAssetViews();
  });
}

function clearManualPrices(){
  const posId = store.activeId;
  const prev = store.readManualPrices();
  if(!prev) return;
  store.clearManualPrices();
  syncAsset(); refreshAssetViews();
  toast(`Historique « ${prev.name} » retiré`, {
    timeout: 8000,
    action: { label: "Annuler", fn: () => onPosition(posId, () => { store.writeManualPrices(prev); syncAsset(); refreshAssetViews(); }) },
  });
}

function exportManualPrices(){
  if(!assetData || assetData.source !== "manual") return;
  download(`irrviz-cours-${slug(assetData.ticker)}-${stamp()}.csv`, CSV.toPriceCsv(assetData.candles, assetData.kind), "text/csv;charset=utf-8");
}

function initAsset(){
  el.srcYahoo.addEventListener("click", () => setPriceSource("yahoo"));
  el.srcManual.addEventListener("click", () => setPriceSource("manual"));
  el.btnImportPrices.addEventListener("click", () => openImport(undefined, "prices"));
  el.btnExportPrices.addEventListener("click", exportManualPrices);
  el.btnClearPrices.addEventListener("click", clearManualPrices);
  el.assetForm.addEventListener("submit", e => {
    e.preventDefault();
    loadAsset(el.tickerInput.value);
  });
  el.btnClearAsset.addEventListener("click", clearAsset);
  el.proxyPort.value = G().proxyPort;
  el.proxyPort.addEventListener("change", () => {
    const p = parseInt(el.proxyPort.value, 10);
    if(Number.isInteger(p) && p > 0 && p < 65536){
      store.setUi(s => { s.proxyPort = p; }, "none");
      checkProxy(true);
    } else el.proxyPort.value = G().proxyPort;
  });
  el.btnCheckProxy.addEventListener("click", () => checkProxy(true));
  const card = el.assetCard;
  card.addEventListener("toggle", () => { if(card.open && proxyOk == null && S().priceSource === "yahoo") checkProxy(false); });

  syncAsset();
  if(!S().assetTicker && card.open && S().priceSource === "yahoo") checkProxy(false);
}

/* =====================================================================
   Indicateurs (KPI)
   ===================================================================== */

function kpi({ label, value, sub = "", tone = "", action = "", title = "" }){
  const tag = action ? "button" : "div";
  return `<${tag} class="kpi${tone ? " " + tone : ""}"${action ? ` data-action="${action}"` : ""}${title ? ` title="${U.escapeHtml(title)}"` : ""}>
    <span class="kpi-label">${label}</span>
    <span class="kpi-value">${value}</span>
    <span class="kpi-sub">${sub}</span>
  </${tag}>`;
}

function renderKpis(){
  if(!model){ el.kpis.innerHTML = ""; el.kpis.hidden = true; return; }
  el.kpis.hidden = false;
  const today = U.todayMs();
  const fee = S().feePercent / 100;
  const asOf = Math.max(today, model.d0);
  const sum = M.positionSummary(model, asOf);
  const cards = [];

  cards.push(kpi({
    label: "Position détenue",
    value: Math.abs(sum.qty) > 0 ? U.fmtNum.format(sum.qty) : "Soldée",
    sub: `${sum.count} transaction${sum.count > 1 ? "s" : ""}${model.lastMs > today ? " · + futures" : ""}`,
  }));

  const invested = -sum.netFlow;
  const subParts = [`achats ${U.fmtEUR.format(sum.bought)}`];
  if(sum.sold) subParts.push(`ventes ${U.fmtEUR.format(sum.sold)}`);
  if(sum.income) subParts.push(`flux +${U.fmtEUR.format(sum.income)}`);
  cards.push(kpi({
    label: invested >= 0 ? "Capital net investi" : "Gain net déjà encaissé",
    value: U.fmtEUR.format(Math.abs(invested)),
    sub: subParts.join(" · "),
    title: "Somme des montants nets : achats et frais moins ventes et flux reçus",
  }));

  if(Math.abs(sum.qty) > 0){
    const be = M.makePricer(model, 0, fee)(asOf);
    cards.push(kpi({
      label: "Seuil de rentabilité",
      value: be != null ? U.fmtEUR3.format(be) : "—",
      sub: "prix de revente pour un TRI de 0 % aujourd'hui",
      tone: "accent",
    }));
  } else {
    const r = M.irrForSale(model, model.lastMs, 0, fee);
    cards.push(kpi({
      label: "TRI réalisé",
      value: r != null ? U.fmtPct(r) : "—",
      sub: "position entièrement soldée",
      tone: r == null ? "" : r >= 0 ? "pos" : "neg",
    }));
  }

  const candles = assetData && assetData.candles;
  if(candles && candles.length && Math.abs(sum.qty) > 0){
    const last = candles[candles.length - 1];
    const be = M.makePricer(model, 0, fee)(asOf);
    const vsBe = be ? (last.close / be - 1) * 100 : null;
    cards.push(kpi({
      label: `Dernier cours ${U.escapeHtml(assetData.ticker)}`,
      value: U.fmtEUR3.format(last.close),
      sub: `${U.fmtDate(last.ms)}${vsBe != null ? ` · <span class="${vsBe >= 0 ? "pos" : "neg"}">${U.fmtPct(vsBe)}</span> vs seuil 0 %` : ""}`,
    }));
    const mv = last.close * sum.qty * (1 - fee);
    const pnl = mv + sum.netFlow;
    cards.push(kpi({
      label: "Plus-value latente",
      value: `${pnl >= 0 ? "+" : ""}${U.fmtEUR.format(pnl)}`,
      sub: `valeur nette de revente ${U.fmtEUR.format(mv)}`,
      tone: pnl >= 0 ? "pos" : "neg",
      title: "Valeur de revente au dernier cours (frais déduits) + flux nets déjà réalisés",
    }));
    const r = M.irrForSale(model, asOf, last.close, fee);
    cards.push(kpi({
      label: "TRI actuel",
      value: r != null ? `${U.fmtPct(r)}<small> /an</small>` : "—",
      sub: "si vente au dernier cours, frais inclus",
      tone: r == null ? "" : r >= 0 ? "pos" : "neg",
    }));
  } else if(Math.abs(sum.qty) > 0){
    cards.push(kpi({
      label: "Cours de l'actif",
      value: "—",
      sub: assetState.status === "loading" ? "chargement…" : "Ajoutez un symbole ou importez un historique pour obtenir la plus-value et le TRI actuels",
      action: "asset",
      tone: "ghost",
    }));
  }
  el.kpis.innerHTML = cards.join("");
}

/* =====================================================================
   Légende et bascules d'affichage
   ===================================================================== */

function renderLegend(){
  if(!model){ el.legend.innerHTML = ""; return; }
  const light = effectiveTheme() === "light";
  const items = sortedThresholds().map(v => {
    const hidden = S().hiddenThresholds.includes(v);
    return `<button class="litem th${hidden ? " off" : ""}" data-v="${v}" aria-pressed="${!hidden}" title="${hidden ? "Afficher" : "Masquer"} la courbe ${U.fmtThreshold(v)}">
      <span class="lline" style="background:${U.colorForReturn(v, light ? -0.22 : 0)}"></span>${U.fmtThreshold(v)}</button>`;
  });
  items.push(`<span class="litem"><span class="ldot buy"></span>Achat</span>`);
  items.push(`<span class="litem"><span class="ldot sell"></span>Vente</span>`);
  if(model.points.some(p => !p.quantity)) items.push(`<span class="litem"><span class="ltri"></span>Flux</span>`);
  if(model.points.some(p => p.cumQty === 0)) items.push(`<span class="litem"><span class="lhatch"></span>Soldée</span>`);
  if(assetData && G().ui.showCandles) items.push(`<span class="litem"><span class="${assetData.kind === "close" ? "lassetline" : "lcandle"}"></span>${U.escapeHtml(assetData.ticker)}</span>`);
  el.legend.innerHTML = items.join("");
}

function renderToggles(){
  el.tglBands.setAttribute("aria-pressed", String(G().ui.showBands));
  el.tglLabels.setAttribute("aria-pressed", String(G().ui.showLabels));
  el.tglCandles.setAttribute("aria-pressed", String(G().ui.showCandles));
}

function toggleUi(key){ store.setUi(s => { s.ui[key] = !s.ui[key]; }); }

/* =====================================================================
   Graphique
   ===================================================================== */

const chart = IRR.createChart({
  wrap: el.chartWrap, svg: el.chartSvg, tooltip: el.tooltip,
  onSelectTx: selectTxFromChart,
  onViewChange: v => { store.setView(v); updateViewButtons(); },
});

function pushChart(){
  const horizon = U.isoToMs(S().horizonIso || "");
  chart.setInput({
    model,
    thresholds: visibleThresholds(),
    feeFrac: S().feePercent / 100,
    candles: assetData ? assetData.candles : null,
    ticker: assetData ? assetData.ticker : "",
    priceKind: assetData ? assetData.kind : "ohlc",
    horizonMs: Number.isFinite(horizon) ? horizon : null,
    showBands: G().ui.showBands,
    showLabels: G().ui.showLabels,
    showCandles: G().ui.showCandles,
    theme: effectiveTheme(),
    highlightId,
  });
}

function updateViewButtons(){
  el.btnResetView.classList.toggle("active", chart.isZoomed());
}

/* =====================================================================
   Import / export
   ===================================================================== */

let importParsed = null;
let importMode = "tx";        // "tx" (transactions) | "prices" (historique de cours)
let importFileName = null;

const IMPORT_PLACEHOLDER = {
  tx: "date ; montant ; quantité\n01/01/2026;-1000,00;1000\n01/02/2026;500,00;-400",
  prices: "date ; cours\n31/03/2026;250,10\n30/06/2026;252,40",
};

function openImport(prefill, mode = "tx", fileName = null){
  if(typeof prefill === "string") el.csvText.value = prefill;
  importFileName = fileName;
  // Échap ne modifie pas returnValue : on le remet à zéro pour ne pas rejouer un import précédent.
  el.importDialog.returnValue = "";
  setImportMode(mode);
  if(!el.importDialog.open) el.importDialog.showModal();
  el.csvText.focus();
}

function setImportMode(mode){
  importMode = mode;
  el.importTitle.textContent = mode === "prices" ? `Importer un historique de cours — ${S().name}` : "Importer des transactions";
  el.importDialog.querySelectorAll("[data-for]").forEach(n => { n.hidden = n.dataset.for !== mode; });
  el.csvText.placeholder = IMPORT_PLACEHOLDER[mode];
  if(mode === "prices"){
    const existing = store.readManualPrices();
    el.priceModeRow.hidden = !existing;
    el.importForm.querySelector('input[name="priceMode"][value="replace"]').checked = true;
    el.priceName.value = existing ? existing.name : "";
    el.priceName.placeholder = fileBaseName(importFileName) || "ex : SCPI Primovie";
  }
  updateImportPreview();
}

const fileBaseName = name => (name || "").replace(/\.[^.]+$/, "").trim();

function updateImportPreview(){
  const text = el.csvText.value;
  if(!text.trim()){
    importParsed = null;
    el.importPreview.innerHTML = "";
    el.btnImportConfirm.disabled = true;
    el.btnImportConfirm.textContent = "Importer";
    return;
  }
  if(importMode === "prices") return updatePricePreview(text);
  importParsed = CSV.parseCsv(text);
  const { rows, rejected, headerSkipped } = importParsed;
  let html = `<div class="preview-summary"><span class="ok">${rows.length} transaction${rows.length > 1 ? "s" : ""} valide${rows.length > 1 ? "s" : ""}</span>`;
  if(rejected.length) html += ` · <span class="ko">${rejected.length} ligne${rejected.length > 1 ? "s" : ""} ignorée${rejected.length > 1 ? "s" : ""}</span>`;
  if(headerSkipped) html += ` · <span class="muted">en-tête détecté</span>`;
  html += `</div>`;
  if(rows.length){
    html += `<table class="preview-table"><thead><tr><th>Date</th><th>Montant</th><th>Quantité</th><th>Type</th></tr></thead><tbody>`;
    rows.slice(0, 6).forEach(r => {
      const kind = M.txKind(r);
      html += `<tr><td>${U.fmtDate(U.isoToMs(r.iso))}</td><td class="num">${U.fmtEUR.format(r.amount)}</td><td class="num">${U.fmtNum.format(r.quantity)}</td><td><span class="tx-kind k-${kind}">${KIND_LABEL[kind]}</span></td></tr>`;
    });
    if(rows.length > 6) html += `<tr><td colspan="4" class="muted">… et ${rows.length - 6} autre${rows.length - 6 > 1 ? "s" : ""}</td></tr>`;
    html += `</tbody></table>`;
  }
  // Aucune transaction reconnue mais un historique de cours plausible : on propose de basculer.
  if(!rows.length){
    const asPrices = CSV.parsePriceCsv(text);
    if(asPrices.rows.length >= 2){
      html += `<div class="import-switch"><span>Ce fichier ressemble à un historique de cours (${asPrices.rows.length} dates).</span><button class="btn tiny primary" type="button" data-switch="prices">L'importer comme cours de l'actif</button></div>`;
    }
  }
  html += rejectedHtml(rejected);
  el.importPreview.innerHTML = html;
  el.btnImportConfirm.disabled = rows.length === 0;
  el.btnImportConfirm.textContent = rows.length ? `Importer ${rows.length} transaction${rows.length > 1 ? "s" : ""}` : "Importer";
}

function rejectedHtml(rejected){
  if(!rejected.length) return "";
  return `<ul class="preview-errors">${rejected.slice(0, 5).map(r => `<li>Ligne ${r.line} : ${U.escapeHtml(r.reason)} — <code>${U.escapeHtml(r.text.slice(0, 60))}</code></li>`).join("")}${rejected.length > 5 ? `<li>… et ${rejected.length - 5} autre${rejected.length - 5 > 1 ? "s" : ""}</li>` : ""}</ul>`;
}

function updatePricePreview(text){
  importParsed = CSV.parsePriceCsv(text, { maxMs: U.todayMs() + DAY });
  const { rows, rejected, headerSkipped, kind, dateOrder, duplicates } = importParsed;
  const n = rows.length;
  let html = `<div class="preview-summary"><span class="ok">${n} cours ${kind === "ohlc" ? "OHLC" : "de clôture"}</span>`;
  if(n) html += ` du ${U.fmtDate(rows[0].ms)} au ${U.fmtDate(rows[n - 1].ms)}`;
  if(rejected.length) html += ` · <span class="ko">${rejected.length} ligne${rejected.length > 1 ? "s" : ""} ignorée${rejected.length > 1 ? "s" : ""}</span>`;
  if(headerSkipped) html += ` · <span class="muted">en-tête détecté</span>`;
  if(dateOrder === "mdy") html += ` · <span class="muted">dates au format mm/jj/aaaa</span>`;
  if(duplicates) html += ` · <span class="muted">${duplicates} date${duplicates > 1 ? "s" : ""} en double (dernière valeur retenue)</span>`;
  html += `</div>`;
  if(n){
    const cols = kind === "ohlc" ? ["Ouverture", "Haut", "Bas", "Clôture"] : ["Cours"];
    html += `<table class="preview-table"><thead><tr><th>Date</th>${cols.map(c => `<th class="num">${c}</th>`).join("")}</tr></thead><tbody>`;
    const shown = n > 6 ? rows.slice(0, 3).concat([null], rows.slice(-2)) : rows;
    shown.forEach(r => {
      if(!r){ html += `<tr><td colspan="${cols.length + 1}" class="muted">… ${n - 5} autres dates …</td></tr>`; return; }
      const vals = kind === "ohlc" ? [r.open, r.high, r.low, r.close] : [r.close];
      html += `<tr><td>${U.fmtDate(r.ms)}</td>${vals.map(v => `<td class="num">${U.fmtEUR3.format(v)}</td>`).join("")}</tr>`;
    });
    html += `</tbody></table>`;
  }
  html += rejectedHtml(rejected);
  el.importPreview.innerHTML = html;
  el.btnImportConfirm.disabled = n === 0;
  el.btnImportConfirm.textContent = n ? `Importer ${n} cours` : "Importer";
}

function applyPriceImport(){
  const parsed = importParsed;
  const posId = store.activeId;
  const prev = store.readManualPrices();
  const prevSource = S().priceSource;
  const merge = prev && !el.priceModeRow.hidden && el.importForm.querySelector('input[name="priceMode"]:checked').value === "merge";
  let candles = parsed.rows, kind = parsed.kind;
  if(merge){
    const byDay = new Map(prev.candles.map(c => [c.ms, c]));
    parsed.rows.forEach(r => byDay.set(r.ms, r));
    candles = [...byDay.values()].sort((a, b) => a.ms - b.ms);
    // Un historique mixte (OHLC + clôtures seules) est affiché en ligne de clôture.
    kind = prev.kind === "ohlc" && parsed.kind === "ohlc" ? "ohlc" : "close";
  }
  const name = el.priceName.value.trim() || (merge && prev.name) || fileBaseName(importFileName) || "Cours importés";
  const ok = store.writeManualPrices({ name, fileName: importFileName || (merge ? prev.fileName : null), kind, candles, importedAt: Date.now() });
  if(!ok){
    toast("Espace de stockage du navigateur insuffisant pour enregistrer cet historique.", { type: "error", timeout: 8000 });
    return;
  }
  if(prevSource !== "manual") store.update(s => { s.priceSource = "manual"; }, { undoable: false, kind: "none" });
  store.autoNamePosition(posId, name);
  syncAsset(); refreshAssetViews();
  el.csvText.value = "";
  importParsed = null;
  toast(`${merge ? "Historique complété" : "Historique importé"} : ${candles.length} cours pour « ${name} »`, {
    type: "success", timeout: 8000,
    action: { label: "Annuler", fn: () => onPosition(posId, () => {
      if(prev) store.writeManualPrices(prev); else store.clearManualPrices();
      if(prevSource !== "manual") store.update(s => { s.priceSource = prevSource; }, { undoable: false, kind: "none" });
      syncAsset(); refreshAssetViews();
    }) },
  });
}

function applyImport(){
  if(!importParsed || !importParsed.rows.length) return;
  if(importMode === "prices") return applyPriceImport();
  const mode = el.importForm.querySelector('input[name="importMode"]:checked').value;
  const dedupe = el.importDedupe.checked;
  const key = t => `${t.iso}|${t.amount}|${t.quantity}`;
  let added = 0, skipped = 0;
  store.update(s => {
    const base = mode === "replace" ? [] : s.transactions.slice();
    const seen = new Set(base.map(key));
    importParsed.rows.forEach(r => {
      if(dedupe && seen.has(key(r))){ skipped++; return; }
      seen.add(key(r));
      base.push({ id: U.makeId(), iso: r.iso, amount: r.amount, quantity: r.quantity });
      added++;
    });
    s.transactions = base;
  });
  chart.resetView("both");
  el.csvText.value = "";
  importParsed = null;
  toast(`${added} transaction${added > 1 ? "s" : ""} importée${added > 1 ? "s" : ""}${skipped ? ` (${skipped} doublon${skipped > 1 ? "s" : ""} ignoré${skipped > 1 ? "s" : ""})` : ""}`, { type: "success", action: undoAction() });
}

// Lit un fichier texte ; si l'UTF-8 échoue (export Excel français), retente en Windows-1252.
function readTextFile(file){
  return file.arrayBuffer().then(buf => {
    try{ return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch(e){ return new TextDecoder("windows-1252").decode(buf); }
  });
}

function download(filename, content, type){
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => U.msToIso(U.todayMs());
const slug = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "position";

function initImportExport(){
  el.csvText.addEventListener("input", U.debounce(updateImportPreview, 120));
  el.csvFile.addEventListener("change", async () => {
    const f = el.csvFile.files[0];
    if(f){ el.csvText.value = await readTextFile(f); importFileName = f.name; setImportMode(importMode); }
    el.csvFile.value = "";
  });
  ["dragenter", "dragover"].forEach(ev => el.dropzone.addEventListener(ev, e => { e.preventDefault(); el.dropzone.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => el.dropzone.addEventListener(ev, () => el.dropzone.classList.remove("over")));
  el.dropzone.addEventListener("drop", async e => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if(f){ el.csvText.value = await readTextFile(f); importFileName = f.name; setImportMode(importMode); }
  });
  el.importPreview.addEventListener("click", e => {
    const b = e.target.closest("[data-switch]");
    if(b) setImportMode(b.dataset.switch);
  });
  el.importDialog.addEventListener("close", () => {
    if(el.importDialog.returnValue === "default") applyImport();
  });

  // Déposer un CSV n'importe où sur la page ouvre directement l'import.
  document.addEventListener("dragover", e => { if(e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
  document.addEventListener("drop", async e => {
    if(el.importDialog.open || !e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if(/\.json$/i.test(f.name)) return restoreFrom(f);
    // Déposé sur la carte « Cours de l'actif » en mode fichier : c'est un historique de cours.
    const onPrices = e.target.closest && e.target.closest('[data-card="asset"]') && S().priceSource === "manual";
    openImport(await readTextFile(f), onPrices ? "prices" : "tx", f.name);
  });

  el.restoreFile.addEventListener("change", () => {
    const f = el.restoreFile.files[0];
    if(f) restoreFrom(f);
    el.restoreFile.value = "";
  });

  el.btnDataMenu.addEventListener("click", e => { e.stopPropagation(); toggleMenu(null, el.dataMenu); });
  el.dataMenu.querySelector(".menu-list").addEventListener("click", e => {
    const b = e.target.closest("button[data-action]");
    if(!b) return;
    toggleMenu(false);
    runAction(b.dataset.action);
  });
  document.addEventListener("click", e => {
    if(!el.dataMenu.contains(e.target)) toggleMenu(false, el.dataMenu);
    if(!el.posMenu.contains(e.target)) toggleMenu(false, el.posMenu);
  });
  // Navigation au clavier dans les menus (flèches haut / bas).
  document.querySelectorAll(".menu-list").forEach(list => list.addEventListener("keydown", e => {
    if(e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if(e.altKey) return;
    e.preventDefault();
    const items = [...list.querySelectorAll("button:not([disabled])")].filter(b => b.offsetParent !== null);
    const i = items.indexOf(document.activeElement);
    const next = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    if(next) next.focus();
  }));
}

async function restoreFrom(file){
  try{
    const data = JSON.parse(await readTextFile(file));
    const res = store.restoreBackup(data);
    const msg = res.mode === "all"
      ? `Sauvegarde restaurée : ${res.count} position${res.count > 1 ? "s" : ""}`
      : `Sauvegarde ajoutée comme nouvelle position « ${S().name} »`;
    toast(msg, { type: "success", timeout: 10000, action: { label: "Annuler", fn: res.undo } });
  }catch(e){
    toast("Fichier de sauvegarde illisible.", { type: "error" });
  }
}

function toggleMenu(force, menu = el.dataMenu){
  const list = menu.querySelector(".menu-list");
  const open = force != null ? force : list.hidden;
  if(open === !list.hidden) return;
  list.hidden = !open;
  menu.querySelector("[aria-haspopup]").setAttribute("aria-expanded", String(open));
  if(open){
    [el.dataMenu, el.posMenu].forEach(m => { if(m !== menu) toggleMenu(false, m); });
    (list.querySelector('[aria-checked="true"]') || list.querySelector("button")).focus();
  }
}

function runAction(action){
  switch(action){
    case "import": openImport(); break;
    case "export-csv":
      if(!S().transactions.length) return toast("Aucune transaction à exporter.", { type: "error" });
      download(`irrviz-${slug(S().name)}-${stamp()}.csv`, CSV.toCsv(S().transactions), "text/csv;charset=utf-8");
      break;
    case "backup":
      download(`irrviz-sauvegarde-${stamp()}.json`, JSON.stringify(store.backup(), null, 2), "application/json");
      break;
    case "restore": el.restoreFile.click(); break;
    case "sample":
      store.loadSample();
      chart.resetView("both");
      toast("Exemple chargé", { action: undoAction() });
      break;
    case "clear":
      if(!S().transactions.length) return;
      store.update(s => { s.transactions = []; });
      toast(`Transactions de « ${S().name} » effacées`, { action: undoAction(), timeout: 8000 });
      break;
  }
}

/* =====================================================================
   Raccourcis clavier
   ===================================================================== */

function isTyping(t){
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

function initShortcuts(){
  document.addEventListener("keydown", e => {
    if(e.key === "Escape"){
      toggleMenu(false, el.dataMenu);
      toggleMenu(false, el.posMenu);
      if(document.body.classList.contains("drawer-open")) setDrawer(false);
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if(mod && !e.altKey && (e.key === "z" || e.key === "Z" || e.key === "y")){
      if(isTyping(e.target)) return; // annulation native du champ
      e.preventDefault();
      const redo = e.key === "y" || e.shiftKey;
      const done = redo ? store.redo() : store.undo();
      if(!done) toast(redo ? "Rien à rétablir" : "Rien à annuler", { timeout: 1400 });
      return;
    }
    if(e.altKey && !mod && (e.key === "ArrowUp" || e.key === "ArrowDown") && !isTyping(e.target) && !document.querySelector("dialog[open]")){
      e.preventDefault();
      cyclePosition(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if(mod || e.altKey || isTyping(e.target) || document.querySelector("dialog[open]")) return;
    const onChart = e.target === el.chartWrap;
    switch(e.key){
      case "n": case "N": e.preventDefault(); addTransaction(); break;
      case "i": case "I": e.preventDefault(); openImport(); break;
      case "?": e.preventDefault(); el.helpDialog.showModal(); break;
      case "t": case "T": cycleTheme(); break;
      case "p": case "P": togglePanel(); break;
      case "z": case "Z": toggleUi("showBands"); break;
      case "l": case "L": toggleUi("showLabels"); break;
      case "c": case "C": if(assetData) toggleUi("showCandles"); break;
      case "0": chart.resetView("both"); break;
      case "+": case "=": if(!onChart) chart.zoomIn(); break;
      case "-": if(!onChart) chart.zoomOut(); break;
    }
  });
}

/* =====================================================================
   Positions
   ===================================================================== */

function positionSummaryText(p){
  const n = p.transactions.length;
  const parts = [`${n} transaction${n > 1 ? "s" : ""}`];
  if(p.assetTicker) parts.push(p.assetTicker);
  return parts.join(" · ");
}

function renderPositions(){
  const cur = S();
  const list = store.positions;
  el.posName.textContent = cur.name;
  el.posSub.textContent = list.length > 1 ? `${list.indexOf(cur) + 1} / ${list.length}` : positionSummaryText(cur);
  el.btnPosMenu.title = `Position : ${cur.name} — changer de position (Alt+↑ / Alt+↓)`;
  document.title = `${cur.name} — IRRViz 2`;
  const focused = document.activeElement && el.posItems.contains(document.activeElement)
    ? { id: document.activeElement.closest("[data-id]")?.dataset.id, act: document.activeElement.dataset.move || "pick" } : null;
  el.posItems.innerHTML = list.map((p, i) => {
    const on = p.id === cur.id;
    const id = U.escapeHtml(p.id);
    return `<div class="pos-item${on ? " active" : ""}" data-id="${id}">
      <button class="pos-pick" role="menuitemradio" aria-checked="${on}" data-id="${id}">
        <svg class="ic pos-check"><use href="#i-check"/></svg>
        <span class="pos-item-text"><b>${U.escapeHtml(p.name)}</b><small>${U.escapeHtml(positionSummaryText(p))}</small></span>
      </button>
      <span class="pos-move">
        <button class="icon-btn tiny" data-move="-1" title="Monter" aria-label="Monter ${U.escapeHtml(p.name)}"${i === 0 ? " disabled" : ""}><svg class="ic"><use href="#i-chevron-up"/></svg></button>
        <button class="icon-btn tiny" data-move="1" title="Descendre" aria-label="Descendre ${U.escapeHtml(p.name)}"${i === list.length - 1 ? " disabled" : ""}><svg class="ic"><use href="#i-chevron"/></svg></button>
      </span>
    </div>`;
  }).join("");
  if(focused && focused.id){
    const item = el.posItems.querySelector(`.pos-item[data-id="${CSS.escape(focused.id)}"]`);
    const target = item && (focused.act === "pick" ? item.querySelector(".pos-pick") : item.querySelector(`[data-move="${focused.act}"]:not([disabled])`) || item.querySelector(".pos-pick"));
    if(target) target.focus();
  }
  el.posMenu.querySelector('[data-pos="delete"]').innerHTML =
    `<svg class="ic"><use href="#i-trash"/></svg>${list.length > 1 ? "Supprimer la position" : "Réinitialiser la position"}`;
}

// Appelé quand la position active change : on repart d'un état d'affichage propre.
function onSwitch(){
  highlightId = null;
  syncAsset();
  chart.restoreView(S().view);
  updateViewButtons();
  if(el.importDialog.open) el.importDialog.close("cancel");
}

function cyclePosition(delta){
  const list = store.positions;
  if(list.length < 2) return;
  const i = list.findIndex(p => p.id === store.activeId);
  const next = list[(i + delta + list.length) % list.length];
  store.switchTo(next.id);
  toast(`Position : ${next.name}`, { timeout: 1400 });
}

let posDialogMode = "new";
function openPosDialog(mode){
  posDialogMode = mode;
  const cur = S();
  el.posDialog.returnValue = "";
  if(mode === "new"){
    el.posDialogTitle.textContent = "Nouvelle position";
    el.posNameInput.value = "";
    el.posNameInput.placeholder = "ex : PEA – ETF Monde";
    el.posCopyRow.hidden = false;
    el.posCopyFrom.textContent = cur.name;
    el.posDialogHint.hidden = false;
    el.posDialogOk.textContent = "Créer";
  } else {
    el.posDialogTitle.textContent = "Renommer la position";
    el.posNameInput.value = cur.name;
    el.posNameInput.placeholder = cur.name;
    el.posCopyRow.hidden = true;
    el.posDialogHint.hidden = true;
    el.posDialogOk.textContent = "Renommer";
  }
  el.posDialog.showModal();
  el.posNameInput.focus();
  el.posNameInput.select();
}

function runPositionAction(action){
  const cur = S();
  switch(action){
    case "new": openPosDialog("new"); break;
    case "rename": openPosDialog("rename"); break;
    case "duplicate":
      store.duplicatePosition();
      toast(`Position dupliquée : « ${S().name} »`, { type: "success", timeout: 3000 });
      break;
    case "delete": {
      const only = store.positions.length === 1;
      if(only && !cur.transactions.length && cur.autoName) return;
      const token = store.deletePosition();
      toast(only ? `Position « ${cur.name} » réinitialisée` : `Position « ${cur.name} » supprimée`, {
        timeout: 10000,
        action: { label: "Annuler", fn: () => store.restorePosition(token) },
      });
      break;
    }
  }
}

function initPositions(){
  el.btnPosMenu.addEventListener("click", e => { e.stopPropagation(); toggleMenu(null, el.posMenu); });
  el.posMenu.querySelector(".menu-list").addEventListener("click", e => {
    const move = e.target.closest("button[data-move]");
    if(move){
      e.stopPropagation();
      store.movePosition(move.closest("[data-id]").dataset.id, Number(move.dataset.move));
      return;
    }
    const pick = e.target.closest(".pos-pick");
    if(pick){
      toggleMenu(false, el.posMenu);
      store.switchTo(pick.dataset.id);
      return;
    }
    const act = e.target.closest("button[data-pos]");
    if(act){
      toggleMenu(false, el.posMenu);
      runPositionAction(act.dataset.pos);
    }
  });
  el.posDialog.addEventListener("click", e => {
    if(e.target === el.posDialog || e.target.closest("[data-cancel]")) el.posDialog.close("cancel");
  });
  el.posDialog.addEventListener("close", () => {
    if(el.posDialog.returnValue !== "ok") return;
    const name = el.posNameInput.value;
    if(posDialogMode === "new"){
      store.createPosition({ name, copySettingsFrom: el.posCopySettings.checked ? store.activeId : null });
      toast(`Position « ${S().name} » créée`, { type: "success", timeout: 2500 });
      requestAnimationFrame(() => el.emptyState.querySelector('[data-empty="add"]').focus());
    } else {
      store.renamePosition(store.activeId, name);
    }
  });
}

/* =====================================================================
   Synchronisation état → interface
   ===================================================================== */

function updateUndoButtons(){
  el.btnUndo.disabled = !store.canUndo();
  el.btnRedo.disabled = !store.canRedo();
}

function refreshOutputs(){
  renderPositions();
  el.emptyState.classList.toggle("hidden", !!model);
  el.chartWrap.classList.toggle("is-empty", !model);
  renderKpis();
  renderLegend();
  updateUndoButtons();
  pushChart();
}

store.subscribe(kind => {
  if(kind === "none"){ updateUndoButtons(); return; }
  if(kind === "positions"){ renderPositions(); return; }
  if(kind === "switch") onSwitch();
  if(kind === "ui"){
    renderToggles(); applyPanelState(); renderChips(); renderLegend(); pushChart();
    return;
  }
  model = M.buildModel(S().transactions);
  if(kind === "soft"){
    refreshTxMeta();
    if(document.activeElement !== el.feeInput) renderSettings();
  } else {
    renderTxList(); renderChips(); renderSettings();
  }
  if(kind === "reset" && S().priceSource === "yahoo"){
    const t = S().assetTicker;
    if(t && (!assetData || assetData.ticker !== t)){ el.tickerInput.value = t; loadAsset(t, { silent: true }); }
    else if(!t && assetData){ assetData = null; assetState = { status: "idle" }; el.tickerInput.value = ""; renderAssetStatus(); }
  }
  refreshOutputs();
});

/* =====================================================================
   Démarrage
   ===================================================================== */

function init(){
  applyTheme();
  model = M.buildModel(S().transactions);
  chart.restoreView(S().view);

  // État replié / déplié des cartes, persistant.
  document.querySelectorAll("details.card[data-card]").forEach(card => {
    const name = card.dataset.card;
    if(name in G().ui.collapsed) card.open = !G().ui.collapsed[name];
    card.addEventListener("toggle", () => store.setUi(s => { s.ui.collapsed[name] = !card.open; }, "none"));
  });

  el.btnPanel.addEventListener("click", togglePanel);
  el.backdrop.addEventListener("click", () => setDrawer(false));
  el.btnUndo.addEventListener("click", () => store.undo());
  el.btnRedo.addEventListener("click", () => store.redo());
  el.btnTheme.addEventListener("click", cycleTheme);
  el.btnHelp.addEventListener("click", () => el.helpDialog.showModal());
  el.helpDialog.addEventListener("click", e => { if(e.target === el.helpDialog || e.target.closest("[data-close]")) el.helpDialog.close(); });
  el.importDialog.addEventListener("click", e => {
    if(e.target === el.importDialog || e.target.closest("[data-cancel]")) el.importDialog.close("cancel");
  });

  el.btnAddTx.addEventListener("click", addTransaction);
  el.btnImportOpen.addEventListener("click", () => openImport());
  el.txList.addEventListener("input", onTxInput);
  el.txList.addEventListener("change", onTxChange);
  el.txList.addEventListener("click", onTxClick);
  el.txList.addEventListener("keydown", onTxKeydown);
  el.txList.addEventListener("mouseover", e => { const r = e.target.closest(".tx-row"); setHighlight(r ? r.dataset.id : null); });
  el.txList.addEventListener("mouseleave", () => setHighlight(null));
  el.txList.addEventListener("focusin", e => { const r = e.target.closest(".tx-row"); if(r) setHighlight(r.dataset.id); });

  el.legend.addEventListener("click", e => {
    const b = e.target.closest("button.th");
    if(b) toggleThreshold(Number(b.dataset.v));
  });
  el.tglBands.addEventListener("click", () => toggleUi("showBands"));
  el.tglLabels.addEventListener("click", () => toggleUi("showLabels"));
  el.tglCandles.addEventListener("click", () => toggleUi("showCandles"));
  el.btnZoomIn.addEventListener("click", () => chart.zoomIn());
  el.btnZoomOut.addEventListener("click", () => chart.zoomOut());
  el.btnResetView.addEventListener("click", () => chart.resetView("both"));
  el.kpis.addEventListener("click", e => {
    if(e.target.closest('[data-action="asset"]')){
      ensurePanelVisible();
      const card = openCard("asset");
      requestAnimationFrame(() => { card.scrollIntoView({ block: "nearest", behavior: "smooth" }); el.tickerInput.focus(); });
    }
  });
  el.emptyState.addEventListener("click", e => {
    const b = e.target.closest("button[data-empty]");
    if(!b) return;
    if(b.dataset.empty === "add") addTransaction();
    else if(b.dataset.empty === "import") openImport();
    else runAction("sample");
  });

  initPositions();
  initThresholds();
  initSettings();
  initImportExport();
  initShortcuts();

  mqLight.addEventListener("change", () => { if(G().ui.theme === "auto"){ applyTheme(); renderChips(); renderLegend(); pushChart(); } });
  mqMobile.addEventListener("change", () => { setDrawer(false); applyPanelState(); });
  window.addEventListener("pagehide", () => store.flush());
  document.addEventListener("visibilitychange", () => { if(document.hidden) store.flush(); });

  renderTxList(); renderChips(); renderSettings(); renderToggles(); applyPanelState();
  initAsset();
  refreshOutputs();
  updateViewButtons();

  if(store.origin === "fresh"){
    toast("Bienvenue ! Un exemple est chargé : remplacez-le par vos propres transactions.", {
      timeout: 9000,
      action: { label: "Partir de zéro", fn: () => runAction("clear") },
    });
  } else if(store.origin === "v1"){
    toast("Vos données d'IRRViz v1 ont été reprises automatiquement.", { type: "success", timeout: 7000 });
  }
}

init();

})();
