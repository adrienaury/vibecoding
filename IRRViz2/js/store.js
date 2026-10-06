/* =========================================================================
   IRRViz 2 — état applicatif, persistance localStorage, annuler / rétablir.

   L'application gère plusieurs positions (« dossiers ») : chacune possède ses
   transactions, seuils, frais, horizon, symbole, vue du graphique, historique
   d'annulation et cache de cours. Les préférences d'affichage (thème, panneau…)
   et le port du proxy sont communs à toutes les positions.

   Synchronisation entre appareils : chaque position porte une date de
   modification (`modifiedAt`), une position supprimée laisse une trace
   (`deleted`, id → date) et l'ordre des positions a sa propre date (`orderAt`).
   Le moteur de fusion (plus bas, `syncEngine`) compare deux copies position par
   position ; le transport (GitHub…) est dans sync.js et github.js.
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
const SYNC_KEY = "irrviz2-sync-v2";               // réglages et état de la synchronisation (jeton compris)
const UNDO_LIMIT = 100;
const TOMBSTONE_LIMIT = 1000;

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
    modifiedAt: Date.now(), // dernière modification des données (fusion lors de la synchronisation)
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
  s.modifiedAt = typeof raw.modifiedAt === "number" && Number.isFinite(raw.modifiedAt) ? raw.modifiedAt : s.createdAt;
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

// Traces de suppression : { id de position: date de suppression }, limitées aux plus récentes.
function sanitizeDeleted(raw){
  const out = {};
  if(!raw || typeof raw !== "object") return out;
  Object.entries(raw)
    .filter(([id, at]) => /^[\w-]{1,64}$/.test(id) && Number.isFinite(+at) && +at > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOMBSTONE_LIMIT)
    .forEach(([id, at]) => { out[id] = +at; });
  return out;
}

// Format persisté : { version: 2, activeId, positions: [...], deleted, orderAt, proxyPort, ui }
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
  const deleted = sanitizeDeleted(raw.deleted);
  ids.forEach(id => { delete deleted[id]; });
  const orderAt = Number.isFinite(+raw.orderAt) ? +raw.orderAt : 0;
  return { version: 2, activeId, positions, deleted, orderAt, proxyPort: g.proxyPort, ui: g.ui };
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
  const app = { version: 2, activeId: pos.id, positions: [pos], deleted: {}, orderAt: 0, proxyPort: g.proxyPort, ui: g.ui };
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
  return { version: 2, activeId: pos.id, positions: [pos], deleted: {}, orderAt: 0, proxyPort: g.proxyPort, ui: g.ui };
}

/* Accès au stockage (localStorage par défaut ; un autre objet de même interface
   pour les tests, qui simulent ainsi plusieurs appareils). Toute erreur est
   absorbée : stockage bloqué, quota dépassé, JSON corrompu. */
