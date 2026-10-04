/* =========================================================================
   IRRViz 2 — modèle financier.

   Principe (identique à IRRViz v1) : pour un rendement annuel cible x, le prix
   seuil P(t) est le prix de marché auquel il faudrait revendre TOUTE la position
   détenue à la date t pour que le TRI (XIRR) de l'ensemble des flux soit x :

       Σ amount_i · (1+x)^-τ_i  +  P · Q · (1 - frais) · (1+x)^-τ_t  =  0

   Les montants saisis sont nets (frais déjà inclus) ; la vente hypothétique
   supporte les frais de sortie, d'où le facteur (1 - frais).
   ========================================================================= */

(function(root){
"use strict";

const IRR = root.IRR = root.IRR || {};
const U = IRR.util || (typeof require !== "undefined" ? require("./util.js") : null);
const { DAY, YEAR_DAYS, isoToMs } = U;
const EPS_QTY = 1e-9;

function buildModel(transactions){
  const tx = (transactions || [])
    .map(t => ({ ms: isoToMs(t.iso), amount: Number(t.amount), quantity: Number(t.quantity), id: t.id }))
    .filter(t => Number.isFinite(t.ms) && Number.isFinite(t.amount) && Number.isFinite(t.quantity))
    .sort((a, b) => a.ms - b.ms);
  if(tx.length === 0) return null;

  const d0 = tx[0].ms;
  let cumQty = 0;
  const points = tx.map(t => {
    cumQty += t.quantity;
    if(Math.abs(cumQty) < EPS_QTY) cumQty = 0;
    return { ...t, cumQty, tau: (t.ms - d0) / DAY / YEAR_DAYS };
  });
  return { d0, lastMs: points[points.length - 1].ms, points };
}

function tauOf(model, ms){ return (ms - model.d0) / DAY / YEAR_DAYS; }

// Dernier indice k tel que points[k].ms <= ms (recherche dichotomique), -1 si aucun.
function indexAt(model, ms){
  const pts = model.points;
  let lo = 0, hi = pts.length - 1, k = -1;
  while(lo <= hi){
    const mid = (lo + hi) >> 1;
    if(pts[mid].ms <= ms){ k = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return k;
}

// S_k = Σ_{i<=k} amount_i · base^-τ_i
function discountedCumSums(model, base){
  const pts = model.points;
  const out = new Array(pts.length);
  let running = 0;
  for(let i = 0; i < pts.length; i++){
    running += pts[i].amount * Math.pow(base, -pts[i].tau);
    out[i] = running;
  }
  return out;
}

function computePriceFromS(S, Q, tau, base, feeFrac){
  const F = -S * Math.pow(base, tau);
  const P = F / (Q * (1 - feeFrac));
  return (Number.isFinite(P) && P > 0) ? P : 0;
}

// Renvoie une fonction ms -> prix seuil (ou null si aucune position détenue à cette date).
function makePricer(model, pct, feeFrac){
  const base = 1 + pct / 100;
  if(!(base > 0)) return () => null;
  const sums = discountedCumSums(model, base);
  return ms => {
    const k = indexAt(model, ms);
    if(k < 0) return null;
    const Q = model.points[k].cumQty;
    if(Math.abs(Q) < EPS_QTY) return null;
    return computePriceFromS(sums[k], Q, tauOf(model, ms), base, feeFrac);
  };
}

// Découpe la fenêtre visible en segments de quantité constante, échantillonnés pour le tracé.
function buildSegments(model, viewStart, viewEnd, resolution){
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
    const n = Math.max(2, Math.min(400, Math.round(resolution * (ce - cs) / totalSpan) + 2));
    const ts = [];
    for(let s = 0; s <= n; s++) ts.push(cs + (ce - cs) * s / n);
    segs.push({ k, start: cs, end: ce, Q, gap: Math.abs(Q) < EPS_QTY, ts });
  }
  return segs;
}

function seriesForSegments(model, segs, pct, feeFrac){
  const base = 1 + pct / 100;
  if(!(base > 0)) return segs.map(() => null);
  const sums = discountedCumSums(model, base);
  return segs.map(seg => {
    if(seg.gap) return null;
    const S = sums[seg.k];
    return seg.ts.map(t => computePriceFromS(S, seg.Q, tauOf(model, t), base, feeFrac));
  });
}

// Prix unitaire implicite d'une transaction (montant net / quantité).
function impliedPrice(tx){
  if(!tx.quantity) return null;
  return Math.abs(tx.amount) / Math.abs(tx.quantity);
}

function txKind(tx){
  if(!tx.quantity) return tx.amount >= 0 ? "income" : "cost";
  return tx.quantity > 0 ? "buy" : "sell";
}

/* ---------------------------------------------------------------------
   TRI (XIRR) : rendement annualisé obtenu si l'on revendait toute la
   position au prix `price` à la date `ms` (net de frais de sortie).
   Si la position est soldée à cette date, c'est le TRI réalisé.
   Résolution : balayage en log(1+x) pour encadrer la racine la plus proche
   de 0 %, puis dichotomie. Renvoie un pourcentage, ou null si indéterminé.
   --------------------------------------------------------------------- */

function irrForSale(model, ms, price, feeFrac){
  const k = indexAt(model, ms);
  if(k < 0) return null;
  const pts = model.points;
  const Q = pts[k].cumQty;
  const saleNet = Math.abs(Q) < EPS_QTY ? 0 : price * Q * (1 - feeFrac);
  const tauT = tauOf(model, ms);

  const f = r => {
    let s = saleNet * Math.exp(-r * tauT);
    for(let i = 0; i <= k; i++) s += pts[i].amount * Math.exp(-r * pts[i].tau);
    return s;
  };

  const R_MIN = Math.log(0.0005), R_MAX = Math.log(101); // -99,95 % … +10 000 %
  const N = 240;
  let best = null;
  let prevR = R_MIN, prevF = f(R_MIN);
  for(let i = 1; i <= N; i++){
    const r = R_MIN + (R_MAX - R_MIN) * i / N;
    const fr = f(r);
    if(prevF === 0){ best = best || [prevR, prevR]; }
    if(Number.isFinite(prevF) && Number.isFinite(fr) && prevF * fr < 0){
      const mid = (prevR + r) / 2;
      if(!best || Math.abs(mid) < Math.abs((best[0] + best[1]) / 2)) best = [prevR, r];
    }
    prevR = r; prevF = fr;
  }
  if(!best) return null;
  let [a, b] = best;
  let fa = f(a);
  for(let it = 0; it < 70 && b - a > 1e-12; it++){
    const mid = (a + b) / 2;
    const fm = f(mid);
    if(fm === 0){ a = b = mid; break; }
    if(fa * fm < 0) b = mid; else { a = mid; fa = fm; }
  }
  return (Math.exp((a + b) / 2) - 1) * 100;
}

/* ---------------------------------------------------------------------
   Synthèse de position à une date donnée
   --------------------------------------------------------------------- */

function positionSummary(model, ms){
  const k = indexAt(model, ms);
  const out = { qty: 0, netFlow: 0, bought: 0, sold: 0, income: 0, costs: 0, count: k + 1 };
  for(let i = 0; i <= k; i++){
    const p = model.points[i];
    out.netFlow += p.amount;
    const kind = txKind(p);
    if(kind === "buy") out.bought += -p.amount;
    else if(kind === "sell") out.sold += p.amount;
    else if(kind === "income") out.income += p.amount;
    else out.costs += -p.amount;
  }
  out.qty = k >= 0 ? model.points[k].cumQty : 0;
  return out;
}

IRR.model = {
  EPS_QTY,
  buildModel, tauOf, indexAt, discountedCumSums, computePriceFromS, makePricer,
  buildSegments, seriesForSegments, impliedPrice, txKind, irrForSale, positionSummary,
};

if(typeof module !== "undefined" && module.exports) module.exports = IRR.model;

})(typeof window !== "undefined" ? window : globalThis);
