/* =========================================================================
   Prix seuils de rendement — moteur de calcul + visualisation interactive
   100% local, sans dépendance externe.
   ========================================================================= */

(function(){
"use strict";

const DAY = 86400000;
const YEAR_DAYS = 365;

/* ---------------------------------------------------------------------
   Utilitaires dates
   --------------------------------------------------------------------- */

// Toutes les dates sont manipulées comme timestamps UTC "minuit" (nombre ms)
function ymdToMs(y, m, d){ return Date.UTC(y, m - 1, d); }

function isoToMs(iso){
  // "yyyy-mm-dd"
  const [y, m, d] = iso.split("-").map(Number);
  if(!y || !m || !d) return NaN;
  return ymdToMs(y, m, d);
}

function msToIso(ms){
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function frenchDateToMs(str){
  // "jj/mm/aaaa"
  const parts = str.trim().split(/[\/\-.]/);
  if(parts.length !== 3) return NaN;
  let [d, m, y] = parts.map(s => parseInt(s, 10));
  if(y < 100) y += 2000;
  if(!d || !m || !y) return NaN;
  return ymdToMs(y, m, d);
}

function msToFrLabel(ms, withYear){
  const d = new Date(ms);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const months = ["janv.","févr.","mars","avr.","mai","juin","juil.","août","sept.","oct.","nov.","déc."];
  const mm = months[d.getUTCMonth()];
  return withYear ? `${dd} ${mm} ${d.getUTCFullYear()}` : `${dd} ${mm}`;
}

function todayMs(){
  const n = new Date();
  return ymdToMs(n.getFullYear(), n.getMonth() + 1, n.getDate());
}

/* ---------------------------------------------------------------------
   Formatage
   --------------------------------------------------------------------- */

const fmtEUR = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
const fmtEUR0 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
// Prix unitaires (prix seuil, prix de marché estimé...) : toujours 3 décimales, utile pour les biens
// dont le prix unitaire est faible (ex: parts de fonds à quelques euros).
const fmtEUR3 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: 3, maximumFractionDigits: 3 });
const fmtNum = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 4 });
const fmtNum2 = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtPct(x){
  const s = (x >= 0 ? "+" : "") + fmtNum2.format(x);
  return `${s} %`;
}

/* ---------------------------------------------------------------------
   Palette rouge -> orange -> jaune -> vert -> sarcelle, cohérente et lisible.

   Contrairement à une palette divergente classique (RdYlGn) interpolée à espacement
   constant sur tout le domaine, les arrêts ci-dessous sont ancrés à des valeurs (%)
   précises plutôt qu'à des positions d'index régulières. Une palette à espacement
   constant place sa teinte la plus pâle/désaturée au CENTRE du domaine de couleur —
   qui tombe justement dans la zone 0-10% la plus utilisée (seuils par défaut : 0, 3, 6,
   10 %), rendant ces seuils quasi indiscernables. En ancrant des teintes très
   contrastées (orange / ambre / jaune / vert-jaune / vert) tous les 2 à 4 points dans
   cette zone sensible, deux seuils proches restent visuellement bien séparés.
   --------------------------------------------------------------------- */

const COLOR_STOPS = [
  { v: -20, hex: "#5c0f14" }, // rouge très sombre
  { v: -12, hex: "#96222a" }, // rouge
  { v: -6,  hex: "#c8452f" }, // rouge-orangé
  { v: -2,  hex: "#dd6a2e" },
  { v: 0,   hex: "#e88a1d" }, // orange vif — repère du seuil de rentabilité
  { v: 2,   hex: "#f0b429" }, // ambre
  { v: 4,   hex: "#f6d63c" }, // jaune
  { v: 6,   hex: "#cfe33c" }, // jaune-vert
  { v: 8,   hex: "#9fdb4d" }, // vert clair
  { v: 10,  hex: "#6fcf5a" }, // vert
  { v: 15,  hex: "#3fb968" },
  { v: 20,  hex: "#229c58" }, // vert soutenu
  { v: 30,  hex: "#0f7a53" }, // vert profond
  { v: 40,  hex: "#0a5a63" }, // sarcelle — rendement exceptionnel
];

