/* =========================================================================
   IRRViz 2 — asset optionnel : bougies OHLC Yahoo Finance via le proxy local.
   Yahoo Finance n'envoie pas d'en-tête CORS : le navigateur passe donc par
   `proxy.py` (127.0.0.1, port 8765 par défaut, configurable dans l'interface).

   Les cours déjà connus (téléchargés ici ou reçus par synchronisation) ne sont
   pas retéléchargés : seules les périodes manquantes sont demandées, avec
   quelques jours de recouvrement pour corriger la dernière séance (partielle
   si elle a été lue en cours de bourse).
   ========================================================================= */

(function(root){
"use strict";

const IRR = root.IRR = root.IRR || {};
const U = IRR.util || (typeof require !== "undefined" ? require("./util.js") : null);
const { DAY } = U;
const DAY_S = 86400;
const OVERLAP_DAYS = 7;          // séances déjà connues retéléchargées à la fin du cache
const ANOMALY_RATIO = 0.05;      // écart de clôture au-delà duquel tout l'historique est relu

function assetError(code, message){
  const e = new Error(message);
  e.code = code;
  return e;
}

function proxyBase(port){ return `http://127.0.0.1:${port}`; }

function withTimeout(ms){
  if(typeof AbortController === "undefined") return {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  if(timer && timer.unref) timer.unref(); // Node (tests) : ne retient pas le processus
  return { signal: ctrl.signal };
}

async function checkProxy(port){
  try{
    const res = await root.fetch(`${proxyBase(port)}/health`, withTimeout(1500));
    return res.ok;
  }catch(e){
    return false;
  }
}

// Période couverte : un mois avant la première transaction → un mois après l'horizon.
function fetchRange(transactions, horizonIso, today = U.todayMs()){
  const dates = transactions.map(t => U.isoToMs(t.iso)).filter(Number.isFinite);
  const minMs = dates.length ? Math.min(...dates) : today - 365 * DAY;
  const horizon = U.isoToMs(horizonIso || "");
  const maxMs = Math.max(today, Number.isFinite(horizon) ? horizon : today + 365 * DAY);
  return {
    period1: Math.floor((minMs - 30 * DAY) / 1000),
    period2: Math.floor(Math.min(maxMs + 30 * DAY, today + 2 * DAY) / 1000),
  };
}

/* Télécharge les séances de `period1` à `period2` (secondes ; par défaut toute la
   période utile de la position). Renvoie { ticker, candles, splits, currency, name,
   exchange } où splits = [{ ms, ratio }] : divisions d'actions de la période (Yahoo
   ramène tout l'historique à la nouvelle échelle). Erreur `code` : proxy | notfound | empty. */
async function fetchCandles({ ticker, port, transactions = [], horizonIso = null, period1 = null, period2 = null }){
  const sym = (ticker || "").trim().toUpperCase();
  if(period1 == null || period2 == null) ({ period1, period2 } = fetchRange(transactions, horizonIso));
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${period1}&period2=${period2}&interval=1d&events=split`;
  let res;
  try{
    res = await root.fetch(`${proxyBase(port)}/?url=${encodeURIComponent(yahooUrl)}`, withTimeout(25000));
  }catch(e){
    throw assetError("proxy", `Proxy local injoignable sur le port ${port}. Lancez « python proxy.py » puis réessayez.`);
  }
  let data = null;
  try{ data = await res.json(); }catch(e){ /* corps non JSON */ }
  const chart = data && data.chart;
  if(!res.ok || !chart || !chart.result || !chart.result[0]){
    const desc = chart && chart.error && chart.error.description;
    if(res.status === 404 || /No data found|delisted/i.test(desc || "")){
      throw assetError("notfound", `Symbole « ${sym} » introuvable sur Yahoo Finance.`);
    }
    throw new Error(desc || `Réponse inattendue (HTTP ${res.status}).`);
  }
  const result = chart.result[0];
  const ts = result.timestamp || [];
  const q = result.indicators && result.indicators.quote && result.indicators.quote[0];
  if(!q || !ts.length) throw assetError("empty", "Aucune cotation disponible sur la période.");
  const gmt = (result.meta && result.meta.gmtoffset) || 0;
  const dayOf = s => { const d = new Date((s + gmt) * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
  const candles = [];
  for(let i = 0; i < ts.length; i++){
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if(o == null || h == null || l == null || c == null) continue;
    // On ramène l'horodatage au minuit UTC du jour de cotation (cohérent avec le reste de l'app).
    candles.push({ ms: dayOf(ts[i]), open: o, high: h, low: l, close: c });
  }
  if(!candles.length) throw assetError("empty", "Aucune bougie OHLC exploitable.");
  candles.sort((a, b) => a.ms - b.ms);
  // Dédoublonne (certains marchés renvoient deux points pour la séance du jour).
  const dedup = candles.filter((c, i) => i === candles.length - 1 || candles[i + 1].ms !== c.ms);
  const meta = result.meta || {};
  const splitEvents = (result.events && result.events.splits) || {};
  const splits = Object.values(splitEvents)
    .map(e => ({ ms: dayOf(e.date), ratio: e.numerator / e.denominator }))
    .filter(sp => Number.isFinite(sp.ms) && sp.ratio > 0 && Number.isFinite(sp.ratio) && sp.ratio !== 1);
  return {
    ticker: sym,
    candles: dedup,
    splits,
    currency: meta.currency || null,
    name: meta.longName || meta.shortName || null,
    exchange: meta.fullExchangeName || meta.exchangeName || null,
  };
}

/* Périodes à télécharger compte tenu des cours déjà connus.
   cache : { from (s), candles } | null ; target : { period1, period2 } (s).
   - rien en cache : toute la période ;
   - avant : si la période utile commence avant ce qui a déjà été demandé (transaction plus ancienne) ;
   - après : depuis la dernière séance connue moins OVERLAP_DAYS, jusqu'à la fin. */
function planFetch(cache, target){
  if(!cache || !cache.candles || !cache.candles.length) return [{ period1: target.period1, period2: target.period2, kind: "full" }];
  const first = Math.floor(cache.candles[0].ms / 1000);
  const last = Math.floor(cache.candles[cache.candles.length - 1].ms / 1000);
  const from = Math.min(Number.isFinite(cache.from) ? cache.from : first, first);
  const ranges = [];
  if(target.period1 < from - DAY_S) ranges.push({ period1: target.period1, period2: from + DAY_S, kind: "before" });
  const start = Math.max(last - OVERLAP_DAYS * DAY_S, target.period1);
  if(target.period2 > start) ranges.push({ period1: start, period2: target.period2, kind: "after" });
  return ranges;
}

/* Écart anormal entre séances téléchargées et séances connues (ajustement rétroactif
   de Yahoo non signalé comme division) : la dernière séance connue, peut-être lue en
   cours de bourse, n'est pas comparée. */
function hasAnomaly(cached, fresh){
  if(!cached || cached.length < 2) return false;
  const known = new Map(cached.slice(0, -1).map(c => [c.ms, c.close]));
  return fresh.some(c => {
    const k = known.get(c.ms);
    return k > 0 && Math.abs(c.close / k - 1) > ANOMALY_RATIO;
  });
}

/* Complète les cours d'une position : télécharge seulement ce qui manque.
   Renvoie { ticker, candles (séances reçues), splits, currency, name, exchange, from (s), reloaded }.
   Les séances reçues sont ensuite fusionnées avec le cache (store.writeCandleCache),
   qui garde toute séance absente de la réponse. */
async function updateSeries({ ticker, port, cache = null, transactions = [], horizonIso = null, today = U.todayMs() }){
  const target = fetchRange(transactions, horizonIso, today);
  const ranges = planFetch(cache, target);
  let candles = [], splits = [], meta = null;
  for(const r of ranges){
    try{
      const res = await fetchCandles({ ticker, port, period1: r.period1, period2: r.period2 });
      candles = candles.concat(res.candles);
      splits = splits.concat(res.splits);
      meta = res;
    }catch(e){
      // Avec des cours connus, une période sans cotation (avant l'introduction en bourse, marché fermé) n'est pas une erreur.
      if(e.code === "empty" && cache) continue;
      throw e;
    }
  }
  let reloaded = false;
  if(cache && !splits.length && hasAnomaly(cache.candles, candles)){
    const full = await fetchCandles({ ticker, port, period1: target.period1, period2: target.period2 });
    candles = full.candles;
    splits = full.splits;
    meta = full;
    reloaded = true;
  }
  const byMs = new Map(candles.map(c => [c.ms, c]));
  return {
    ticker: (ticker || "").trim().toUpperCase(),
    candles: [...byMs.values()].sort((a, b) => a.ms - b.ms),
    splits,
    currency: meta ? meta.currency : null,
    name: meta ? meta.name : null,
    exchange: meta ? meta.exchange : null,
    from: Math.min(target.period1, cache && Number.isFinite(cache.from) ? cache.from : Infinity),
    reloaded,
  };
}

IRR.asset = { checkProxy, fetchCandles, fetchRange, planFetch, hasAnomaly, updateSeries };

if(typeof module !== "undefined" && module.exports) module.exports = IRR.asset;

})(typeof window !== "undefined" ? window : globalThis);
