/* =========================================================================
   IRRViz 2 — asset optionnel : bougies OHLC Yahoo Finance via le proxy local.
   Yahoo Finance n'envoie pas d'en-tête CORS : le navigateur passe donc par
   `proxy.py` (127.0.0.1, port 8765 par défaut, configurable dans l'interface).
   ========================================================================= */

(function(root){
"use strict";

const IRR = root.IRR = root.IRR || {};
const U = IRR.util;
const { DAY } = U;

function proxyBase(port){ return `http://127.0.0.1:${port}`; }

function withTimeout(ms){
  if(typeof AbortController === "undefined") return {};
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal };
}

async function checkProxy(port){
  try{
    const res = await fetch(`${proxyBase(port)}/health`, withTimeout(1500));
    return res.ok;
  }catch(e){
    return false;
  }
}

// Période couverte : un mois avant la première transaction → un mois après l'horizon.
function fetchRange(transactions, horizonIso){
  const today = U.todayMs();
  const dates = transactions.map(t => U.isoToMs(t.iso)).filter(Number.isFinite);
  const minMs = dates.length ? Math.min(...dates) : today - 365 * DAY;
  const horizon = U.isoToMs(horizonIso || "");
  const maxMs = Math.max(today, Number.isFinite(horizon) ? horizon : today + 365 * DAY);
  return {
    period1: Math.floor((minMs - 30 * DAY) / 1000),
    period2: Math.floor(Math.min(maxMs + 30 * DAY, today + 2 * DAY) / 1000),
  };
}

async function fetchCandles({ ticker, port, transactions, horizonIso }){
  const sym = (ticker || "").trim().toUpperCase();
  const { period1, period2 } = fetchRange(transactions, horizonIso);
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${period1}&period2=${period2}&interval=1d&events=history`;
  let res;
  try{
    res = await fetch(`${proxyBase(port)}/?url=${encodeURIComponent(yahooUrl)}`, withTimeout(25000));
  }catch(e){
    const err = new Error(`Proxy local injoignable sur le port ${port}. Lancez « python proxy.py » puis réessayez.`);
    err.code = "proxy";
    throw err;
  }
  let data = null;
  try{ data = await res.json(); }catch(e){ /* corps non JSON */ }
  const chart = data && data.chart;
  if(!res.ok || !chart || !chart.result || !chart.result[0]){
    const desc = chart && chart.error && chart.error.description;
    if(res.status === 404 || /No data found|delisted/i.test(desc || "")){
      throw new Error(`Symbole « ${sym} » introuvable sur Yahoo Finance.`);
    }
    throw new Error(desc || `Réponse inattendue (HTTP ${res.status}).`);
  }
  const result = chart.result[0];
  const ts = result.timestamp || [];
  const q = result.indicators && result.indicators.quote && result.indicators.quote[0];
  if(!q || !ts.length) throw new Error("Aucune cotation disponible sur la période.");
  const candles = [];
  for(let i = 0; i < ts.length; i++){
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if(o == null || h == null || l == null || c == null) continue;
    // On ramène l'horodatage au minuit UTC du jour de cotation (cohérent avec le reste de l'app).
    const d = new Date((ts[i] + (result.meta && result.meta.gmtoffset || 0)) * 1000);
    const ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    candles.push({ ms, open: o, high: h, low: l, close: c });
  }
  if(!candles.length) throw new Error("Aucune bougie OHLC exploitable.");
  candles.sort((a, b) => a.ms - b.ms);
  // Dédoublonne (certains marchés renvoient deux points pour la séance du jour).
  const dedup = candles.filter((c, i) => i === candles.length - 1 || candles[i + 1].ms !== c.ms);
  const meta = result.meta || {};
  return {
    ticker: sym,
    candles: dedup,
    currency: meta.currency || null,
    name: meta.longName || meta.shortName || null,
    exchange: meta.fullExchangeName || meta.exchangeName || null,
  };
}

IRR.asset = { checkProxy, fetchCandles };

})(typeof window !== "undefined" ? window : globalThis);
