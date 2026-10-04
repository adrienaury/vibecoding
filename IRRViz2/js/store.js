/* =========================================================================
   IRRViz 2 — état applicatif, persistance localStorage, annuler / rétablir.
   ========================================================================= */

(function(root){
"use strict";

const IRR = root.IRR = root.IRR || {};
const U = IRR.util;

const STORAGE_KEY = "irrviz2-state-v1";
const CANDLES_KEY = "irrviz2-candles-v1";
const V1_STORAGE_KEY = "mwviz-state-v1"; // clé utilisée par IRRViz v1 (même origine)
const UNDO_LIMIT = 100;

const DEFAULT_THRESHOLDS = [-10, 0, 3, 6, 10, 20, 35];

const SAMPLE_TRANSACTIONS = [
  { iso: "2026-01-01", amount: -1000.00, quantity: 1000 },
  { iso: "2026-02-01", amount: 500.00, quantity: -400 },
  { iso: "2026-03-01", amount: 10.00, quantity: 0 },
  { iso: "2026-04-01", amount: -500.00, quantity: 410 },
];

function defaultState(){
  return {
    transactions: [],
    thresholds: DEFAULT_THRESHOLDS.slice(),
    hiddenThresholds: [],
    feePercent: 0.35,
    horizonIso: null,
    assetTicker: "",
    proxyPort: 8765,
    ui: {
      theme: "auto",          // auto | light | dark
      panelCollapsed: false,
      collapsed: {},          // cartes repliées du panneau latéral
      showBands: true,
      showCandles: true,
      showLabels: true,
    },
    view: null,               // zoom/pan persisté { start, end, yMin, yMax }
  };
}

// Champs "métier" concernés par annuler/rétablir (pas la vue ni les préférences d'affichage).
const DATA_KEYS = ["transactions", "thresholds", "hiddenThresholds", "feePercent", "horizonIso", "assetTicker"];

function snapshot(state){
  const o = {};
  DATA_KEYS.forEach(k => { o[k] = state[k]; });
  return JSON.stringify(o);
}

function sanitize(raw){
  const s = defaultState();
  if(!raw || typeof raw !== "object") return s;
  if(Array.isArray(raw.transactions)){
    s.transactions = raw.transactions
      .filter(t => t && typeof t === "object")
      .map(t => ({
        id: typeof t.id === "string" && t.id ? t.id : U.makeId(),
        iso: typeof t.iso === "string" ? t.iso : "",
        amount: Number.isFinite(+t.amount) ? +t.amount : 0,
        quantity: Number.isFinite(+t.quantity) ? +t.quantity : 0,
      }));
    // Les identifiants doivent être uniques (sélection, suppression, surlignage).
    const seen = new Set();
    s.transactions.forEach(t => { if(seen.has(t.id)) t.id = U.makeId(); seen.add(t.id); });
  }
  if(Array.isArray(raw.thresholds)){
    s.thresholds = [...new Set(raw.thresholds.map(Number).filter(v => Number.isFinite(v) && v > -100))];
  }
  if(Array.isArray(raw.hiddenThresholds)){
    s.hiddenThresholds = raw.hiddenThresholds.map(Number).filter(v => s.thresholds.includes(v));
  }
  if(Number.isFinite(+raw.feePercent)) s.feePercent = U.clamp(+raw.feePercent, 0, 99);
  if(typeof raw.horizonIso === "string" && Number.isFinite(U.isoToMs(raw.horizonIso))) s.horizonIso = raw.horizonIso;
  if(typeof raw.assetTicker === "string") s.assetTicker = raw.assetTicker.trim().toUpperCase();
  if(Number.isInteger(+raw.proxyPort) && +raw.proxyPort > 0 && +raw.proxyPort < 65536) s.proxyPort = +raw.proxyPort;
  if(raw.ui && typeof raw.ui === "object"){
    if(["auto", "light", "dark"].includes(raw.ui.theme)) s.ui.theme = raw.ui.theme;
    ["panelCollapsed", "showBands", "showCandles", "showLabels"].forEach(k => {
      if(typeof raw.ui[k] === "boolean") s.ui[k] = raw.ui[k];
    });
    if(raw.ui.collapsed && typeof raw.ui.collapsed === "object") s.ui.collapsed = Object.assign({}, raw.ui.collapsed);
  }
  const v = raw.view;
  if(v && [v.start, v.end].every(Number.isFinite) && v.end > v.start){
    s.view = { start: v.start, end: v.end };
    if([v.yMin, v.yMax].every(Number.isFinite) && v.yMax > v.yMin){ s.view.yMin = v.yMin; s.view.yMax = v.yMax; }
  }
  return s;
}

function readJson(key){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}

// Conversion de l'état IRRViz v1 vers le format v2.
function fromV1(v1){
  if(!v1 || !Array.isArray(v1.transactions)) return null;
  const s = sanitize({
    transactions: v1.transactions,
    thresholds: v1.thresholds,
    feePercent: v1.feePercent,
    horizonIso: v1.horizonIso,
    assetTicker: v1.assetTicker,
  });
  return s.transactions.length ? s : null;
}

function createStore(){
  const listeners = new Set();
  let state = defaultState();
  let undoStack = [], redoStack = [];
  let lastCheckpoint = { key: null, at: 0 };
  let origin = "fresh"; // fresh | saved | v1

  const saved = readJson(STORAGE_KEY);
  if(saved){
    state = sanitize(saved);
    origin = "saved";
  } else {
    const migrated = fromV1(readJson(V1_STORAGE_KEY));
    if(migrated){ state = migrated; origin = "v1"; }
  }
  if(origin === "fresh") loadSampleInto(state);

  function loadSampleInto(s){
    s.transactions = SAMPLE_TRANSACTIONS.map(t => Object.assign({ id: U.makeId() }, t));
    s.thresholds = DEFAULT_THRESHOLDS.slice();
    s.hiddenThresholds = [];
    s.feePercent = 0.35;
    s.horizonIso = null;
    s.view = null;
  }

  const persist = () => {
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }catch(e){ /* quota / navigation privée */ }
  };
  const persistSoon = U.debounce(persist, 250);

  function emit(kind){ listeners.forEach(fn => fn(kind, state)); }

  /* Enregistre un point d'annulation AVANT une modification. Les modifications
     successives portant la même `key` en moins de 1,5 s (frappe dans un champ)
     sont regroupées en une seule étape d'annulation. */
  function checkpoint(key){
    const now = Date.now();
    if(key && key === lastCheckpoint.key && now - lastCheckpoint.at < 1500){
      lastCheckpoint.at = now;
      return;
    }
    undoStack.push(snapshot(state));
    if(undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
    lastCheckpoint = { key, at: now };
  }

  function restore(snap){
    const o = JSON.parse(snap);
    DATA_KEYS.forEach(k => { state[k] = o[k]; });
  }

  return {
    get state(){ return state; },
    get origin(){ return origin; },
    subscribe(fn){ listeners.add(fn); return () => listeners.delete(fn); },

    /* Applique une modification métier. kind : "data" (rendu complet) | "soft"
       (valeurs éditées en place : pas de reconstruction des listes). */
    update(mutator, { key = null, kind = "data", undoable = true } = {}){
      if(undoable) checkpoint(key);
      mutator(state);
      persistSoon();
      emit(kind);
    },

    // Préférences d'affichage / vue : persistées, mais hors annuler/rétablir.
    setUi(mutator, kind = "ui"){
      mutator(state);
      persistSoon();
      emit(kind);
    },

    setView(view){
      state.view = view;
      persistSoon();
    },

    undo(){
      if(!undoStack.length) return false;
      redoStack.push(snapshot(state));
      restore(undoStack.pop());
      lastCheckpoint = { key: null, at: 0 };
      persistSoon();
      emit("reset");
      return true;
    },
    redo(){
      if(!redoStack.length) return false;
      undoStack.push(snapshot(state));
      restore(redoStack.pop());
      lastCheckpoint = { key: null, at: 0 };
      persistSoon();
      emit("reset");
      return true;
    },
    canUndo(){ return undoStack.length > 0; },
    canRedo(){ return redoStack.length > 0; },

    loadSample(){
      checkpoint(null);
      loadSampleInto(state);
      persistSoon();
      emit("reset");
    },

    // Remplace l'état métier par une sauvegarde JSON (annulable).
    replaceFromBackup(raw){
      const s = sanitize(raw && raw.state ? raw.state : raw);
      checkpoint(null);
      DATA_KEYS.forEach(k => { state[k] = s[k]; });
      state.view = null;
      persistSoon();
      emit("reset");
      return s.transactions.length;
    },

    backup(){
      return { app: "IRRViz2", version: 1, exportedAt: new Date().toISOString(), state: JSON.parse(JSON.stringify(state)) };
    },

    flush(){ persistSoon.flush(); },

    /* Cache des bougies (dernier téléchargement réussi), pour un affichage immédiat
       au chargement et un mode dégradé quand le proxy est indisponible. */
    readCandleCache(ticker){
      const c = readJson(CANDLES_KEY);
      if(!c || c.ticker !== ticker || !Array.isArray(c.rows)) return null;
      return {
        fetchedAt: c.fetchedAt,
        currency: c.currency || null,
        candles: c.rows.map(r => ({ ms: r[0] * 1000, open: r[1], high: r[2], low: r[3], close: r[4] })),
      };
    },
    writeCandleCache(ticker, candles, currency){
      const round = v => Math.round(v * 1e4) / 1e4;
      const rows = candles.map(c => [Math.round(c.ms / 1000), round(c.open), round(c.high), round(c.low), round(c.close)]);
      try{
        localStorage.setItem(CANDLES_KEY, JSON.stringify({ ticker, currency, fetchedAt: Date.now(), rows }));
      }catch(e){ /* cache facultatif */ }
    },
    clearCandleCache(){
      try{ localStorage.removeItem(CANDLES_KEY); }catch(e){ /* ignore */ }
    },
  };
}

IRR.store = { createStore, DEFAULT_THRESHOLDS, sanitize };

})(typeof window !== "undefined" ? window : globalThis);