function hexToRgb(hex){
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const COLOR_STOPS_RGB = COLOR_STOPS.map(s => hexToRgb(s.hex));

function lerp(a, b, t){ return a + (b - a) * t; }

function colorForReturn(pct){
  const n = COLOR_STOPS.length;
  if(pct <= COLOR_STOPS[0].v) return `rgb(${COLOR_STOPS_RGB[0].join(",")})`;
  if(pct >= COLOR_STOPS[n - 1].v) return `rgb(${COLOR_STOPS_RGB[n - 1].join(",")})`;
  for(let i = 0; i < n - 1; i++){
    const a = COLOR_STOPS[i], b = COLOR_STOPS[i + 1];
    if(pct >= a.v && pct <= b.v){
      const t = (pct - a.v) / (b.v - a.v);
      const ca = COLOR_STOPS_RGB[i], cb = COLOR_STOPS_RGB[i + 1];
      const r = Math.round(lerp(ca[0], cb[0], t));
      const g = Math.round(lerp(ca[1], cb[1], t));
      const b2 = Math.round(lerp(ca[2], cb[2], t));
      return `rgb(${r},${g},${b2})`;
    }
  }
  return `rgb(${COLOR_STOPS_RGB[n - 1].join(",")})`;
}

function colorForBandMid(v1, v2){
  return colorForReturn((v1 + v2) / 2);
}

/* ---------------------------------------------------------------------
   État applicatif + persistance locale
   --------------------------------------------------------------------- */

const STORAGE_KEY = "mwviz-state-v1";

const DEFAULT_SAMPLE = [
  { date: "01/01/2026", amount: -1000.00, quantity: 1000 },
  { date: "01/02/2026", amount: 500.00, quantity: -400 },
  { date: "01/03/2026", amount: 10.00, quantity: 0 },
  { date: "01/04/2026", amount: -500.00, quantity: 410 },
];

let state = {
  transactions: [], // {id, iso, amount, quantity}
  thresholds: [-10, 0, 3, 6, 10, 20, 35],
  feePercent: 0.35,
  horizonIso: null,
  // Zoom/positionnement du graphique choisi par l'utilisateur (molette, glisser), persisté pour
  // que la vue reste stable après un rechargement de page. `null` = vue automatique (par défaut).
  viewPersist: null, // { userZoomed, start, end, yUserZoomed, yMin, yMax }
};

let uidCounter = 1;
function nextId(){ return "t" + (uidCounter++); }

function makeTxFromSample(s){
  const [d, m, y] = s.date.split("/").map(Number);
  const iso = `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  return { id: nextId(), iso, amount: s.amount, quantity: s.quantity };
}

function loadDefaultSample(){
  state.transactions = DEFAULT_SAMPLE.map(makeTxFromSample);
  state.thresholds = [-10, 0, 3, 6, 10, 20, 35];
  state.feePercent = 0.35;
  state.horizonIso = null;
}

function saveState(){
  try{
    // Capture la vue courante (zoom/pan temps + prix) juste avant l'écriture, afin que
    // `state.viewPersist` soit toujours synchronisé avec les variables de vue en mémoire.
    state.viewPersist = (userZoomed || yUserZoomed) ? {
      userZoomed,
      start: view ? view.start : null,
      end: view ? view.end : null,
      yUserZoomed,
      yMin: yOverride ? yOverride.min : null,
      yMax: yOverride ? yOverride.max : null,
    } : null;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }catch(e){ /* ignore */ }
}

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return false;
    const parsed = JSON.parse(raw);
    if(!parsed || !Array.isArray(parsed.transactions)) return false;
    state = parsed;
    parsed.transactions.forEach(t => { if(!t.id) t.id = nextId(); });
    return true;
  }catch(e){ return false; }
}

// Réapplique le zoom/positionnement persisté (s'il existe) aux variables de vue en mémoire,
// AVANT le premier rendu — pour que `render()` ne les réinitialise pas à la vue automatique.
function restoreViewFromState(){
  const vp = state.viewPersist;
  if(!vp) return;
  if(vp.userZoomed && vp.start != null && vp.end != null){
    view = { start: vp.start, end: vp.end };
    userZoomed = true;
  }
  if(vp.yUserZoomed && vp.yMin != null && vp.yMax != null){
    yOverride = { min: vp.yMin, max: vp.yMax };
    yUserZoomed = true;
  }
}

/* ---------------------------------------------------------------------
   Modèle financier
   --------------------------------------------------------------------- */

function buildModel(){
  const tx = state.transactions
    .filter(t => t.iso && isFinite(t.amount) && isFinite(t.quantity))
    .map(t => ({ ms: isoToMs(t.iso), amount: Number(t.amount), quantity: Number(t.quantity), raw: t }))
    .filter(t => isFinite(t.ms))
    .sort((a, b) => a.ms - b.ms || 0);

  if(tx.length === 0) return null;

  const d0 = tx[0].ms;
  let cumQty = 0;
  const points = tx.map(t => {
    cumQty += t.quantity;
    return {
      ms: t.ms,
      amount: t.amount,
      quantity: t.quantity,
      cumQty,
      tau: (t.ms - d0) / DAY / YEAR_DAYS,
      raw: t.raw,
    };
  });

  const lastMs = points[points.length - 1].ms;
  return { d0, lastMs, points };
}

// Segmentation temporelle indépendante du seuil (dépend seulement du modèle + fenêtre visible)
function buildSegmentsMeta(model, viewStart, viewEnd, resolution){
  const pts = model.points;
  const segs = [];
  const totalSpan = Math.max(1, viewEnd - viewStart);

  for(let k = 0; k < pts.length; k++){
    const segStart = pts[k].ms;
    const segEnd = (k + 1 < pts.length) ? pts[k + 1].ms : viewEnd;
    if(segEnd < viewStart || segStart > viewEnd) continue;
    const cs = Math.max(segStart, viewStart);
    const ce = Math.min(segEnd, viewEnd);
    if(ce < cs) continue;

    const Q = pts[k].cumQty;
    const share = (ce - cs) / totalSpan;
    const nSamples = Math.max(2, Math.min(400, Math.round(resolution * share) + 2));
    const ts = [];
    for(let s = 0; s <= nSamples; s++){
      ts.push(cs + (ce - cs) * s / nSamples);
    }
    segs.push({
      k, start: cs, end: ce, Q,
      gap: Math.abs(Q) < 1e-9,
      ts,
    });
  }
  return segs;
}

// Sommes actualisées cumulées S_k = somme_{i<=k} amount_i * base^-tau_i, pour une base (1+x) donnée.
// Partagé par priceSeriesForThreshold et priceAtSingleDate pour éviter toute divergence de formule.
function discountedCumSums(model, base){
  const pts = model.points;
  const Sarr = new Array(pts.length);
  let running = 0;
  for(let i = 0; i < pts.length; i++){
    running += pts[i].amount * Math.pow(base, -pts[i].tau);
    Sarr[i] = running;
  }
  return Sarr;
}

// Résout le prix seuil P à partir de la somme actualisée S, de la quantité détenue Q,
// du facteur temps tau et du taux cible (base = 1+x). Seule implémentation de l'inversion XIRR.
function computePriceFromS(S, Q, tau, base, feeFrac){
  const F = -S * Math.pow(base, tau);
  let P = F / (Q * (1 - feeFrac));
  if(!isFinite(P) || P < 0) P = 0;
  return P;
}

// Calcule la série de prix seuil pour un rendement cible xPct, sur les segments donnés
function priceSeriesForThreshold(model, segmentsMeta, xPct, feeFrac){
  const xFrac = xPct / 100;
  const base = 1 + xFrac;
  if(base <= 0){
    return segmentsMeta.map(() => null);
  }
  const Sarr = discountedCumSums(model, base);

  return segmentsMeta.map(seg => {
    if(seg.gap) return null;
    const S = Sarr[seg.k];
    const Q = seg.Q;
    return seg.ts.map(t => {
      const tau = (t - model.d0) / DAY / YEAR_DAYS;
      return computePriceFromS(S, Q, tau, base, feeFrac);
    });
  });
}

// Prix implicite (brut, ramené au marché en ré-ajoutant les frais) d'une transaction réelle
function impliedMarketPrice(tx, feeFrac){
  if(tx.quantity === 0) return null;
  const q = Math.abs(tx.quantity);
  if(tx.amount < 0){
    // achat : cash sorti = q * prix * (1+fee)
    return Math.abs(tx.amount) / (q * (1 + feeFrac));
  } else {
    // vente : cash entré = q * prix * (1-fee)
    if(feeFrac >= 1) return null;
    return tx.amount / (q * (1 - feeFrac));
  }
}

/* ---------------------------------------------------------------------
   DOM refs
   --------------------------------------------------------------------- */

const el = {
  txBody: document.getElementById("txBody"),
  btnAddRow: document.getElementById("btnAddRow"),
  csvInput: document.getElementById("csvInput"),
  btnImport: document.getElementById("btnImport"),
  feeInput: document.getElementById("feeInput"),
  thresholdChips: document.getElementById("thresholdChips"),
  newThresholdInput: document.getElementById("newThresholdInput"),
  btnAddThreshold: document.getElementById("btnAddThreshold"),
  horizonInput: document.getElementById("horizonInput"),
  quickRange: document.getElementById("quickRange"),
  btnExample: document.getElementById("btnExample"),
  btnClear: document.getElementById("btnClear"),
  chartSvg: document.getElementById("chartSvg"),
  chartWrap: document.getElementById("chartWrap"),
  chartLegend: document.getElementById("chartLegend"),
  tooltip: document.getElementById("tooltip"),
  emptyState: document.getElementById("emptyState"),
  btnResetZoom: document.getElementById("btnResetZoom"),
  statPosition: document.getElementById("statPosition"),
  statInvested: document.getElementById("statInvested"),
  statCurrentPrice: document.getElementById("statCurrentPrice"),
};

const SVGNS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs){
  const e = document.createElementNS(SVGNS, tag);
  if(attrs) for(const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

/* ---------------------------------------------------------------------
   Rendu du tableau de transactions
   --------------------------------------------------------------------- */

function renderTxTable(){
  el.txBody.innerHTML = "";
  state.transactions.forEach(tx => {
    // Chaque transaction est une carte sur deux lignes : date + suppression, puis montant/quantité
    // côte à côte sur toute la largeur — évite que le champ Date (rendu natif large) n'écrase
    // l'espace disponible pour les champs Montant et Quantité.
    const row = document.createElement("div");
    row.className = "tx-row";

    const dateCell = document.createElement("div");
    dateCell.className = "tx-date-cell";
    const inDate = document.createElement("input");
    inDate.type = "date";
    inDate.value = tx.iso || "";
    inDate.addEventListener("change", () => { tx.iso = inDate.value; onDataChanged(); });
    dateCell.appendChild(inDate);

    const btnDel = document.createElement("button");
    btnDel.className = "row-del";
    btnDel.textContent = "✕";
    btnDel.title = "Supprimer cette transaction";
    btnDel.addEventListener("click", () => {
      state.transactions = state.transactions.filter(t => t.id !== tx.id);
      renderTxTable();
      onDataChanged();
    });

    const fields = document.createElement("div");
    fields.className = "tx-fields";

    const amtLabel = document.createElement("label");
    amtLabel.textContent = "Montant (€)";
    const inAmt = document.createElement("input");
    inAmt.type = "number"; inAmt.step = "0.01"; inAmt.inputMode = "decimal";
    inAmt.value = tx.amount;
    inAmt.addEventListener("input", () => { tx.amount = parseFloat(inAmt.value) || 0; onDataChanged(); });
    amtLabel.appendChild(inAmt);

    const qtyLabel = document.createElement("label");
    qtyLabel.textContent = "Quantité";
    const inQty = document.createElement("input");
    inQty.type = "number"; inQty.step = "any"; inQty.inputMode = "decimal";
    inQty.value = tx.quantity;
    inQty.addEventListener("input", () => { tx.quantity = parseFloat(inQty.value) || 0; onDataChanged(); });
    qtyLabel.appendChild(inQty);

    fields.appendChild(amtLabel); fields.appendChild(qtyLabel);

    row.appendChild(dateCell); row.appendChild(btnDel); row.appendChild(fields);
    el.txBody.appendChild(row);
  });
}

function addEmptyRow(){
  const last = state.transactions[state.transactions.length - 1];
  state.transactions.push({ id: nextId(), iso: last ? last.iso : msToIso(todayMs()), amount: 0, quantity: 0 });
  renderTxTable();
  onDataChanged();
}

function importCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  let added = 0;

  for (const line of lines) {
    // On teste les séparateurs possibles.
    // Le premier qui donne exactement 3 colonnes est retenu.
    const separators = [";", "\t", ","];
    let parts = null;

    for (const separator of separators) {
      const candidate = line
        .split(separator)
        .map(value => value.trim());

      if (candidate.length === 3) {
        parts = candidate;
        break;
      }
    }

    // La ligne doit contenir exactement 3 colonnes.
    if (!parts) continue;

    const [dateStr, amtStr, qtyStr] = parts;

    const ms = dateStr.includes("/")
      ? frenchDateToMs(dateStr)
      : isoToMs(dateStr);

    if (!Number.isFinite(ms)) continue;

    // Supprime :
    // - les espaces ordinaires
    // - les espaces insécables
    // - € et $
    const normalizedAmount = amtStr
      .replace(/[\s\u00A0€$]/g, "")
      .replace(",", ".");

    const normalizedQuantity = qtyStr
      .replace(/[\s\u00A0]/g, "")
      .replace(",", ".");

    const amount = Number.parseFloat(normalizedAmount);
    const quantity = Number.parseFloat(normalizedQuantity);

    if (
      !Number.isFinite(amount) ||
      !Number.isFinite(quantity)
    ) {
      continue;
    }

    state.transactions.push({
      id: nextId(),
      iso: msToIso(ms),
      amount,
      quantity
    });

    added++;
  }

  if (added) {
    renderTxTable();
    onDataChanged();
  }

  return added;
}

/* ---------------------------------------------------------------------
   Rendu des seuils (chips)
   --------------------------------------------------------------------- */

function sortedThresholds(){
  return [...state.thresholds].sort((a, b) => a - b);
}

function renderChips(){
  el.thresholdChips.innerHTML = "";
  sortedThresholds().forEach(val => {
    const chip = document.createElement("div");
    chip.className = "chip";

    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = colorForReturn(val);
    chip.appendChild(sw);

    const input = document.createElement("input");
    input.type = "number"; input.step = "0.5";
    input.value = val;
    input.addEventListener("change", () => {
      const idx = state.thresholds.indexOf(val);
      const nv = parseFloat(input.value);
      if(isFinite(nv) && idx >= 0){
        state.thresholds[idx] = nv;
        onDataChanged();
      }
    });
    chip.appendChild(input);

    const suf = document.createElement("span");
    suf.style.color = "var(--text-faint)"; suf.style.fontSize = "12px";
    suf.textContent = "%";
    chip.appendChild(suf);

    const del = document.createElement("button");
    del.className = "chip-del";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      state.thresholds = state.thresholds.filter(v => v !== val);
      onDataChanged();
    });
    chip.appendChild(del);

    el.thresholdChips.appendChild(chip);
  });
}

/* ---------------------------------------------------------------------
   Vue (zoom / pan) — domaine temporel affiché
   --------------------------------------------------------------------- */

let fullDomain = null; // {start, end}
let view = null;       // {start, end}
let userZoomed = false;

// Zoom vertical (prix) indépendant du zoom horizontal (temps). Quand null, l'échelle Y
// s'auto-ajuste aux courbes/transactions visibles ; quand défini par l'utilisateur (molette
// au-dessus de l'axe Y, ou Maj+molette), l'échelle reste fixe jusqu'à réinitialisation.
let yOverride = null; // {min, max}
let yUserZoomed = false;

// État de glisser (pan) — module-level car les listeners globaux ne sont attachés qu'une seule fois
// (voir setupGlobalChartInteraction) alors que mousedown est réattaché à chaque rendu sur l'overlay.
// Le glisser déplace le graphique dans les deux axes : temps (horizontal) ET prix (vertical).
let dragging = false, dragStartPx = 0, dragStartPy = 0, dragStartView = null, dragStartY = null;

function computeFullDomain(model){
  const horizon = state.horizonIso ? isoToMs(state.horizonIso) : (todayMs() + 365 * DAY);
  const end = Math.max(horizon, model.lastMs, todayMs());
  const pad = (end - model.d0) * 0.02;
  return { start: model.d0 - Math.max(pad, DAY), end: end + Math.max(pad, DAY) };
}

function resetView(){
  if(!fullDomain) return;
  view = { start: fullDomain.start, end: fullDomain.end };
  userZoomed = false;
  yOverride = null;
  yUserZoomed = false;
}

/* ---------------------------------------------------------------------
   Rendu du graphique
   --------------------------------------------------------------------- */

let lastModel = null;
let lastSegmentsMeta = null;
let lastCurves = null; // { pct: [ [values]|null per seg ] }
let lastLayout = null; // scales info for interaction
let currentMarkerHits = []; // {x, y, r, type, ms, amount, qty, price?} for hover hit-testing

function marginFor(width){
  return { top: 22, right: 64, bottom: 34, left: 74 };
}

function niceStep(range, targetTicks){
  const raw = range / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step;
  if(norm < 1.5) step = 1;
  else if(norm < 3.5) step = 2;
  else if(norm < 7.5) step = 5;
  else step = 10;
  return step * mag;
}

function render(){
  const model = buildModel();
  lastModel = model;

  if(!model){
    el.emptyState.classList.remove("hidden");
    el.chartSvg.innerHTML = "";
    el.chartLegend.innerHTML = "";
    el.statPosition.innerHTML = "";
    el.statInvested.innerHTML = "";
    el.statCurrentPrice.innerHTML = "";
    return;
  }
  el.emptyState.classList.add("hidden");

  fullDomain = computeFullDomain(model);
  if(!view || !userZoomed) view = { start: fullDomain.start, end: fullDomain.end };
  // clamp view within a reasonable outer bound
  const outerPad = (fullDomain.end - fullDomain.start) * 0.5;
  view.start = Math.max(fullDomain.start - outerPad, Math.min(view.start, fullDomain.end - DAY));
  view.end = Math.min(fullDomain.end + outerPad, Math.max(view.end, view.start + DAY * 3));

  const rect = el.chartWrap.getBoundingClientRect();
  const width = Math.max(200, rect.width);
  const height = Math.max(200, rect.height);
  const m = marginFor(width);
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;

  const feeFrac = (parseFloat(el.feeInput.value) || 0) / 100;
  const thresholds = sortedThresholds();

  const resolution = Math.max(60, Math.min(900, Math.round(plotW)));
  const segMeta = buildSegmentsMeta(model, view.start, view.end, resolution);
  lastSegmentsMeta = segMeta;

  const curves = {};
  thresholds.forEach(pct => {
    curves[pct] = priceSeriesForThreshold(model, segMeta, pct, feeFrac);
  });
  lastCurves = curves;

  // Domaine Y : auto-ajusté aux courbes visibles + prix des transactions visibles,
  // sauf si l'utilisateur a défini un zoom Y manuel (yOverride).
  let yMax = 0;
  thresholds.forEach(pct => {
    (curves[pct] || []).forEach(seg => {
      if(!seg) return;
      seg.forEach(v => { if(v > yMax) yMax = v; });
    });
  });
  const txPrices = [];
  model.points.forEach(p => {
    if(p.ms < view.start || p.ms > view.end) return;
    const price = impliedMarketPrice(p, feeFrac);
    if(price != null && isFinite(price)){ txPrices.push(price); if(price > yMax) yMax = price; }
  });
  if(yMax <= 0) yMax = 1;
  yMax *= 1.12;
  let yMin = 0;

  if(yUserZoomed && yOverride){
    yMin = yOverride.min;
    yMax = yOverride.max;
  }

  const xScale = t => m.left + (t - view.start) / (view.end - view.start) * plotW;
  const yScale = p => m.top + plotH - (p - yMin) / (yMax - yMin) * plotH;
  const xInv = px => view.start + (px - m.left) / plotW * (view.end - view.start);
  const yInv = py => yMin + (m.top + plotH - py) / plotH * (yMax - yMin);

  lastLayout = { m, plotW, plotH, width, height, xScale, yScale, xInv, yInv, yMax, yMin, feeFrac, thresholds };

  drawSvg(model, segMeta, curves, thresholds, lastLayout, txPrices);
  renderLegend(thresholds);
  renderStats(model, feeFrac);
}

function drawSvg(model, segMeta, curves, thresholds, layout, txPrices){
  const { m, plotW, plotH, width, height, xScale, yScale, yMax } = layout;
  const svg = el.chartSvg;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = "";

  const defs = svgEl("defs");
  svg.appendChild(defs);

  const gGrid = svgEl("g", { class: "grid" });
  const gBands = svgEl("g", { class: "bands" });
  const gAxes = svgEl("g", { class: "axes" });
  const gCurves = svgEl("g", { class: "curves" });
  const gMarkers = svgEl("g", { class: "markers" });
  // gPriceLabels / gHoverLabels ne sont PAS clippés à la zone de tracé (contrairement à gCurves) :
  // les étiquettes de prix doivent pouvoir déborder dans la marge droite sans être coupées.
  const gPriceLabels = svgEl("g", { class: "price-labels" });
  const gHoverLabels = svgEl("g", { class: "hover-labels" });
  const gInteract = svgEl("g", { class: "interact" });
  svg.appendChild(gGrid); svg.appendChild(gBands); svg.appendChild(gAxes); svg.appendChild(gCurves);
  svg.appendChild(gMarkers); svg.appendChild(gPriceLabels); svg.appendChild(gHoverLabels); svg.appendChild(gInteract);

  // clip path
  const clipId = "plotClip";
  const clip = svgEl("clipPath", { id: clipId });
  clip.appendChild(svgEl("rect", { x: m.left, y: m.top, width: plotW, height: plotH }));
  defs.appendChild(clip);
  gBands.setAttribute("clip-path", `url(#${clipId})`);
  gCurves.setAttribute("clip-path", `url(#${clipId})`);
  gMarkers.setAttribute("clip-path", `url(#${clipId})`);

  // ---- Grille horizontale (prix) ----
  const yStep = niceStep(yMax, 6);
  for(let v = 0; v <= yMax; v += yStep){
    const y = yScale(v);
    gGrid.appendChild(svgEl("line", { class: "gridline", x1: m.left, x2: m.left + plotW, y1: y, y2: y }));
  }

  // ---- Grille verticale (temps) + axe X ----
  const ticks = timeTicks(layout);
  ticks.forEach(tk => {
    const x = xScale(tk.ms);
    if(x < m.left - 1 || x > m.left + plotW + 1) return;
    gGrid.appendChild(svgEl("line", { class: "gridline", x1: x, x2: x, y1: m.top, y2: m.top + plotH }));
    const txt = svgEl("text", { x, y: m.top + plotH + 18, "text-anchor": "middle", class: "axis" });
    txt.textContent = tk.label;
    gAxes.appendChild(txt);
  });

  // ---- Axe Y labels ----
  for(let v = 0; v <= yMax; v += yStep){
    const y = yScale(v);
    const txt = svgEl("text", { x: m.left - 10, y: y + 4, "text-anchor": "end", class: "axis" });
    txt.textContent = fmtEUR0.format(v);
    gAxes.appendChild(txt);
  }

  // axis domain lines
  gAxes.appendChild(svgEl("line", { class: "axis", x1: m.left, x2: m.left, y1: m.top, y2: m.top + plotH, stroke: "#313a4d" }));
  gAxes.appendChild(svgEl("line", { class: "axis", x1: m.left, x2: m.left + plotW, y1: m.top + plotH, y2: m.top + plotH, stroke: "#313a4d" }));

  // ---- Ligne "aujourd'hui" ----
  const tMs = todayMs();
  const todayX = xScale(tMs);
  const todayVisible = todayX >= m.left && todayX <= m.left + plotW;
  if(todayVisible){
    gGrid.appendChild(svgEl("line", { class: "today-line", x1: todayX, x2: todayX, y1: m.top, y2: m.top + plotH }));
    const txt = svgEl("text", { x: todayX + 4, y: m.top + 12, class: "axis", fill: "#5ec8ff" });
    txt.textContent = "aujourd'hui";
    gAxes.appendChild(txt);
  }

  // ---- Bandes colorées entre seuils consécutifs ----
  const n = thresholds.length;
  for(let i = -1; i < n; i++){
    const lower = i >= 0 ? thresholds[i] : null;
    const upper = i + 1 < n ? thresholds[i + 1] : null;
    drawBand(gBands, segMeta, curves, lower, upper, layout, i, n);
  }

  // ---- Lignes de seuil ----
  thresholds.forEach(pct => {
    drawCurveLine(gCurves, segMeta, curves[pct], layout, colorForReturn(pct));
  });

  // ---- Étiquettes de prix sur la ligne "aujourd'hui" ----
  // (le survol utilise le même mécanisme dans un groupe séparé, voir attachInteraction)
  renderThresholdLabelsAtX(gPriceLabels, model, thresholds, layout, segMeta, curves, {
    dateMs: tMs, anchorX: todayX, visible: todayVisible, fallbackToEdge: true,
  });

  // ---- Marqueurs de transactions ----
  // Les marqueurs eux-mêmes ne reçoivent aucun événement (pointer-events:none) : c'est le seul
  // overlay (au premier plan) qui gère tout le survol, via un hit-test sur `currentMarkerHits`.
  // Cela évite les incohérences/clignotements liés à deux systèmes d'écoute superposés.
  currentMarkerHits = [];
  model.points.forEach(p => {
    const x = xScale(p.ms);
    if(x < m.left - 4 || x > m.left + plotW + 4) return;
    if(p.quantity === 0){
      const y = m.top + plotH;
      const tri = svgEl("path", {
        d: `M ${x - 5} ${y} L ${x + 5} ${y} L ${x} ${y - 9} Z`,
        fill: "#9aa4b8", opacity: 0.85, stroke: "#0c0e13", "stroke-width": 1,
        "pointer-events": "none",
      });
      gMarkers.appendChild(tri);
      currentMarkerHits.push({ x, y: y - 4, r: 8, type: "cash", ms: p.ms, amount: p.amount, qty: p.quantity });
    } else {
      const price = impliedMarketPrice(p, layout.feeFrac);
      if(price == null || !isFinite(price)) return;
      const y = yScale(Math.min(price, yMax));
      const isBuy = p.amount < 0;
      const c = svgEl("circle", {
        cx: x, cy: y, r: 4.5,
        fill: isBuy ? "#3ea86b" : "#e0665f",
        stroke: "#0c0e13", "stroke-width": 1.3,
        "pointer-events": "none",
      });
      gMarkers.appendChild(c);
      currentMarkerHits.push({ x, y, r: 7, type: "tx", ms: p.ms, amount: p.amount, qty: p.quantity, price });
    }
  });

  // ---- Couche d'interaction ----
  // L'overlay couvre TOUT le canevas SVG (pas seulement la zone de tracé) : les étiquettes de
  // survol/aujourd'hui peuvent déborder dans les marges, et si l'overlay s'arrêtait exactement au
  // bord du tracé, déplacer la souris vers une étiquette débordante déclenchait un "mouseleave"
  // (l'étiquette disparaissait juste avant de pouvoir la lire). `pointer-events:all` garantit la
  // capture des événements même sur un remplissage transparent, quel que soit le navigateur.
  const overlay = svgEl("rect", {
    x: 0, y: 0, width, height, fill: "transparent", "pointer-events": "all",
    id: "interactOverlay",
  });
  gInteract.appendChild(overlay);

  const crossX = svgEl("line", { class: "crosshair-line hidden", id: "crossX", y1: m.top, y2: m.top + plotH });
  const crossY = svgEl("line", { class: "crosshair-line hidden", id: "crossY", x1: m.left, x2: m.left + plotW });
  gInteract.appendChild(crossX); gInteract.appendChild(crossY);

  attachInteraction(overlay, crossX, crossY, layout, thresholds, model, segMeta, curves, gHoverLabels);
}

function lastSegValue(segMeta, curveSegs){
  for(let i = segMeta.length - 1; i >= 0; i--){
    const seg = curveSegs[i];
    if(seg && seg.length) return seg[seg.length - 1];
  }
  return null;
}

// Dessine, le long d'une ligne verticale ancrée à `opts.anchorX`, une étiquette de prix par seuil
// pour la date `opts.dateMs` — utilisé pour la ligne "aujourd'hui" (toujours visible, `gPriceLabels`)
// ET pour le survol (mis à jour en direct dans `gHoverLabels`, sans refaire tout le rendu —
// voir attachInteraction). `g` doit être un groupe NON clippé à la zone de tracé, car les
// étiquettes peuvent déborder dans la marge droite.
function renderThresholdLabelsAtX(g, model, thresholds, layout, segMeta, curves, opts){
  // Les étiquettes ne doivent jamais intercepter la souris : c'est l'overlay (couche d'interaction,
  // toujours au-dessus) qui gère seul tout le survol — voir attachInteraction.
  g.setAttribute("pointer-events", "none");
  const { m, plotW, yScale, yMax } = layout;
  const { dateMs, anchorX, visible, fallbackToEdge } = opts;

  const labelDefs = thresholds.map(pct => {
    const val = visible
      ? priceAtSingleDate(model, dateMs, pct, layout.feeFrac)
      : (fallbackToEdge ? lastSegValue(segMeta, curves[pct]) : null);
    if(val == null) return null;
    const yOrig = yScale(Math.min(val, yMax));
    return { pct, val, yOrig, y: yOrig, text: `${pct}% · ${fmtEUR3.format(val)}` };
  }).filter(Boolean);
  if(labelDefs.length === 0) return;

  // Évite que les étiquettes se recouvrent quand plusieurs seuils ont un prix proche :
  // ne déplace que la position verticale de l'étiquette (`y`), pas le repère sur la courbe (`yOrig`).
  declutterLabelsY(labelDefs, 15);

  const labelBoxH = 16;
  // Quand la ligne n'est pas visible et qu'on retombe sur le bord droit, les étiquettes s'ancrent
  // à la limite de la zone de tracé plutôt qu'à une position hors-écran.
  const effectiveAnchorX = visible ? anchorX : (fallbackToEdge ? m.left + plotW : anchorX);

  labelDefs.forEach(({ pct, y, yOrig, text }) => {
    const boxW = Math.max(58, text.length * 5.6 + 16);
    // Si l'ancrage est trop proche du bord droit, l'étiquette bascule à gauche pour rester visible.
    const flipLeft = effectiveAnchorX + 6 + boxW > m.left + plotW + 60;
    const boxX = flipLeft ? effectiveAnchorX - 6 - boxW : effectiveAnchorX + 6;
    const textX = flipLeft ? boxX + boxW - 6 : boxX + 6;
    const gItem = svgEl("g", {});
    // Ligne de rappel si le curseur déplacé (anti-collision) diffère du point réel sur la courbe.
    if(Math.abs(y - yOrig) > 1){
      gItem.appendChild(svgEl("line", {
        x1: effectiveAnchorX, y1: yOrig, x2: flipLeft ? boxX + boxW : boxX, y2: y,
        stroke: colorForReturn(pct), "stroke-width": 1, "stroke-opacity": 0.45,
      }));
    }
    const bg = svgEl("rect", { x: boxX, y: y - 9, width: boxW, height: labelBoxH, rx: 4, fill: "#11141bd9", stroke: colorForReturn(pct), "stroke-width": 1, "stroke-opacity": 0.55 });
    const txt = svgEl("text", { x: textX, y: y + 3, "text-anchor": flipLeft ? "end" : "start", class: "axis", fill: colorForReturn(pct), "font-weight": 600, "font-size": 10.5 });
    txt.textContent = text;
    gItem.appendChild(bg); gItem.appendChild(txt);
    g.appendChild(gItem);
  });

  if(visible){
    // petit repère sur chaque courbe, au niveau exact de la date ancrée
    labelDefs.forEach(({ pct, yOrig }) => {
      g.appendChild(svgEl("circle", { cx: effectiveAnchorX, cy: yOrig, r: 3, fill: colorForReturn(pct), stroke: "#0c0e13", "stroke-width": 1 }));
    });
  }
}

// Écarte verticalement les étiquettes (mutation de `item.y`, en pixels écran) qui se chevauchent,
// en conservant l'ordre. `item.yOrig` (le point réel sur la courbe) n'est pas modifié.
function declutterLabelsY(items, minGap){
  items.sort((a, b) => a.y - b.y);
  for(let i = 1; i < items.length; i++){
    if(items[i].y - items[i - 1].y < minGap){
      items[i].y = items[i - 1].y + minGap;
    }
  }
}

function drawBand(g, segMeta, curves, lower, upper, layout, bandIndex, n){
  const { xScale, yScale, yMax } = layout;
  const color = lower == null ? colorForReturn(upper - 8)
              : upper == null ? colorForReturn(lower + 8)
              : colorForBandMid(lower, upper);
  const isOuter = lower == null || upper == null;

  segMeta.forEach((seg, idx) => {
    if(seg.gap) return;
    const upVals = upper == null ? seg.ts.map(() => yMax) : curves[upper][idx];
    const loVals = lower == null ? seg.ts.map(() => 0) : curves[lower][idx];
    if(!upVals || !loVals) return;

    const pts = [];
    for(let i = 0; i < seg.ts.length; i++){
      pts.push([xScale(seg.ts[i]), yScale(Math.min(upVals[i], yMax))]);
    }
    for(let i = seg.ts.length - 1; i >= 0; i--){
      pts.push([xScale(seg.ts[i]), yScale(Math.min(loVals[i], yMax))]);
    }
    const d = "M " + pts.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" L ") + " Z";
    const path = svgEl("path", { d, fill: color, opacity: isOuter ? 0.35 : 0.55 });
    g.appendChild(path);
  });
}

function drawCurveLine(g, segMeta, curveSegs, layout, color){
  const { xScale, yScale, yMax } = layout;
  segMeta.forEach((seg, idx) => {
    const vals = curveSegs[idx];
    if(!vals) return;
    const pts = seg.ts.map((t, i) => `${xScale(t).toFixed(1)} ${yScale(Math.min(vals[i], yMax)).toFixed(1)}`);
    const path = svgEl("path", { d: "M " + pts.join(" L "), fill: "none", stroke: color, "stroke-width": 1.8, opacity: 0.95 });
    g.appendChild(path);
  });
}

function timeTicks(layout){
  const spanDays = (view.end - view.start) / DAY;
  const ticks = [];
  let d = new Date(view.start);
  let stepMonths;
  if(spanDays > 365 * 4) stepMonths = 12;
  else if(spanDays > 365 * 1.5) stepMonths = 6;
  else if(spanDays > 240) stepMonths = 3;
  else if(spanDays > 90) stepMonths = 1;
  else if(spanDays > 40) stepMonths = 0; // weekly handled below
  else stepMonths = 0;

  if(stepMonths > 0){
    let y = d.getUTCFullYear(), mo = d.getUTCMonth();
    // start at first tick month boundary
    let cur = ymdToMs(y, mo + 1, 1);
    while(cur < view.start) { mo++; if(mo>11){mo=0;y++;} cur = ymdToMs(y, mo+1, 1); }
    while(cur <= view.end){
      const withYear = (mo === 0) || ticks.length === 0;
      ticks.push({ ms: cur, label: msToFrLabel(cur, withYear) });
      mo += stepMonths; while(mo > 11){ mo -= 12; y++; }
      cur = ymdToMs(y, mo + 1, 1);
    }
  } else {
    const stepDays = spanDays > 20 ? 7 : (spanDays > 8 ? 2 : 1);
    let cur = Math.ceil(view.start / DAY) * DAY;
    while(cur <= view.end){
      ticks.push({ ms: cur, label: msToFrLabel(cur, false) });
      cur += stepDays * DAY;
    }
  }
  return ticks;
}

/* ---------------------------------------------------------------------
   Légende
   --------------------------------------------------------------------- */

function renderLegend(thresholds){
  el.chartLegend.innerHTML = "";
  thresholds.forEach(pct => {
    const item = document.createElement("div");
    item.className = "litem";
    const line = document.createElement("span");
    line.className = "lline";
    line.style.background = colorForReturn(pct);
    const label = document.createElement("span");
    label.textContent = `${pct}% / an`;
    item.appendChild(line); item.appendChild(label);
    el.chartLegend.appendChild(item);
  });
  const buy = document.createElement("div"); buy.className = "litem";
  buy.innerHTML = `<span style="width:9px;height:9px;border-radius:50%;background:#3ea86b;display:inline-block;"></span><span>Achat</span>`;
  const sell = document.createElement("div"); sell.className = "litem";
  sell.innerHTML = `<span style="width:9px;height:9px;border-radius:50%;background:#e0665f;display:inline-block;"></span><span>Vente</span>`;
  const cash = document.createElement("div"); cash.className = "litem";
  cash.innerHTML = `<span style="width:9px;height:9px;background:#9aa4b8;display:inline-block;clip-path:polygon(50% 0,0 100%,100% 100%);"></span><span>Flux (dividende/frais)</span>`;
  el.chartLegend.appendChild(buy); el.chartLegend.appendChild(sell); el.chartLegend.appendChild(cash);
}

/* ---------------------------------------------------------------------
   Statistiques bas de page
   --------------------------------------------------------------------- */

function renderStats(model, feeFrac){
  const lastPt = model.points[model.points.length - 1];
  const qty = lastPt.cumQty;
  let invested = 0;
  model.points.forEach(p => { invested += -p.amount; }); // net investi (positif si plus acheté que reçu)
  el.statPosition.innerHTML = `Quantité détenue : <b>${fmtNum.format(qty)}</b>`;
  el.statInvested.innerHTML = `Flux net cumulé : <b>${fmtEUR.format(-invested)}</b>`;

  if(Math.abs(qty) > 1e-9){
    const t = todayMs();
    // valeur au seuil 0% aujourd'hui = prix pour lequel rendement = 0
    const segMetaToday = buildSegmentsMeta(model, model.d0, Math.max(t, model.d0 + DAY), 4);
    const seriesZero = priceSeriesForThreshold(model, segMetaToday, 0, feeFrac);
    const p0 = lastSegValue(segMetaToday, seriesZero);
    el.statCurrentPrice.innerHTML = p0 != null ? `Prix "seuil de rentabilité" (0%) aujourd'hui : <b>${fmtEUR3.format(p0)}</b>` : "";
  } else {
    el.statCurrentPrice.innerHTML = `Position actuellement soldée`;
  }
}

/* ---------------------------------------------------------------------
   Interaction : hover / crosshair / tooltip / zoom / pan
   --------------------------------------------------------------------- */

function attachInteraction(overlay, crossX, crossY, layout, thresholds, model, segMeta, curves, gHoverLabels){
  const { m, plotW, plotH, xInv, yInv } = layout;

  // Trouve le marqueur le plus proche du curseur, dans son rayon de détection, s'il y en a un.
  // Toute la logique de survol (crosshair, zone, marqueur) passe par ce seul handler `onMove` —
  // évite les incohérences/clignotements d'avoir deux systèmes d'écoute superposés (overlay + marqueurs).
  function findNearestMarker(px, py){
    let best = null, bestDist = Infinity;
    for(const hit of currentMarkerHits){
      const dx = hit.x - px, dy = hit.y - py;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if(dist <= hit.r && dist < bestDist){ best = hit; bestDist = dist; }
    }
    return best;
  }

  function renderMarkerTooltip(hit){
    let html = `<div class="tt-date">${msToFrLabel(hit.ms, true)}</div>`;
    html += `<div class="tt-row"><span>Montant</span><span class="v">${fmtEUR.format(hit.amount)}</span></div>`;
    html += `<div class="tt-row"><span>Quantité</span><span class="v">${fmtNum.format(hit.qty)}</span></div>`;
    if(hit.type === "tx"){
      html += `<div class="tt-row"><span>Prix marché estimé</span><span class="v">${fmtEUR3.format(hit.price)}</span></div>`;
    } else {
      html += `<div class="tt-row"><span>Type</span><span class="v">Flux sans quantité</span></div>`;
    }
    el.tooltip.innerHTML = html;
  }

  // Les prix de chaque seuil ne sont plus listés dans l'infobulle : ils s'affichent le long
  // d'une ligne verticale de survol, exactement comme la ligne "aujourd'hui" toujours visible
  // (voir renderThresholdLabelsAtX). L'infobulle se limite à la date et au prix pointé par le curseur.
  function clearHoverLabels(){ gHoverLabels.innerHTML = ""; }

  function onMove(evt){
    const rect = overlay.ownerSVGElement.getBoundingClientRect();
    const scaleX = layout.width / rect.width, scaleY = layout.height / rect.height;
    const rawPx = (evt.clientX - rect.left) * scaleX;
    const rawPy = (evt.clientY - rect.top) * scaleY;

    // Indice visuel : survol de la colonne des étiquettes de l'axe Y (zoom vertical à la molette).
    overlay.style.cursor = (rawPx < m.left && rawPy >= m.top && rawPy <= m.top + plotH) ? "ns-resize" : "";

    // Le curseur peut sortir légèrement de la zone de tracé (marges où débordent les étiquettes de
    // prix, cf. renderThresholdLabelsAtX) : on borne la position plutôt que de masquer le survol —
    // sinon déplacer la souris vers une étiquette qui dépasse la faisait disparaître avant de
    // pouvoir la lire. Seul un vrai mouseleave (sortie complète du graphique) masque le survol.
    const px = Math.max(m.left, Math.min(m.left + plotW, rawPx));
    const py = Math.max(m.top, Math.min(m.top + plotH, rawPy));

    crossX.setAttribute("x1", px); crossX.setAttribute("x2", px);
    crossY.setAttribute("y1", py); crossY.setAttribute("y2", py);
    crossX.classList.remove("hidden"); crossY.classList.remove("hidden");

    const nearMarker = findNearestMarker(px, py);
    if(nearMarker){
      renderMarkerTooltip(nearMarker);
      clearHoverLabels();
      positionTooltip(evt, overlay.ownerSVGElement);
      return;
    }

    const ms = xInv(px);
    const price = yInv(py);

    clearHoverLabels();
    renderThresholdLabelsAtX(gHoverLabels, model, thresholds, layout, segMeta, curves, {
      dateMs: ms, anchorX: px, visible: true, fallbackToEdge: false,
    });

    el.tooltip.innerHTML = `
      <div class="tt-date">${msToFrLabel(Math.round(ms / DAY) * DAY, true)}</div>
      <div class="tt-row"><span>Prix pointé</span><span class="v">${fmtEUR3.format(price)}</span></div>
    `;
    positionTooltip(evt, overlay.ownerSVGElement);
  }

  function positionTooltip(evt, svgNode){
    const wrapRect = el.chartWrap.getBoundingClientRect();
    const x = evt.clientX - wrapRect.left;
    const y = evt.clientY - wrapRect.top;
    el.tooltip.style.left = x + "px";
    el.tooltip.style.top = y + "px";
    el.tooltip.classList.remove("hidden");
  }
  function hideTooltip(){ el.tooltip.classList.add("hidden"); }

  overlay.addEventListener("mousemove", onMove);
  overlay.addEventListener("mouseleave", () => {
    hideTooltip(); crossX.classList.add("hidden"); crossY.classList.add("hidden"); clearHoverLabels();
    overlay.style.cursor = "";
  });

  // Pan (drag) : seul mousedown est réattaché à chaque rendu, car l'overlay lui-même est recréé
  // (et donc son ancien listener détruit) à chaque appel de render(). Le suivi mousemove/mouseup
  // pendant le glisser est global et n'est enregistré qu'une seule fois — voir setupGlobalChartInteraction.
  overlay.addEventListener("mousedown", evt => {
    dragging = true;
    dragStartPx = evt.clientX;
    dragStartPy = evt.clientY;
    dragStartView = { start: view.start, end: view.end };
    // Capture l'échelle Y actuellement affichée (auto-ajustée ou déjà zoomée) comme point de départ du glisser.
    dragStartY = { min: layout.yMin, max: layout.yMax };
    el.chartSvg.classList.add("grabbing");
  });
}

// Écouteurs globaux (wheel sur le <svg> persistant, mousemove/mouseup sur window) : attachés UNE SEULE
// FOIS pour toute la durée de vie de l'app. Ils lisent toujours l'état courant (`view`, `lastLayout`)
// plutôt que des valeurs capturées, afin de rester valides après chaque re-rendu.
let globalInteractionReady = false;
function setupGlobalChartInteraction(){
  if(globalInteractionReady) return;
  globalInteractionReady = true;

  el.chartSvg.addEventListener("wheel", evt => {
    if(!lastLayout || !view) return;
    evt.preventDefault();
    const { m, plotW, plotH } = lastLayout;
    const rect = el.chartSvg.getBoundingClientRect();
    const scaleX = lastLayout.width / rect.width;
    const scaleY = lastLayout.height / rect.height;
    const px = (evt.clientX - rect.left) * scaleX;
    const py = (evt.clientY - rect.top) * scaleY;
    const factor = evt.deltaY > 0 ? 1.15 : 1 / 1.15;

    // Zoom vertical (prix) uniquement : molette au-dessus de la zone d'étiquettes de l'axe Y,
    // ou Maj+molette n'importe où sur le graphique.
    const overYAxisGutter = px < m.left;
    if(evt.shiftKey || overYAxisGutter){
      const clampedPy = Math.max(m.top, Math.min(m.top + plotH, py));
      const anchorPrice = lastLayout.yInv(clampedPy);
      const curMin = yUserZoomed && yOverride ? yOverride.min : lastLayout.yMin;
      const curMax = yUserZoomed && yOverride ? yOverride.max : lastLayout.yMax;
      let newMin = anchorPrice - (anchorPrice - curMin) * factor;
      let newMax = anchorPrice + (curMax - anchorPrice) * factor;
      newMin = Math.max(0, newMin);
      const minSpanY = Math.max(1, (curMax - curMin) * 0.02);
      if(newMax - newMin < minSpanY) newMax = newMin + minSpanY;
      yOverride = { min: newMin, max: newMax };
      yUserZoomed = true;
      scheduleViewRender();
      return;
    }

    // Zoom horizontal (temps)
    const anchorMs = lastLayout.xInv(Math.max(m.left, Math.min(m.left + plotW, px)));
    let newStart = anchorMs - (anchorMs - view.start) * factor;
    let newEnd = anchorMs + (view.end - anchorMs) * factor;
    const minSpan = 5 * DAY;
    if(newEnd - newStart < minSpan){
      const c = (newStart + newEnd) / 2;
      newStart = c - minSpan / 2; newEnd = c + minSpan / 2;
    }
    view.start = newStart; view.end = newEnd; userZoomed = true;
    scheduleViewRender();
  }, { passive: false });

  window.addEventListener("mousemove", evt => {
    if(!dragging || !lastLayout || !view) return;
    const rect = el.chartSvg.getBoundingClientRect();
    const scaleX = lastLayout.width / rect.width;
    const scaleY = lastLayout.height / rect.height;

    // Glisser horizontal (temps)
    const dxPx = (evt.clientX - dragStartPx) * scaleX;
    const dMs = -dxPx / lastLayout.plotW * (dragStartView.end - dragStartView.start);
    view.start = dragStartView.start + dMs;
    view.end = dragStartView.end + dMs;
    userZoomed = true;

    // Glisser vertical (prix) : le contenu suit le curseur, comme l'axe temps.
    const dyPx = (evt.clientY - dragStartPy) * scaleY;
    const ySpan = dragStartY.max - dragStartY.min;
    let newYMin = dragStartY.min + dyPx / lastLayout.plotH * ySpan;
    let newYMax = dragStartY.max + dyPx / lastLayout.plotH * ySpan;
    if(newYMin < 0){ newYMax -= newYMin; newYMin = 0; }
    yOverride = { min: newYMin, max: newYMax };
    yUserZoomed = true;

    scheduleViewRender();
  });

  window.addEventListener("mouseup", () => {
    if(dragging){ dragging = false; el.chartSvg.classList.remove("grabbing"); flushViewSave(); }
  });
}

// Calcule le prix seuil pour UNE date précise et UN seuil (utilisé pour le tooltip, précision exacte).
// Réutilise exactement la même formule (discountedCumSums + computePriceFromS) que priceSeriesForThreshold
// afin que le tooltip ne puisse jamais diverger des courbes affichées.
function priceAtSingleDate(model, ms, xPct, feeFrac){
  if(ms < model.d0) return null;
  const pts = model.points;
  let k = -1;
  for(let i = 0; i < pts.length; i++){ if(pts[i].ms <= ms) k = i; else break; }
  if(k < 0) return null;
  const Q = pts[k].cumQty;
  if(Math.abs(Q) < 1e-9) return null;
  const xFrac = xPct / 100;
  const base = 1 + xFrac;
  if(base <= 0) return null;
  const Sarr = discountedCumSums(model, base);
  const tauT = (ms - model.d0) / DAY / YEAR_DAYS;
  return computePriceFromS(Sarr[k], Q, tauT, base, feeFrac);
}

/* ---------------------------------------------------------------------
   Câblage des contrôles
   --------------------------------------------------------------------- */

let renderScheduled = false;
function onDataChanged(){
  saveState();
  if(renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { renderScheduled = false; render(); });
}

// Utilisé pour les interactions continues (molette, glisser) : coalesce les appels à render()
// à une fois par frame d'affichage, évitant les reconstructions DOM en rafale qui provoquent
// des clignotements pendant le zoom/pan.
let viewRenderScheduled = false;
function scheduleViewRender(){
  if(viewRenderScheduled) return;
  viewRenderScheduled = true;
  requestAnimationFrame(() => { viewRenderScheduled = false; render(); });
  scheduleViewSave();
}

// Persiste le zoom/positionnement choisi dans localStorage, avec un léger anti-rebond : l'écriture
// synchrone dans localStorage à chaque frame pendant un glisser/zoom continu pourrait saccader
// l'interaction, donc on n'écrit qu'une fois l'utilisateur immobile ~300ms (ou au relâchement).
let viewSaveTimer = null;
function scheduleViewSave(){
  if(viewSaveTimer) clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(() => { viewSaveTimer = null; saveState(); }, 300);
}
function flushViewSave(){
  if(viewSaveTimer){ clearTimeout(viewSaveTimer); viewSaveTimer = null; }
  saveState();
}

function initControls(){
  el.btnAddRow.addEventListener("click", addEmptyRow);
  el.btnImport.addEventListener("click", () => {
    const n = importCsv(el.csvInput.value);
    if(n > 0) el.csvInput.value = "";
  });
  el.feeInput.addEventListener("input", onDataChanged);
  el.feeInput.addEventListener("change", () => { state.feePercent = parseFloat(el.feeInput.value) || 0; saveState(); });

  el.btnAddThreshold.addEventListener("click", () => {
    const v = parseFloat(el.newThresholdInput.value);
    if(isFinite(v) && !state.thresholds.includes(v)){
      state.thresholds.push(v);
      el.newThresholdInput.value = "";
      renderChips();
      onDataChanged();
    }
  });
  el.newThresholdInput.addEventListener("keydown", evt => {
    if(evt.key === "Enter") el.btnAddThreshold.click();
  });

  el.horizonInput.addEventListener("change", () => {
    state.horizonIso = el.horizonInput.value || null;
    userZoomed = false;
    onDataChanged();
  });

  el.quickRange.addEventListener("click", evt => {
    const btn = evt.target.closest("button");
    if(!btn) return;
    const years = Number(btn.dataset.y);
    const base = todayMs();
    const target = years > 0 ? base + years * 365 * DAY : base;
    state.horizonIso = msToIso(target);
    el.horizonInput.value = state.horizonIso;
    userZoomed = false;
    onDataChanged();
  });

  el.btnExample.addEventListener("click", () => {
    loadDefaultSample();
    renderAll();
    saveState();
  });
  el.btnClear.addEventListener("click", () => {
    if(state.transactions.length && !confirm("Effacer toutes les transactions ?")) return;
    state.transactions = [];
    renderAll();
    saveState();
  });

  el.btnResetZoom.addEventListener("click", () => {
    resetView();
    render();
    flushViewSave();
  });

  window.addEventListener("resize", () => onDataChanged());
  if(window.ResizeObserver){
    new ResizeObserver(() => onDataChanged()).observe(el.chartWrap);
  }
}

function renderAll(){
  renderTxTable();
  renderChips();
  el.feeInput.value = state.feePercent;
  el.horizonInput.value = state.horizonIso || msToIso(todayMs() + 365 * DAY);
  render();
}

/* ---------------------------------------------------------------------
   Démarrage
   --------------------------------------------------------------------- */

function init(){
  const hadSaved = loadState();
  if(!hadSaved || state.transactions.length === 0){
    loadDefaultSample();
  }
  restoreViewFromState();
  initControls();
  setupGlobalChartInteraction();
  renderAll();
}

document.addEventListener("DOMContentLoaded", init);

})();