function defaultStorage(){
  try{ return root.localStorage; }catch(e){ return null; }
}
function createIo(storage){
  const io = {
    read(key){
      try{
        const raw = storage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      }catch(e){ return null; }
    },
    write(key, value){
      try{ storage.setItem(key, JSON.stringify(value)); return true; }
      catch(e){ return false; }
    },
    remove(key){
      try{ storage.removeItem(key); }catch(e){ /* ignore */ }
    },
    /* Données volumineuses rangées hors de l'état principal, une clé par position :
       cache Yahoo et historique importé. */
    readPosData(id){
      const o = {};
      Object.entries(POS_PREFIXES).forEach(([k, pre]) => { o[k] = io.read(pre + id); });
      return o;
    },
    writePosData(id, data){
      if(!data) return;
      Object.entries(POS_PREFIXES).forEach(([k, pre]) => { if(data[k]) io.write(pre + id, data[k]); });
    },
    removePosData(id){
      Object.values(POS_PREFIXES).forEach(pre => io.remove(pre + id));
    },
  };
  return io;
}
const POS_PREFIXES = { prices: PRICES_PREFIX, manual: MANUAL_PREFIX };

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
   Moteur de synchronisation (calcul pur, indépendant du service distant)

   Un « document de synchronisation » est la copie des données partagées :
     { positions: [...], manual: { id: historique importé }, prices: { id: cours Yahoo },
       deleted: { id: date }, orderAt }
   Ni la vue du graphique ni les préférences d'affichage n'en font partie : elles
   restent propres à l'appareil.

   Les cours Yahoo (téléchargés par le proxy local, absent d'un iPad) voyagent avec
   la position mais ont leur propre fusion : union des séances par date, sans
   conflit ni date de modification. Une séance connue n'est jamais effacée.

   La fusion se fait position par position, par rapport à la « base » : l'empreinte
   de chaque position lors de la dernière synchronisation réussie. Une position
   modifiée d'un seul côté prend cette version ; modifiée des deux côtés, c'est un
   conflit : la plus récente est gardée, l'autre est conservée pour que
   l'utilisateur puisse choisir.
   --------------------------------------------------------------------- */

// Empreinte 53 bits (cyrb53) : suffisante pour détecter un changement de contenu.
function hashString(str){
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for(let i = 0; i < str.length; i++){
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// Historique importé tel que stocké, validé et mis sous forme canonique (null si vide ou illisible).
function normalizeManual(raw){
  const rec = decodeManual(raw);
  if(!rec) return null;
  const enc = encodeManual(rec);
  enc.importedAt = Number.isFinite(+raw.importedAt) && raw.importedAt ? +raw.importedAt : null;
  return enc;
}

/* ---------------- Cours Yahoo : séries de séances ----------------
   Format stocké (clé irrviz2-prices-v2:<id>, champ `prices` des sauvegardes) :
   { source: "yahoo", ticker, currency, name, exchange, fetchedAt (ms),
     from (s : début de la période déjà demandée), splits: [s, …] (divisions
     d'actions déjà appliquées), rows: [[s, o, h, l, c], …] } */

const round4 = v => Math.round(v * 1e4) / 1e4;
const strOrNull = v => (typeof v === "string" && v ? v.slice(0, 80) : null);

// Série relue (stockage, fichier distant) : validée, triée, sans doublon ; null si vide ou illisible.
function normalizePrices(raw){
  if(!raw || typeof raw !== "object" || typeof raw.ticker !== "string" || !raw.ticker.trim() || !Array.isArray(raw.rows)) return null;
  const byTs = new Map();
  raw.rows.forEach(r => {
    if(!Array.isArray(r) || r.length < 5) return;
    const v = r.slice(0, 5).map(Number);
    if(v.every(Number.isFinite)) byTs.set(Math.round(v[0]), [Math.round(v[0]), round4(v[1]), round4(v[2]), round4(v[3]), round4(v[4])]);
  });
  const rows = [...byTs.values()].sort((a, b) => a[0] - b[0]);
  if(!rows.length) return null;
  const splits = Array.isArray(raw.splits) ? [...new Set(raw.splits.map(Number).filter(Number.isFinite).map(Math.round))].sort((a, b) => a - b) : [];
  return {
    source: "yahoo",
    ticker: raw.ticker.trim().toUpperCase(),
    currency: strOrNull(raw.currency),
    name: strOrNull(raw.name),
    exchange: strOrNull(raw.exchange),
    fetchedAt: Number.isFinite(+raw.fetchedAt) ? +raw.fetchedAt : 0,
    from: Number.isFinite(+raw.from) && raw.from !== null ? Math.min(Math.round(+raw.from), rows[0][0]) : rows[0][0],
    splits,
    rows,
  };
}

// Union de deux listes de séances par date : celles de `incoming` remplacent, les autres restent.
function mergeRows(base, incoming){
  const byTs = new Map(base.map(r => [r[0], r]));
  incoming.forEach(r => byTs.set(r[0], r));
  return [...byTs.values()].sort((a, b) => a[0] - b[0]);
}

// Empreinte du contenu d'une série (sans la date de téléchargement : un téléchargement sans nouveauté ne change rien).
function pricesHash(series){
  return series ? hashString(JSON.stringify([series.ticker, series.currency, series.rows])) : null;
}

/* Fusion de deux copies de la série d'une position (deux appareils) : seules comptent
   celles du symbole de la position ; pour une même date, la copie téléchargée le
   plus récemment l'emporte ; aucune séance n'est perdue. */
function mergePriceSeries(a, b, ticker){
  const t = (ticker || "").toUpperCase();
  const keep = x => (x && t && x.ticker === t ? x : null);
  a = keep(a); b = keep(b);
  if(!a || !b) return a || b;
  const [older, newer] = a.fetchedAt <= b.fetchedAt ? [a, b] : [b, a];
  return {
    source: "yahoo",
    ticker: t,
    currency: newer.currency || older.currency,
    name: newer.name || older.name,
    exchange: newer.exchange || older.exchange,
    fetchedAt: newer.fetchedAt,
    from: Math.min(a.from, b.from),
    splits: [...new Set([...a.splits, ...b.splits])].sort((x, y) => x - y),
    rows: mergeRows(older.rows, newer.rows),
  };
}

// Champs synchronisés d'une position (sans la vue du graphique).
function syncedPosition(pos){
  const p = JSON.parse(JSON.stringify(pos));
  delete p.view;
  return p;
}

// Empreinte du contenu d'une position et de son historique importé (hors date de modification).
function positionHash(pos, manual){
  return hashString(JSON.stringify([
    pos.name, pos.autoName, pos.createdAt,
    pos.transactions.map(t => [t.id, t.iso, t.amount, t.quantity]),
    pos.thresholds, pos.hiddenThresholds, pos.feePercent, pos.horizonIso, pos.assetTicker, pos.priceSource,
    manual ? [manual.name, manual.fileName, manual.kind, manual.importedAt, manual.rows] : null,
  ]));
}

// Empreinte d'un document entier : positions (contenu et ordre), cours Yahoo et traces de suppression.
function docHash(doc){
  const prices = doc.prices || {};
  return hashString(JSON.stringify([
    doc.positions.map(p => [p.id, positionHash(p, doc.manual[p.id]), pricesHash(prices[p.id])]),
    Object.entries(doc.deleted).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  ]));
}

function baseOf(doc){
  const positions = {};
  doc.positions.forEach(p => { positions[p.id] = positionHash(p, doc.manual[p.id]); });
  return { positions };
}

/* Lit un fichier distant (sauvegarde complète ou fichier de synchronisation) et le
   ramène à un document de synchronisation validé. Lève une erreur si le contenu
   n'est pas une sauvegarde IRRViz : on n'écrase jamais un fichier inconnu. */
function parseSyncDoc(raw){
  const state = raw && typeof raw === "object" && raw.state && typeof raw.state === "object" ? raw.state : raw;
  if(!state || typeof state !== "object" || !Array.isArray(state.positions)){
    throw new Error("Ce fichier n'est pas une sauvegarde IRRViz.");
  }
  const positions = [];
  const ids = new Set();
  state.positions.forEach((p, i) => {
    const pos = sanitizePosition(p, `Position ${i + 1}`);
    if(ids.has(pos.id)) return;
    ids.add(pos.id);
    positions.push(syncedPosition(pos));
  });
  const manual = {};
  const src = raw.manualPrices && typeof raw.manualPrices === "object" ? raw.manualPrices : {};
  positions.forEach(p => { const m = normalizeManual(src[p.id]); if(m) manual[p.id] = m; });
  // Cours Yahoo : seulement ceux du symbole de la position (champ absent des fichiers plus anciens).
  const prices = {};
  const psrc = raw.prices && typeof raw.prices === "object" ? raw.prices : {};
  positions.forEach(p => { const c = normalizePrices(psrc[p.id]); if(c && c.ticker === p.assetTicker) prices[p.id] = c; });
  const deleted = sanitizeDeleted(state.deleted);
  ids.forEach(id => { delete deleted[id]; });
  const orderAt = Number.isFinite(+state.orderAt) ? +state.orderAt : 0;
  return { positions, manual, prices, deleted, orderAt };
}

/* Fichier distant : même format que la sauvegarde complète (« Restaurer une
   sauvegarde » l'accepte), indenté pour des différences lisibles sur GitHub. */
function serializeSyncDoc(doc, { device = "" } = {}){
  const file = {
    app: "IRRViz2", version: 2, kind: "sync", exportedAt: new Date().toISOString(), device: device || undefined,
    state: {
      version: 2,
      activeId: doc.positions.length ? doc.positions[0].id : null,
      positions: doc.positions,
      deleted: doc.deleted,
      orderAt: doc.orderAt,
    },
    manualPrices: doc.manual,
    prices: doc.prices || {},
  };
  return JSON.stringify(file, null, 2)
    // Tableaux de nombres ou de chaînes, objets sans imbrication : sur une seule ligne.
    .replace(/\[\n\s*([^[\]{}]*?)\n\s*\]/g, (m, inner) => `[${inner.split(/,\n\s*/).join(", ")}]`)
    .replace(/\{\n\s*([^[\]{}]*?)\n\s*\}/g, (m, inner) => `{ ${inner.split(/,\n\s*/).join(", ")} }`)
    + "\n";
}

/* Fusionne la copie locale et la copie distante.
   `base` : { positions: { id: empreinte } } issue de la dernière synchronisation.
   Renvoie { doc, conflicts } ; chaque conflit décrit la version écartée :
     { id, name, at, kept: "local" | "remote", keptDeleted, other: { pos, manual } | null }
   (other = null : l'autre côté avait supprimé la position). */
function mergeSyncDocs(local, remote, base){
  const baseHashes = (base && base.positions) || {};
  const sides = { local, remote };
  const maps = { local: new Map(local.positions.map(p => [p.id, p])), remote: new Map(remote.positions.map(p => [p.id, p])) };
  const entry = (side, id) => {
    const pos = maps[side].get(id);
    return pos ? { side, pos, manual: sides[side].manual[id] || null, hash: positionHash(pos, sides[side].manual[id]) } : null;
  };
  const changed = (e, id) => e.hash !== baseHashes[id];

  const deleted = {};
  [local.deleted, remote.deleted].forEach(d => Object.entries(d).forEach(([id, at]) => { deleted[id] = Math.max(deleted[id] || 0, at); }));

  const picked = new Map();
  const conflicts = [];
  const ids = [...new Set([...maps.local.keys(), ...maps.remote.keys()])];
  ids.forEach(id => {
    const l = entry("local", id), r = entry("remote", id);
    if(l && r){
      if(l.hash === r.hash) picked.set(id, l.pos.modifiedAt >= r.pos.modifiedAt ? l : r);
      else if(!changed(r, id)) picked.set(id, l);
      else if(!changed(l, id)) picked.set(id, r);
      else {
        // Modifiée des deux côtés depuis la dernière synchronisation : la plus récente l'emporte.
        const win = l.pos.modifiedAt >= r.pos.modifiedAt ? l : r;
        const lose = win === l ? r : l;
        picked.set(id, win);
        conflicts.push({ id, name: win.pos.name, at: Date.now(), kept: win.side, keptDeleted: false, other: { pos: lose.pos, manual: lose.manual } });
      }
      return;
    }
    const e = l || r;
    const otherSide = sides[e.side === "local" ? "remote" : "local"];
    // Déjà synchronisée, absente de l'autre côté sans trace de suppression (fichier modifié
    // à la main sur GitHub, par exemple) et inchangée ici : elle a été retirée là-bas.
    if(id in baseHashes && !changed(e, id) && !(id in otherSide.deleted)) return;
    picked.set(id, e);
  });

  // Traces de suppression : une position ne survit que si elle a été modifiée après sa suppression.
  Object.entries(deleted).forEach(([id, at]) => {
    const e = picked.get(id);
    if(!e) return;
    const wasChanged = changed(e, id);
    if(wasChanged && e.pos.modifiedAt > at){
      delete deleted[id];
      conflicts.push({ id, name: e.pos.name, at: Date.now(), kept: e.side, keptDeleted: false, other: null });
    } else {
      picked.delete(id);
      if(wasChanged) conflicts.push({ id, name: e.pos.name, at: Date.now(), kept: e.side === "local" ? "remote" : "local", keptDeleted: true, other: { pos: e.pos, manual: e.manual } });
    }
  });

  // Ordre : celui du côté qui l'a modifié en dernier, complété par les positions inconnues de ce côté.
  const [first, second] = local.orderAt >= remote.orderAt ? [local, remote] : [remote, local];
  const order = [];
  [first, second].forEach(d => d.positions.forEach(p => { if(picked.has(p.id) && !order.includes(p.id)) order.push(p.id); }));

  const manual = {};
  order.forEach(id => { const m = picked.get(id).manual; if(m) manual[id] = m; });
  // Cours Yahoo : union des deux copies, pour le symbole retenu ; jamais de conflit.
  const prices = {};
  order.forEach(id => {
    const c = mergePriceSeries((local.prices || {})[id], (remote.prices || {})[id], picked.get(id).pos.assetTicker);
    if(c) prices[id] = c;
  });
  const doc = {
    positions: order.map(id => picked.get(id).pos),
    manual,
    prices,
    deleted: sanitizeDeleted(deleted),
    orderAt: Math.max(local.orderAt, remote.orderAt),
  };
  return { doc, conflicts };
}

const syncEngine = {
  hashString, normalizeManual, positionHash, docHash, baseOf, parseSyncDoc, serializeSyncDoc, mergeSyncDocs,
  normalizePrices, mergeRows, pricesHash, mergePriceSeries,
};

/* ---------------------------------------------------------------------
   Store
   --------------------------------------------------------------------- */

function createStore({ storage = defaultStorage() } = {}){
  const io = createIo(storage);
  const listeners = new Set();
  const dataListeners = new Set();
  let app = null;
  let origin = "saved"; // fresh | saved | legacy | v1
  const history = new Map(); // id de position -> { undo, redo, last }

  app = sanitizeApp(io.read(STORAGE_KEY));
  if(!app){
    const legacy = migrateLegacy(io.read(LEGACY_KEY), io.read(LEGACY_CANDLES_KEY));
    if(legacy){
      app = legacy.app;
      origin = "legacy";
      if(legacy.prices) io.write(PRICES_PREFIX + app.activeId, legacy.prices);
    } else {
      app = migrateV1(io.read(V1_STORAGE_KEY));
      if(app) origin = "v1";
    }
  }
  if(!app){
    const pos = defaultPosition("Exemple");
    loadSampleInto(pos);
    app = { version: 2, activeId: pos.id, positions: [pos], deleted: {}, orderAt: 0, proxyPort: 8765, ui: defaultUi() };
    origin = "fresh";
  }

  const active = () => app.positions.find(p => p.id === app.activeId) || app.positions[0];
  const findPos = id => app.positions.find(p => p.id === id);
  const globalView = {
    get ui(){ return app.ui; },
    get proxyPort(){ return app.proxyPort; },
    set proxyPort(v){ app.proxyPort = v; },
  };

  function hist(id = app.activeId){
    if(!history.has(id)) history.set(id, { undo: [], redo: [], last: { key: null, at: 0 } });
    return history.get(id);
  }

  const persist = () => { io.write(STORAGE_KEY, app); };
  const persistSoon = U.debounce(persist, 250);
  if(origin !== "saved") persist();

  function emit(kind){ listeners.forEach(fn => fn(kind)); }

  /* Marque une modification des données synchronisées : date de modification de la
     position (strictement croissante), puis avis aux abonnés (synchronisation). */
  const stamp = prev => Math.max(Date.now(), (prev || 0) + 1);
  function touch(pos){
    if(pos){
      pos.modifiedAt = stamp(pos.modifiedAt);
      delete app.deleted[pos.id];
    }
    dataListeners.forEach(fn => fn());
  }
  function touchOrder(){ app.orderAt = stamp(app.orderAt); }
  function markDeleted(id){ app.deleted[id] = Date.now(); }

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
    touchOrder();
    touch(pos);
    persist();
    emit("switch");
    return pos.id;
  }

  /* Remplace toutes les positions (restauration d'une sauvegarde, ou son annulation) :
     les positions écartées laissent une trace de suppression, les autres sont datées
     de maintenant pour l'emporter lors de la prochaine synchronisation. */
  function replaceApp(next){
    const keep = new Set(next.positions.map(p => p.id));
    const deleted = Object.assign({}, next.deleted, app.deleted);
    app.positions.forEach(p => { if(!keep.has(p.id)) deleted[p.id] = Date.now(); });
    app = next;
    app.deleted = deleted;
    touchOrder();
    app.positions.forEach(p => { p.modifiedAt = stamp(p.modifiedAt); delete app.deleted[p.id]; });
    touch(null);
  }

  // Historique importé et cours Yahoo tels que stockés, sous forme canonique.
  const readManualRaw = id => normalizeManual(io.read(MANUAL_PREFIX + id));
  const readPricesRaw = id => normalizePrices(io.read(PRICES_PREFIX + id));
  // Cours Yahoo de la position, s'ils correspondent à son symbole.
  const pricesOf = pos => { const c = readPricesRaw(pos.id); return c && c.ticker === pos.assetTicker ? c : null; };

  function syncSnapshot(){
    persistSoon.flush();
    const manual = {}, prices = {};
    app.positions.forEach(p => {
      const m = readManualRaw(p.id);
      if(m) manual[p.id] = m;
      const c = pricesOf(p);
      if(c) prices[p.id] = c;
    });
    return {
      positions: app.positions.map(syncedPosition),
      manual,
      prices,
      deleted: Object.assign({}, app.deleted),
      orderAt: app.orderAt,
    };
  }

  return {
    get state(){ return active(); },
    get global(){ return globalView; },
    get positions(){ return app.positions; },
    get activeId(){ return app.activeId; },
    get origin(){ return origin; },
    subscribe(fn){ listeners.add(fn); return () => listeners.delete(fn); },
    // Avertit de toute modification des données synchronisées (pas des préférences d'affichage).
    onDataChange(fn){ dataListeners.add(fn); return () => dataListeners.delete(fn); },

    /* Applique une modification métier à la position active. kind : "data" (rendu
       complet) | "soft" (valeurs éditées en place : pas de reconstruction des listes). */
    update(mutator, { key = null, kind = "data", undoable = true } = {}){
      if(undoable) checkpoint(key);
      mutator(active());
      touch(active());
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
      touch(active());
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
      touch(active());
      persistSoon();
      emit("reset");
      return true;
    },
    canUndo(){ return hist().undo.length > 0; },
    canRedo(){ return hist().redo.length > 0; },

    loadSample(){
      checkpoint(null);
      loadSampleInto(active());
      touch(active());
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
      io.writePosData(copy.id, io.readPosData(src.id));
      return insertPosition(copy, app.positions.indexOf(src) + 1);
    },

    renamePosition(id, name){
      const pos = app.positions.find(p => p.id === id);
      const trimmed = (name || "").trim().slice(0, 60);
      if(!pos || !trimmed || trimmed === pos.name) return false;
      pos.name = trimmed;
      pos.autoName = false;
      touch(pos);
      persistSoon();
      emit("positions");
      return true;
    },

    // Renommage automatique (symbole chargé) tant que l'utilisateur n'a pas choisi de nom.
    autoNamePosition(id, name){
      const pos = app.positions.find(p => p.id === id);
      if(!pos || !pos.autoName || !name || pos.name === name) return;
      pos.name = uniqueName(name);
      touch(pos);
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
        data: io.readPosData(id),
        history: history.get(id) || null,
      };
      app.positions.splice(index, 1);
      history.delete(id);
      io.removePosData(id);
      markDeleted(id);
      let fresh = null;
      if(!app.positions.length){
        fresh = defaultPosition("Ma position");
        app.positions.push(fresh);
      }
      if(token.wasActive) app.activeId = app.positions[Math.min(index, app.positions.length - 1)].id;
      touch(fresh);
      persist();
      emit(token.wasActive ? "switch" : "positions");
      return token;
    },

    restorePosition(token){
      if(!token || app.positions.some(p => p.id === token.pos.id)) return;
      // Si la position supprimée était la seule, on retire la position vide créée à sa place.
      if(app.positions.length === 1 && !app.positions[0].transactions.length && app.positions[0].autoName){
        markDeleted(app.positions[0].id);
        app.positions = [];
      }
      io.writePosData(token.pos.id, token.data);
      if(token.history) history.set(token.pos.id, token.history);
      const pos = sanitizePosition(token.pos);
      app.positions.splice(Math.min(token.index, app.positions.length), 0, pos);
      if(token.wasActive || !app.positions.some(p => p.id === app.activeId)) app.activeId = pos.id;
      touchOrder();
      touch(pos);
      persist();
      emit("switch");
    },

    movePosition(id, delta){
      const i = app.positions.findIndex(p => p.id === id);
      const j = i + delta;
      if(i < 0 || j < 0 || j >= app.positions.length) return;
      const [pos] = app.positions.splice(i, 1);
      app.positions.splice(j, 0, pos);
      touchOrder();
      touch(null);
      persistSoon();
      emit("positions");
    },

    /* ---------------- Sauvegarde / restauration ---------------- */

    backup(){
      persistSoon.flush();
      const prices = {}, manualPrices = {};
      app.positions.forEach(p => {
        const d = io.readPosData(p.id);
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
        app.positions.forEach(p => { previous.data[p.id] = io.readPosData(p.id); io.removePosData(p.id); });
        replaceApp(full);
        history.clear();
        const pick = (map, id) => (map && typeof map === "object" ? map[id] : null) || null;
        app.positions.forEach(p => io.writePosData(p.id, { prices: pick(raw.prices, p.id), manual: pick(raw.manualPrices, p.id) }));
        persist();
        emit("switch");
        return {
          mode: "all",
          count: app.positions.length,
          undo: () => {
            app.positions.forEach(p => io.removePosData(p.id));
            replaceApp(previous.app);
            Object.entries(previous.data).forEach(([id, d]) => io.writePosData(id, d));
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

    /* Cours Yahoo de la position, téléchargés ici ou reçus par synchronisation : affichage
       immédiat, appareil sans proxy (iPad), téléchargement limité à ce qui manque.
       Renvoie { fetchedAt, currency, name, exchange, from (s), candles } ou null. */
    readCandleCache(ticker, posId = app.activeId){
      const c = readPricesRaw(posId);
      if(!c || c.ticker !== (ticker || "").toUpperCase()) return null;
      return {
        fetchedAt: c.fetchedAt,
        currency: c.currency,
        name: c.name,
        exchange: c.exchange,
        from: c.from,
        candles: c.rows.map(r => ({ ms: r[0] * 1000, open: r[1], high: r[2], low: r[3], close: r[4] })),
      };
    },
    /* Complète les cours de la position avec un téléchargement : les séances reçues
       remplacent celles de même date, les autres sont gardées (Yahoo omet parfois une
       séance). `splits` : divisions d'actions [{ ms, ratio }] ; les séances déjà connues
       antérieures à une division sont ramenées à la nouvelle échelle, une seule fois.
       `from` (s) : début de la période demandée. Renvoie true si les cours ont changé. */
    writeCandleCache(ticker, candles, currency, posId = app.activeId, { name = null, exchange = null, from = null, splits = [] } = {}){
      if(!app.positions.some(p => p.id === posId)) return false;
      const sym = (ticker || "").toUpperCase();
      const prev = readPricesRaw(posId);
      const same = prev && prev.ticker === sym ? prev : null;
      let rows = same ? same.rows : [];
      const applied = new Set(same ? same.splits : []);
      splits.forEach(sp => {
        const at = Math.round(sp.ms / 1000);
        if(applied.has(at) || !(sp.ratio > 0) || sp.ratio === 1) return;
        rows = rows.map(r => (r[0] < at ? [r[0], ...r.slice(1).map(v => round4(v / sp.ratio))] : r));
        applied.add(at);
      });
      const fresh = candles.map(c => [Math.round(c.ms / 1000), c.open, c.high, c.low, c.close]);
      const next = normalizePrices({
        ticker: sym,
        currency: currency || (same && same.currency),
        name: name || (same && same.name),
        exchange: exchange || (same && same.exchange),
        fetchedAt: Date.now(),
        from: Math.min(...[from, same && same.from].filter(Number.isFinite)),
        splits: [...applied],
        rows: mergeRows(rows, fresh),
      });
      if(!next) return false;
      io.write(PRICES_PREFIX + posId, next);
      return pricesHash(same) !== pricesHash(next);
    },
    clearCandleCache(posId = app.activeId){
      io.remove(PRICES_PREFIX + posId);
    },

    /* Historique de cours importé (CSV), propre à chaque position et synchronisé.
       readManualPrices → { name, fileName, kind, importedAt, candles } | null */
    readManualPrices(posId = app.activeId){
      return decodeManual(io.read(MANUAL_PREFIX + posId));
    },
    // Renvoie false si le navigateur refuse l'écriture (quota localStorage dépassé).
    writeManualPrices(rec, posId = app.activeId){
      const pos = findPos(posId);
      if(!pos) return false;
      const ok = io.write(MANUAL_PREFIX + posId, encodeManual(rec));
      if(ok){ touch(pos); persistSoon(); }
      return ok;
    },
    clearManualPrices(posId = app.activeId){
      io.remove(MANUAL_PREFIX + posId);
      const pos = findPos(posId);
      if(pos){ touch(pos); persistSoon(); }
    },

    /* ---------------- Synchronisation entre appareils ---------------- */

    // Copie locale des données synchronisées (voir syncEngine).
    syncSnapshot,

    /* Applique un document fusionné (ou la copie distante). Les modifications venues
       d'ailleurs ne changent pas les dates de modification et effacent l'historique
       annuler / rétablir des positions concernées (il rétablirait des données périmées).
       Renvoie { changed, prices } : positions modifiées, ajoutées ou retirées, et
       positions dont les cours Yahoo ont changé. */
    syncApply(doc){
      persistSoon.flush();
      const before = new Map(app.positions.map(p => [p.id, p]));
      const prevOrder = app.positions.map(p => p.id).join();
      const changed = new Set();
      // Cours Yahoo : écrits s'ils diffèrent, sans toucher aux données ni à l'historique d'annulation.
      // Un document sans cours pour une position ne retire jamais ceux de l'appareil.
      const pricesChanged = [];
      doc.positions.forEach(p => {
        const remote = (doc.prices || {})[p.id];
        if(!remote) return;
        const cur = readPricesRaw(p.id);
        if(JSON.stringify(cur) === JSON.stringify(remote)) return;
        io.write(PRICES_PREFIX + p.id, remote);
        if(pricesHash(cur && cur.ticker === remote.ticker ? cur : null) !== pricesHash(remote)) pricesChanged.push(p.id);
      });
      const next = doc.positions.map(p => {
        const cur = before.get(p.id);
        const localManual = cur ? readManualRaw(p.id) : null;
        const remoteManual = doc.manual[p.id] || null;
        if(!cur || positionHash(cur, localManual) !== positionHash(p, remoteManual)){
          changed.add(p.id);
          if(remoteManual) io.write(MANUAL_PREFIX + p.id, remoteManual);
          else io.remove(MANUAL_PREFIX + p.id);
        }
        const pos = sanitizePosition(JSON.parse(JSON.stringify(p)));
        pos.modifiedAt = p.modifiedAt;
        pos.view = cur ? cur.view : null;
        return pos;
      });
      const keep = new Set(next.map(p => p.id));
      before.forEach((p, id) => { if(!keep.has(id)){ io.removePosData(id); changed.add(id); } });
      changed.forEach(id => history.delete(id));
      const wasActive = app.activeId;
      app.positions = next;
      app.deleted = sanitizeDeleted(doc.deleted);
      app.orderAt = doc.orderAt;
      let fresh = null;
      if(!app.positions.length){
        fresh = defaultPosition("Ma position");
        app.positions.push(fresh);
      }
      if(!keep.has(app.activeId)) app.activeId = app.positions[0].id;
      if(fresh) touch(fresh);
      persist();
      if(app.activeId !== wasActive) emit("switch");
      else if(changed.has(app.activeId)) emit("sync");
      else {
        if(changed.size || prevOrder !== app.positions.map(p => p.id).join()) emit("positions");
        if(pricesChanged.includes(app.activeId)) emit("prices");
      }
      return { changed: [...changed], prices: pricesChanged };
    },

    /* Reprend une version écartée lors d'un conflit : remplace la position de même
       identifiant (ou la recrée), ou l'ajoute comme copie (`asCopy`). */
    syncAdopt({ pos: raw, manual }, { asCopy = false } = {}){
      const pos = sanitizePosition(JSON.parse(JSON.stringify(raw)));
      pos.view = null;
      if(asCopy){
        pos.id = U.makeId("p");
        pos.name = uniqueName(`${pos.name} (autre version)`);
        pos.autoName = false;
        pos.transactions.forEach(t => { t.id = U.makeId(); });
      }
      const index = app.positions.findIndex(p => p.id === pos.id);
      if(manual) io.write(MANUAL_PREFIX + pos.id, manual); else io.remove(MANUAL_PREFIX + pos.id);
      if(index >= 0){
        pos.view = app.positions[index].view;
        app.positions[index] = pos;
        history.delete(pos.id);
        app.activeId = pos.id;
        touch(pos);
        persist();
        emit("switch");
        return pos.id;
      }
      return insertPosition(pos, asCopy ? app.positions.findIndex(p => p.id === raw.id) + 1 || app.positions.length : app.positions.length);
    },

    // Rien que l'exemple de départ (ou une position vide) : rien à perdre en reprenant les données distantes.
    isPristine(){
      if(app.positions.length !== 1) return false;
      const p = app.positions[0];
      if(io.read(MANUAL_PREFIX + p.id)) return false;
      const sample = SAMPLE_TRANSACTIONS.map(t => [t.iso, t.amount, t.quantity]).join();
      return !p.transactions.length || p.transactions.map(t => [t.iso, t.amount, t.quantity]).join() === sample;
    },

    // Réglages et état de la synchronisation (clé distincte, jamais incluse dans les sauvegardes).
    readSyncMeta(){ return io.read(SYNC_KEY); },
    writeSyncMeta(meta){ return meta ? io.write(SYNC_KEY, meta) : (io.remove(SYNC_KEY), true); },
  };
}

IRR.store = {
  createStore, DEFAULT_THRESHOLDS, sanitizePosition, sanitizeApp, migrateLegacy, migrateV1, encodeManual, decodeManual,
  syncEngine, STORAGE_KEY, SYNC_KEY,
};

if(typeof module !== "undefined" && module.exports) module.exports = IRR.store;

})(typeof window !== "undefined" ? window : globalThis);
