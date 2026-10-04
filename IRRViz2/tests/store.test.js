/* Tests de l'état multi-positions — à lancer avec : node --test IRRViz2/tests/*.test.js */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
require("../js/util.js");
const St = require("../js/store.js");

/* localStorage minimal en mémoire pour exercer createStore sous Node. */
function installStorage(initial = {}){
  const data = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  globalThis.localStorage = {
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: k => data.delete(k),
  };
  return {
    read: k => (data.has(k) ? JSON.parse(data.get(k)) : null),
    keys: () => [...data.keys()],
  };
}

const LEGACY = {
  transactions: [{ id: "a", iso: "2026-01-01", amount: -1000, quantity: 10 }],
  thresholds: [0, 5], hiddenThresholds: [5], feePercent: 0.5, horizonIso: "2027-01-01",
  assetTicker: "MC.PA", proxyPort: 9000,
  ui: { theme: "light", panelCollapsed: true, collapsed: { asset: true }, showBands: false },
  view: { start: 1, end: 2 },
};

test("migration de l'état mono-position : position + préférences communes + cache de cours", () => {
  const cache = { ticker: "MC.PA", currency: "EUR", fetchedAt: 1, rows: [[1767225600, 1, 2, 0.5, 1.5]] };
  const { app, prices } = St.migrateLegacy(LEGACY, cache);
  assert.equal(app.positions.length, 1);
  const p = app.positions[0];
  assert.equal(app.activeId, p.id);
  assert.equal(p.name, "MC.PA");
  assert.equal(p.feePercent, 0.5);
  assert.deepEqual(p.hiddenThresholds, [5]);
  assert.deepEqual(p.view, { start: 1, end: 2 });
  assert.equal(app.proxyPort, 9000);
  assert.equal(app.ui.theme, "light");
  assert.equal(app.ui.showBands, false);
  assert.equal(prices.ticker, "MC.PA");
  assert.equal(prices.source, "yahoo");
  // Un cache d'un autre symbole n'est pas rattaché.
  assert.equal(St.migrateLegacy(LEGACY, { ...cache, ticker: "AAPL" }).prices, null);
});

test("sanitizeApp : identifiants dupliqués, position active inconnue, liste vide", () => {
  const app = St.sanitizeApp({ activeId: "zzz", positions: [{ id: "p1", name: "A" }, { id: "p1", name: "B" }] });
  assert.equal(app.positions.length, 2);
  assert.notEqual(app.positions[0].id, app.positions[1].id);
  assert.equal(app.activeId, "p1");
  assert.equal(St.sanitizeApp({ positions: [] }), null);
  assert.equal(St.sanitizeApp(null), null);
});

test("createStore reprend l'état mono-position et le réécrit au nouveau format", () => {
  const ls = installStorage({ "irrviz2-state-v1": LEGACY, "irrviz2-candles-v1": { ticker: "MC.PA", rows: [] } });
  const store = St.createStore();
  assert.equal(store.origin, "legacy");
  assert.equal(store.state.transactions.length, 1);
  assert.equal(store.global.proxyPort, 9000);
  const saved = ls.read(St.STORAGE_KEY);
  assert.equal(saved.positions.length, 1);
  assert.ok(ls.read(`irrviz2-prices-v2:${store.activeId}`));
});

test("positions : création, bascule, annulation indépendante, suppression et restauration", () => {
  installStorage();
  const store = St.createStore();
  assert.equal(store.origin, "fresh");
  const first = store.activeId;
  const events = [];
  store.subscribe(k => events.push(k));

  store.update(s => { s.feePercent = 1; });
  const second = store.createPosition({ name: "PEA", copySettingsFrom: first });
  assert.equal(store.activeId, second);
  assert.equal(store.state.name, "PEA");
  assert.equal(store.state.feePercent, 1);           // paramètres repris
  assert.equal(store.state.transactions.length, 0);  // mais pas les transactions
  assert.equal(store.canUndo(), false);              // historique propre à la position
  assert.ok(events.includes("switch"));

  store.switchTo(first);
  assert.equal(store.canUndo(), true);
  store.undo();
  assert.equal(store.state.feePercent, 0.35);

  const token = store.deletePosition(second);
  assert.equal(store.positions.length, 1);
  store.restorePosition(token);
  assert.equal(store.positions.length, 2);
  assert.equal(store.positions[1].name, "PEA");
});

test("supprimer la dernière position la remplace par une position vide, annulable", () => {
  installStorage();
  const store = St.createStore();
  const id = store.activeId;
  const token = store.deletePosition();
  assert.equal(store.positions.length, 1);
  assert.notEqual(store.activeId, id);
  assert.equal(store.state.transactions.length, 0);
  store.restorePosition(token);
  assert.equal(store.positions.length, 1);
  assert.equal(store.activeId, id);
  assert.equal(store.state.transactions.length, 4);
});

