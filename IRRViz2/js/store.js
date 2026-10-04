/* =========================================================================
   IRRViz 2 — état applicatif, persistance localStorage, annuler / rétablir.

   L'application gère plusieurs positions (« dossiers ») : chacune possède ses
   transactions, seuils, frais, horizon, symbole, vue du graphique, historique
   d'annulation et cache de cours. Les préférences d'affichage (thème, panneau…)
   et le port du proxy sont communs à toutes les positions.
   ========================================================================= */

(function(root){
"use strict";

const IRR = root.IRR = root.IRR || {};
const U = IRR.util || (typeof require !== "undefined" ? require("./util.js") : null);

const STORAGE_KEY = "irrviz2-app-v2";
const PRICES_PREFIX = "irrviz2-prices-v2:";       // + id de position : cache Yahoo Finance
const MANUAL_PREFIX = "irrviz2-manual-v2:";       // + id de position : historique de cours importé
const LEGACY_KEY = "irrviz2-state-v1";            // IRRViz 2, version mono-position
const LEGACY_CANDLES_KEY = "irrviz2-candles-v1";
const V1_STORAGE_KEY = "mwviz-state-v1";          // IRRViz v1 (même origine)
const UNDO_LIMIT = 100;

const DEFAULT_THRESHOLDS = [-10, 0, 3, 6, 10, 20, 35];

const SAMPLE_TRANSACTIONS = [
  { iso: "2026-01-01", amount: -1000.00, quantity: 1000 },
  { iso: "2026-02-01", amount: 500.00, quantity: -400 },
  { iso: "2026-03-01", amount: 10.00, quantity: 0 },
  { iso: "2026-04-01", amount: -500.00, quantity: 410 },
];

function defaultUi(){
  return {
    theme: "auto",          // auto | light | dark
    panelCollapsed: false,
    collapsed: {},          // cartes repliées du panneau latéral
    showBands: true,
    showCandles: true,
    showLabels: true,
  };
}

function defaultPosition(name = "Ma position"){
  return {
    id: U.makeId("p"),
    name,
    autoName: true,         // le nom suit le symbole chargé tant que l'utilisateur ne l'a pas renommé
    createdAt: Date.now(),
    transactions: [],
    thresholds: DEFAULT_THRESHOLDS.slice(),
    hiddenThresholds: [],
    feePercent: 0.35,
    horizonIso: null,
    assetTicker: "",
    priceSource: "yahoo",   // origine des cours affichés : "yahoo" | "manual"
    view: null,             // zoom/pan persisté { start, end, yMin, yMax }
  };
}

// Champs "métier" concernés par annuler/rétablir (pas la vue, ni le nom de la position).
const DATA_KEYS = ["transactions", "thresholds", "hiddenThresholds", "feePercent", "horizonIso", "assetTicker"];

function snapshot(pos){
  const o = {};
  DATA_KEYS.forEach(k => { o[k] = pos[k]; });
  return JSON.stringify(o);
}

/* ---------------------------------------------------------------------
   Validation des données lues (localStorage, sauvegardes importées)
   --------------------------------------------------------------------- */

function sanitizePosition(raw, fallbackName = "Ma position"){
  const s = defaultPosition(fallbackName);
  if(!raw || typeof raw !== "object") return s;
  if(typeof raw.id === "string" && /^[\w-]{1,64}$/.test(raw.id)) s.id = raw.id;
  if(typeof raw.name === "string" && raw.name.trim()) s.name = raw.name.trim().slice(0, 60);
  if(typeof raw.autoName === "boolean") s.autoName = raw.autoName;
  if(Number.isFinite(+raw.createdAt)) s.createdAt = +raw.createdAt;
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
  if(raw.priceSource === "manual") s.priceSource = "manual";
  const v = raw.view;
  if(v && [v.start, v.end].every(Number.isFinite) && v.end > v.start){
    s.view = { start: v.start, end: v.end };
    if([v.yMin, v.yMax].every(Number.isFinite) && v.yMax > v.yMin){ s.view.yMin = v.yMin; s.view.yMax = v.yMax; }
  }
  return s;
}

function sanitizeGlobal(raw){
  const g = { proxyPort: 8765, ui: defaultUi() };
  if(!raw || typeof raw !== "object") return g;
  if(Number.isInteger(+raw.proxyPort) && +raw.proxyPort > 0 && +raw.proxyPort < 65536) g.proxyPort = +raw.proxyPort;
  const ui = raw.ui;
  if(ui && typeof ui === "object"){
    if(["auto", "light", "dark"].includes(ui.theme)) g.ui.theme = ui.theme;
    ["panelCollapsed", "showBands", "showCandles", "showLabels"].forEach(k => {
      if(typeof ui[k] === "boolean") g.ui[k] = ui[k];
    });
    if(ui.collapsed && typeof ui.collapsed === "object") g.ui.collapsed = Object.assign({}, ui.collapsed);
  }
  return g;
}

// Format persisté : { version: 2, activeId, positions: [...], proxyPort, ui }
function sanitizeApp(raw){
  const g = sanitizeGlobal(raw);
  const list = raw && Array.isArray(raw.positions) ? raw.positions : [];
  const positions = [];
  const ids = new Set();
  list.forEach((p, i) => {
    const pos = sanitizePosition(p, `Position ${i + 1}`);
    if(ids.has(pos.id)) pos.id = U.makeId("p");
    ids.add(pos.id);
    positions.push(pos);
  });
  if(!positions.length) return null;
  const activeId = raw && ids.has(raw.activeId) ? raw.activeId : positions[0].id;
  return { version: 2, activeId, positions, proxyPort: g.proxyPort, ui: g.ui };
}

// Nom initial d'une position reprise d'un ancien format : son symbole s'il existe.
function migratedPosition(raw){
  const pos = sanitizePosition(raw, "Ma position");
  if(pos.assetTicker && (!raw || !raw.name)) pos.name = pos.assetTicker;
  return pos;
}

/* Reprise de l'état IRRViz 2 mono-position (clé irrviz2-state-v1). Renvoie
   { app, prices } où `prices` est le cache de cours à rattacher à la position. */
function migrateLegacy(legacy, legacyCandles){
  if(!legacy || typeof legacy !== "object" || !Array.isArray(legacy.transactions)) return null;
  const pos = migratedPosition(legacy);
  const g = sanitizeGlobal(legacy);
  const app = { version: 2, activeId: pos.id, positions: [pos], proxyPort: g.proxyPort, ui: g.ui };
  let prices = null;
  if(legacyCandles && legacyCandles.ticker && legacyCandles.ticker === pos.assetTicker && Array.isArray(legacyCandles.rows)){
    prices = Object.assign({ source: "yahoo" }, legacyCandles);
  }
  return { app, prices };
}

// Reprise de l'état IRRViz v1 (clé mwviz-state-v1).
function migrateV1(v1){
  if(!v1 || !Array.isArray(v1.transactions)) return null;
  const pos = migratedPosition({
    transactions: v1.transactions,
    thresholds: v1.thresholds,
    feePercent: v1.feePercent,
    horizonIso: v1.horizonIso,
    assetTicker: v1.assetTicker,
  });
  if(!pos.transactions.length) return null;
  const g = sanitizeGlobal(null);
  return { version: 2, activeId: pos.id, positions: [pos], proxyPort: g.proxyPort, ui: g.ui };
}

function readJson(key){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}
function writeJson(key, value){
  try{ localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch(e){ return false; }
}
function removeKey(key){
  try{ localStorage.removeItem(key); }catch(e){ /* ignore */ }
}

/* Données volumineuses rangées hors de l'état principal, une clé par position :
   cache Yahoo et historique importé. */
const POS_PREFIXES = { prices: PRICES_PREFIX, manual: MANUAL_PREFIX };
function readPosData(id){
  const o = {};
  Object.entries(POS_PREFIXES).forEach(([k, pre]) => { o[k] = readJson(pre + id); });
  return o;
}
function writePosData(id, data){
  if(!data) return;
  Object.entries(POS_PREFIXES).forEach(([k, pre]) => { if(data[k]) writeJson(pre + id, data[k]); });
}
function removePosData(id){
  Object.values(POS_PREFIXES).forEach(pre => removeKey(pre + id));
}

/* Historique importé : { name, fileName, kind: "ohlc" | "close", importedAt, rows }
   où rows = [[s, o, h, l, c], …] (ohlc) ou [[s, c], …] (close). */
function encodeManual(rec){
  const round = v => Math.round(v * 1e6) / 1e6;
  return {
    name: rec.name, fileName: rec.fileName || null, kind: rec.kind, importedAt: rec.importedAt || Date.now(),
    rows: rec.candles.map(c => rec.kind === "ohlc"
      ? [Math.round(c.ms / 1000), round(c.open), round(c.high), round(c.low), round(c.close)]
      : [Math.round(c.ms / 1000), round(c.close)]),
  };
}
function decodeManual(raw){
  if(!raw || !Array.isArray(raw.rows) || !raw.rows.length) return null;
  const kind = raw.kind === "ohlc" ? "ohlc" : "close";
  const candles = raw.rows
    .filter(r => Array.isArray(r) && r.length >= 2 && r.every(Number.isFinite))
    .map(r => kind === "ohlc" && r.length >= 5
      ? { ms: r[0] * 1000, open: r[1], high: r[2], low: r[3], close: r[4] }
      : { ms: r[0] * 1000, open: r[r.length - 1], high: r[r.length - 1], low: r[r.length - 1], close: r[r.length - 1] })
    .sort((a, b) => a.ms - b.ms);
  if(!candles.length) return null;
  return { name: typeof raw.name === "string" && raw.name ? raw.name : "Cours importés", fileName: raw.fileName || null, kind, importedAt: raw.importedAt || null, candles };
}

function loadSampleInto(pos){
  pos.transactions = SAMPLE_TRANSACTIONS.map(t => Object.assign({ id: U.makeId() }, t));
  pos.thresholds = DEFAULT_THRESHOLDS.slice();
  pos.hiddenThresholds = [];
  pos.feePercent = 0.35;
  pos.horizonIso = null;
  pos.view = null;
}

/* ---------------------------------------------------------------------
   Store
   --------------------------------------------------------------------- */

function createStore(){
  const listeners = new Set();
  let app = null;
  let origin = "saved"; // fresh | saved | legacy | v1
  const history = new Map(); // id de position -> { undo, redo, last }

  app = sanitizeApp(readJson(STORAGE_KEY));
  if(!app){
    const legacy = migrateLegacy(readJson(LEGACY_KEY), readJson(LEGACY_CANDLES_KEY));
    if(legacy){
      app = legacy.app;
      origin = "legacy";
      if(legacy.prices) writeJson(PRICES_PREFIX + app.activeId, legacy.prices);
    } else {
      app = migrateV1(readJson(V1_STORAGE_KEY));
      if(app) origin = "v1";
    }
  }
  if(!app){
    const pos = defaultPosition("Exemple");
    loadSampleInto(pos);
    app = { version: 2, activeId: pos.id, positions: [pos], proxyPort: 8765, ui: defaultUi() };
    origin = "fresh";
  }

  const active = () => app.positions.find(p => p.id === app.activeId) || app.positions[0];
  const globalView = {
    get ui(){ return app.ui; },
    get proxyPort(){ return app.proxyPort; },
    set proxyPort(v){ app.proxyPort = v; },
  };

  function hist(id = app.activeId){
    if(!history.has(id)) history.set(id, { undo: [], redo: [], last: { key: null, at: 0 } });
    return history.get(id);
  }

  const persist = () => { writeJson(STORAGE_KEY, app); };
  const persistSoon = U.debounce(persist, 250);
  if(origin !== "saved") persist();

  function emit(kind){ listeners.forEach(fn => fn(kind)); }

  /* Enregistre un point d'annulation AVANT une modification. Les modifications
     successives portant la même `key` en moins de 1,5 s (frappe dans un champ)
     sont regroupées en une seule étape d'annulation. */
  function checkpoint(key){
    const h = hist();
    const now = Date.now();
    if(key && key === h.last.key && now - h.last.at < 1500){
      h.last.at = now;
      return;
    }
    h.undo.push(snapshot(active()));
    if(h.undo.length > UNDO_LIMIT) h.undo.shift();
    h.redo = [];
    h.last = { key, at: now };
  }

  function restore(snap){
    const o = JSON.parse(snap);
    const pos = active();
    DATA_KEYS.forEach(k => { pos[k] = o[k]; });
  }

  function uniqueName(base){
    const names = new Set(app.positions.map(p => p.name));
    if(!names.has(base)) return base;
    for(let i = 2; ; i++){ const n = `${base} (${i})`; if(!names.has(n)) return n; }
  }

  function nextDefaultName(){
    for(let i = app.positions.length + 1; ; i++){
      const n = `Position ${i}`;
      if(!app.positions.some(p => p.name === n)) return n;
    }
  }

  function insertPosition(pos, index = app.positions.length){
    app.positions.splice(index, 0, pos);
    app.activeId = pos.id;
    persist();
    emit("switch");
    return pos.id;
  }

  return {
    get state(){ return active(); },
    get global(){ return globalView; },
    get positions(){ return app.positions; },
    get activeId(){ return app.activeId; },
    get origin(){ return origin; },
    subscribe(fn){ listeners.add(fn); return () => listeners.delete(fn); },

    /* Applique une modification métier à la position active. kind : "data" (rendu
       complet) | "soft" (valeurs éditées en place : pas de reconstruction des listes). */
    update(mutator, { key = null, kind = "data", undoable = true } = {}){
      if(undoable) checkpoint(key);
      mutator(active());
      persistSoon();
      emit(kind);
    },

    // Préférences d'affichage communes : persistées, mais hors annuler/rétablir.
    setUi(mutator, kind = "ui"){
      mutator(globalView);
      persistSoon();
      emit(kind);
    },

    setView(view){
      active().view = view;
      persistSoon();
    },

    undo(){
      const h = hist();
      if(!h.undo.length) return false;
      h.redo.push(snapshot(active()));
      restore(h.undo.pop());
      h.last = { key: null, at: 0 };
      persistSoon();
      emit("reset");
      return true;
    },
    redo(){
      const h = hist();
      if(!h.redo.length) return false;
      h.undo.push(snapshot(active()));
      restore(h.redo.pop());
      h.last = { key: null, at: 0 };
      persistSoon();
      emit("reset");
      return true;
    },
    canUndo(){ return hist().undo.length > 0; },
    canRedo(){ return hist().redo.length > 0; },

    loadSample(){
      checkpoint(null);
      loadSampleInto(active());
      persistSoon();
      emit("reset");
    },

    /* ---------------- Gestion des positions ---------------- */

    switchTo(id){
      if(id === app.activeId || !app.positions.some(p => p.id === id)) return false;
      persistSoon.flush();
      app.activeId = id;
      persist();
      emit("switch");
      return true;
    },

    // Crée une position vide ; `copySettingsFrom` reprend seuils, frais et horizon d'une autre.
    createPosition({ name, copySettingsFrom = null } = {}){
      const trimmed = (name || "").trim();
      const pos = defaultPosition(uniqueName(trimmed || nextDefaultName()));
      pos.autoName = !trimmed;
      const src = copySettingsFrom && app.positions.find(p => p.id === copySettingsFrom);
      if(src){
        pos.thresholds = src.thresholds.slice();
        pos.hiddenThresholds = src.hiddenThresholds.slice();
        pos.feePercent = src.feePercent;
        pos.horizonIso = src.horizonIso;
      }
      const index = app.positions.findIndex(p => p.id === app.activeId) + 1;
      return insertPosition(pos, index);
    },

    duplicatePosition(id = app.activeId){
      const src = app.positions.find(p => p.id === id);
      if(!src) return null;
      const copy = sanitizePosition(JSON.parse(JSON.stringify(src)));
      copy.id = U.makeId("p");
      copy.name = uniqueName(`${src.name} (copie)`);
      copy.autoName = false;
      copy.createdAt = Date.now();
      copy.transactions.forEach(t => { t.id = U.makeId(); });
      writePosData(copy.id, readPosData(src.id));
      return insertPosition(copy, app.positions.indexOf(src) + 1);
    },

    renamePosition(id, name){
      const pos = app.positions.find(p => p.id === id);
      const trimmed = (name || "").trim().slice(0, 60);
      if(!pos || !trimmed || trimmed === pos.name) return false;
      pos.name = trimmed;
      pos.autoName = false;
      persistSoon();
      emit("positions");
      return true;
    },

    // Renommage automatique (symbole chargé) tant que l'utilisateur n'a pas choisi de nom.
    autoNamePosition(id, name){
      const pos = app.positions.find(p => p.id === id);
      if(!pos || !pos.autoName || !name || pos.name === name) return;
      pos.name = uniqueName(name);
      persistSoon();
      emit("positions");
    },

    /* Supprime une position. Renvoie un jeton permettant de l'annuler avec
       restorePosition (la dernière position restante ne peut pas être supprimée,
       elle est vidée à la place). */
    deletePosition(id = app.activeId){
      const index = app.positions.findIndex(p => p.id === id);
      if(index < 0) return null;
      const pos = app.positions[index];
      const token = {
        pos: JSON.parse(JSON.stringify(pos)),
        index,
        wasActive: id === app.activeId,
        data: readPosData(id),
        history: history.get(id) || null,
      };
      app.positions.splice(index, 1);
      history.delete(id);
      removePosData(id);
      if(!app.positions.length){
        const fresh = defaultPosition("Ma position");
        app.positions.push(fresh);
      }
      if(token.wasActive) app.activeId = app.positions[Math.min(index, app.positions.length - 1)].id;
      persist();
      emit(token.wasActive ? "switch" : "positions");
      return token;
    },

    restorePosition(token){
      if(!token || app.positions.some(p => p.id === token.pos.id)) return;
      // Si la position supprimée était la seule, on retire la position vide créée à sa place.
      if(app.positions.length === 1 && !app.positions[0].transactions.length && app.positions[0].autoName){
        app.positions = [];
      }
      writePosData(token.pos.id, token.data);
      if(token.history) history.set(token.pos.id, token.history);
      const pos = sanitizePosition(token.pos);
      app.positions.splice(Math.min(token.index, app.positions.length), 0, pos);
      if(token.wasActive || !app.positions.some(p => p.id === app.activeId)) app.activeId = pos.id;
      persist();
      emit("switch");
    },

    movePosition(id, delta){
      const i = app.positions.findIndex(p => p.id === id);
      const j = i + delta;
      if(i < 0 || j < 0 || j >= app.positions.length) return;
      const [pos] = app.positions.splice(i, 1);
      app.positions.splice(j, 0, pos);
      persistSoon();
      emit("positions");
    },

    /* ---------------- Sauvegarde / restauration ---------------- */

    backup(){
      persistSoon.flush();
      const prices = {}, manualPrices = {};
      app.positions.forEach(p => {
        const d = readPosData(p.id);
        if(d.prices) prices[p.id] = d.prices;
        if(d.manual) manualPrices[p.id] = d.manual;
      });
      return {
        app: "IRRViz2", version: 2, exportedAt: new Date().toISOString(),
        state: JSON.parse(JSON.stringify(app)),
        prices, manualPrices,
      };
    },

    /* Restaure une sauvegarde :
       - sauvegarde complète (version 2) : remplace toutes les positions ;
       - sauvegarde mono-position (IRRViz 2 avant les positions) : ajoutée comme nouvelle position.
       Renvoie { mode, count, undo } où `undo()` annule la restauration. */
    restoreBackup(raw){
      const data = raw && raw.state ? raw.state : raw;
      const full = sanitizeApp(data);
      if(full && data && Array.isArray(data.positions)){
        const previous = { app: JSON.parse(JSON.stringify(app)), data: {} };
        app.positions.forEach(p => { previous.data[p.id] = readPosData(p.id); removePosData(p.id); });
        app = full;
        history.clear();
        const pick = (map, id) => (map && typeof map === "object" ? map[id] : null) || null;
        app.positions.forEach(p => writePosData(p.id, { prices: pick(raw.prices, p.id), manual: pick(raw.manualPrices, p.id) }));
        persist();
        emit("switch");
        return {
          mode: "all",
          count: app.positions.length,
          undo: () => {
            app.positions.forEach(p => removePosData(p.id));
            app = previous.app;
            Object.entries(previous.data).forEach(([id, d]) => writePosData(id, d));
            history.clear();
            persist();
            emit("switch");
          },
        };
      }
      if(!data || !Array.isArray(data.transactions)) throw new Error("Sauvegarde non reconnue");
      const pos = migratedPosition(data);
      pos.id = U.makeId("p");
      pos.name = uniqueName(pos.name);
      pos.view = null;
      const id = insertPosition(pos);
      const self = this;
      return { mode: "position", count: 1, undo: () => self.deletePosition(id) };
    },

    flush(){ persistSoon.flush(); },

    /* Cache des cours de la position (dernier téléchargement réussi), pour un
       affichage immédiat au chargement et un mode dégradé sans proxy.
       Format : { source: "yahoo", ticker, currency, fetchedAt, rows: [[s, o, h, l, c], …] } */
    readCandleCache(ticker, posId = app.activeId){
      const c = readJson(PRICES_PREFIX + posId);
      if(!c || c.ticker !== ticker || !Array.isArray(c.rows)) return null;
      return {
        fetchedAt: c.fetchedAt,
        currency: c.currency || null,
        candles: c.rows.map(r => ({ ms: r[0] * 1000, open: r[1], high: r[2], low: r[3], close: r[4] })),
      };
    },
    writeCandleCache(ticker, candles, currency, posId = app.activeId){
      if(!app.positions.some(p => p.id === posId)) return;
      const round = v => Math.round(v * 1e4) / 1e4;
      const rows = candles.map(c => [Math.round(c.ms / 1000), round(c.open), round(c.high), round(c.low), round(c.close)]);
      writeJson(PRICES_PREFIX + posId, { source: "yahoo", ticker, currency, fetchedAt: Date.now(), rows });
    },
    clearCandleCache(posId = app.activeId){
      removeKey(PRICES_PREFIX + posId);
    },

    /* Historique de cours importé (CSV), propre à chaque position.
       readManualPrices → { name, fileName, kind, importedAt, candles } | null */
    readManualPrices(posId = app.activeId){
      return decodeManual(readJson(MANUAL_PREFIX + posId));
    },
    // Renvoie false si le navigateur refuse l'écriture (quota localStorage dépassé).
    writeManualPrices(rec, posId = app.activeId){
      if(!app.positions.some(p => p.id === posId)) return false;
      return writeJson(MANUAL_PREFIX + posId, encodeManual(rec));
    },
    clearManualPrices(posId = app.activeId){
      removeKey(MANUAL_PREFIX + posId);
    },
  };
}

IRR.store = { createStore, DEFAULT_THRESHOLDS, sanitizePosition, sanitizeApp, migrateLegacy, migrateV1, encodeManual, decodeManual, STORAGE_KEY };

if(typeof module !== "undefined" && module.exports) module.exports = IRR.store;

})(typeof window !== "undefined" ? window : globalThis);