test("nom automatique : suit le symbole jusqu'à un renommage manuel ; noms uniques", () => {
  installStorage();
  const store = St.createStore();
  const id = store.createPosition({});
  assert.match(store.state.name, /^Position \d+$/);
  store.autoNamePosition(id, "AAPL");
  assert.equal(store.state.name, "AAPL");
  store.renamePosition(id, "Mon Apple");
  store.autoNamePosition(id, "MSFT");
  assert.equal(store.state.name, "Mon Apple");
  store.duplicatePosition(id);
  assert.equal(store.state.name, "Mon Apple (copie)");
  store.createPosition({ name: "Mon Apple" });
  assert.equal(store.state.name, "Mon Apple (2)");
});

test("restauration : sauvegarde complète remplace tout (annulable), ancienne sauvegarde ajoutée", () => {
  installStorage();
  const store = St.createStore();
  store.createPosition({ name: "B" });
  const backup = JSON.parse(JSON.stringify(store.backup()));

  installStorage();
  const other = St.createStore();
  const res = other.restoreBackup(backup);
  assert.equal(res.mode, "all");
  assert.deepEqual(other.positions.map(p => p.name), ["Exemple", "B"]);
  res.undo();
  assert.deepEqual(other.positions.map(p => p.name), ["Exemple"]);

  const old = { app: "IRRViz2", version: 1, state: { transactions: [{ iso: "2025-01-01", amount: -10, quantity: 1 }], assetTicker: "AI.PA" } };
  const r2 = other.restoreBackup(old);
  assert.equal(r2.mode, "position");
  assert.equal(other.positions.length, 2);
  assert.equal(other.state.name, "AI.PA");
  assert.throws(() => other.restoreBackup({ foo: 1 }));
});

test("cache de cours propre à chaque position", () => {
  const ls = installStorage();
  const store = St.createStore();
  const a = store.activeId;
  store.writeCandleCache("AAA", [{ ms: 86400000, open: 1, high: 2, low: 0.5, close: 1.5 }], "EUR");
  const b = store.createPosition({});
  assert.equal(store.readCandleCache("AAA"), null);
  assert.equal(store.readCandleCache("AAA", a).candles[0].close, 1.5);
  store.switchTo(a);
  store.deletePosition(a);
  assert.ok(!ls.keys().includes(`irrviz2-prices-v2:${a}`));
  assert.equal(store.activeId, b);
});

test("historique importé : par position, copié à la duplication, sauvegardé, restauré après suppression", () => {
  const ls = installStorage();
  const store = St.createStore();
  const a = store.activeId;
  const candles = [
    { ms: Date.UTC(2026, 0, 1), open: 1, high: 1, low: 1, close: 1 },
    { ms: Date.UTC(2026, 0, 2), open: 1.1, high: 1.1, low: 1.1, close: 1.1 },
  ];
  assert.equal(store.writeManualPrices({ name: "SCPI X", kind: "close", candles }), true);
  const rec = store.readManualPrices();
  assert.equal(rec.name, "SCPI X");
  assert.equal(rec.kind, "close");
  assert.deepEqual(rec.candles, candles);
  assert.deepEqual(ls.read(`irrviz2-manual-v2:${a}`).rows[0], [Date.UTC(2026, 0, 1) / 1000, 1]); // format compact

  const b = store.duplicatePosition(a);
  assert.equal(store.readManualPrices(b).name, "SCPI X");
  store.update(s => { s.priceSource = "manual"; }, { undoable: false });
  assert.equal(St.sanitizePosition(JSON.parse(JSON.stringify(store.state))).priceSource, "manual");

  const backup = JSON.parse(JSON.stringify(store.backup()));
  assert.ok(backup.manualPrices[a] && backup.manualPrices[b]);

  const token = store.deletePosition(a);
  assert.equal(store.readManualPrices(a), null);
  store.restorePosition(token);
  assert.equal(store.readManualPrices(a).candles.length, 2);

  installStorage();
  const other = St.createStore();
  other.restoreBackup(backup);
  assert.equal(other.readManualPrices(a).name, "SCPI X");
});

test("decodeManual ignore les lignes corrompues", () => {
  assert.equal(St.decodeManual({ rows: [] }), null);
  const rec = St.decodeManual({ kind: "ohlc", rows: [[86400, 1, 2, 0.5, 1.5], ["x", 1], [172800, 2, 3, 1, 2.5]] });
  assert.equal(rec.candles.length, 2);
  assert.equal(rec.name, "Cours importés");
});
