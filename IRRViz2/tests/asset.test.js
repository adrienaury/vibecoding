/* Tests des cours Yahoo : téléchargement limité à ce qui manque, fusion avec les cours
   connus, divisions d'actions — node --test IRRViz2/tests/*.test.js
   Le proxy est simulé : `fetch` renvoie des réponses au format de l'API chart de Yahoo. */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const U = require("../js/util.js");
const St = require("../js/store.js");
const A = require("../js/asset.js");

const DAY = 86400000;
const day = iso => U.isoToMs(iso);
const sec = iso => day(iso) / 1000;

function memoryStorage(){
  const data = new Map();
  return { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) };
}

/* Faux proxy Yahoo : séances quotidiennes de `first` à `last` (clôture = jour, ou selon
   `price`), filtrées par la période demandée. Les URL demandées sont notées. */
function fakeYahoo({ first, last, price = ms => 100 + (ms - day(first)) / DAY, splits = [], skip = [] }){
  const requests = [];
  globalThis.fetch = async url => {
    const inner = new URL(decodeURIComponent(String(url).split("?url=")[1] || ""));
    const p1 = +inner.searchParams.get("period1"), p2 = +inner.searchParams.get("period2");
    requests.push({ period1: p1, period2: p2 });
    const ts = [];
    for(let ms = Math.max(day(first), p1 * 1000); ms <= Math.min(day(last), p2 * 1000); ms += DAY){
      if(!skip.includes(U.msToIso(ms))) ts.push(ms / 1000);
    }
    const close = ts.map(s => price(s * 1000));
    const ev = {};
    splits.filter(sp => sec(sp.iso) >= p1 && sec(sp.iso) <= p2).forEach(sp => { ev[sec(sp.iso)] = { date: sec(sp.iso), numerator: sp.num, denominator: sp.den }; });
    const body = ts.length
      ? { chart: { result: [{ meta: { currency: "EUR", gmtoffset: 0, longName: "Société X" }, timestamp: ts, indicators: { quote: [{ open: close, high: close, low: close, close }] }, events: { splits: ev } }] } }
      : { chart: { result: [{ meta: {}, timestamp: [], indicators: { quote: [{}] } }] } };
    return { ok: true, status: 200, json: async () => body };
  };
  return requests;
}

const TX = [{ iso: "2026-01-05", amount: -1000, quantity: 10 }];

test("plan de téléchargement : tout, puis seulement la fin avec recouvrement, puis l'avant si une transaction plus ancienne apparaît", () => {
  const target = A.fetchRange(TX, null, day("2026-03-01"));
  assert.deepEqual(A.planFetch(null, target).map(r => r.kind), ["full"]);

  const cache = { from: target.period1, candles: [{ ms: day("2025-12-06") }, { ms: day("2026-02-27") }] };
  const ranges = A.planFetch(cache, target);
  assert.deepEqual(ranges.map(r => r.kind), ["after"]);
  assert.equal(ranges[0].period1, sec("2026-02-20"), "7 jours de recouvrement");
  assert.equal(ranges[0].period2, target.period2);

  const older = A.fetchRange([{ iso: "2025-06-01" }], null, day("2026-03-01"));
  const plan = A.planFetch(cache, older);
  assert.deepEqual(plan.map(r => r.kind), ["before", "after"]);
  assert.equal(plan[0].period1, older.period1);
  // Période déjà demandée (avant l'introduction en bourse, par exemple) : pas redemandée.
  assert.deepEqual(A.planFetch(Object.assign({}, cache, { from: older.period1 }), older).map(r => r.kind), ["after"]);
});

test("écart anormal : détecté au-delà de 5 %, sauf sur la dernière séance connue", () => {
  const cached = [{ ms: 1, close: 100 }, { ms: 2, close: 100 }, { ms: 3, close: 100 }];
  assert.equal(A.hasAnomaly(cached, [{ ms: 2, close: 103 }, { ms: 3, close: 150 }]), false);
  assert.equal(A.hasAnomaly(cached, [{ ms: 2, close: 110 }]), true);
});

test("téléchargement incrémental : seule la fin est redemandée, les cours sont complétés", async () => {
  const store = St.createStore({ storage: memoryStorage() });
  store.update(s => { s.transactions = TX.map(t => Object.assign({ id: "t1" }, t)); s.assetTicker = "MC.PA"; });
  const id = store.activeId;
  let req = fakeYahoo({ first: "2025-11-01", last: "2026-02-20" });
  let res = await A.updateSeries({ ticker: "mc.pa", port: 8765, cache: null, transactions: store.state.transactions, today: day("2026-02-20") });
  assert.equal(req.length, 1);
  assert.equal(res.ticker, "MC.PA");
  assert.equal(res.name, "Société X");
  assert.equal(store.writeCandleCache("MC.PA", res.candles, res.currency, id, res), true);
  const n = store.readCandleCache("MC.PA").candles.length;

  // Une semaine plus tard : une seule requête, qui commence 7 jours avant la dernière séance connue.
  req = fakeYahoo({ first: "2025-11-01", last: "2026-02-27" });
  res = await A.updateSeries({ ticker: "MC.PA", port: 8765, cache: store.readCandleCache("MC.PA"), transactions: store.state.transactions, today: day("2026-02-27") });
  assert.equal(req.length, 1);
  assert.equal(req[0].period1, sec("2026-02-13"));
  assert.equal(store.writeCandleCache("MC.PA", res.candles, res.currency, id, res), true);
  assert.equal(store.readCandleCache("MC.PA").candles.length, n + 7);

  // Rien de nouveau : cours inchangés.
  res = await A.updateSeries({ ticker: "MC.PA", port: 8765, cache: store.readCandleCache("MC.PA"), transactions: store.state.transactions, today: day("2026-02-27") });
  assert.equal(store.writeCandleCache("MC.PA", res.candles, res.currency, id, res), false);
});

test("réponse Yahoo à laquelle il manque la veille du dernier jour : la séance connue est gardée", async () => {
  const store = St.createStore({ storage: memoryStorage() });
  store.update(s => { s.transactions = TX.map(t => Object.assign({ id: "t1" }, t)); s.assetTicker = "AI.PA"; });
  fakeYahoo({ first: "2025-12-01", last: "2026-02-19" });
  let res = await A.updateSeries({ ticker: "AI.PA", port: 8765, transactions: store.state.transactions, today: day("2026-02-19") });
  store.writeCandleCache("AI.PA", res.candles, res.currency, store.activeId, res);
  fakeYahoo({ first: "2025-12-01", last: "2026-02-20", skip: ["2026-02-19"] });
  res = await A.updateSeries({ ticker: "AI.PA", port: 8765, cache: store.readCandleCache("AI.PA"), transactions: store.state.transactions, today: day("2026-02-20") });
  assert.ok(!res.candles.some(c => c.ms === day("2026-02-19")), "la réponse simulée omet bien le 19");
  store.writeCandleCache("AI.PA", res.candles, res.currency, store.activeId, res);
  const days = store.readCandleCache("AI.PA").candles.map(c => U.msToIso(c.ms));
  assert.ok(days.includes("2026-02-19"));
  assert.ok(days.includes("2026-02-20"));
});

test("division d'actions : séances connues antérieures ramenées à la nouvelle échelle, une seule fois", async () => {
  const store = St.createStore({ storage: memoryStorage() });
  store.update(s => { s.transactions = TX.map(t => Object.assign({ id: "t1" }, t)); s.assetTicker = "NVDA"; });
  const id = store.activeId;
  // Avant la division : cours autour de 400.
  fakeYahoo({ first: "2025-12-01", last: "2026-02-10", price: () => 400 });
  let res = await A.updateSeries({ ticker: "NVDA", port: 8765, transactions: store.state.transactions, today: day("2026-02-10") });
  store.writeCandleCache("NVDA", res.candles, res.currency, id, res);
  // Division 4:1 le 12 : Yahoo renvoie toute la fenêtre déjà ajustée (100).
  const split = [{ iso: "2026-02-12", num: 4, den: 1 }];
  fakeYahoo({ first: "2025-12-01", last: "2026-02-16", price: () => 100, splits: split });
  res = await A.updateSeries({ ticker: "NVDA", port: 8765, cache: store.readCandleCache("NVDA"), transactions: store.state.transactions, today: day("2026-02-16") });
  assert.equal(res.reloaded, false, "division signalée : pas de rechargement complet");
  store.writeCandleCache("NVDA", res.candles, res.currency, id, res);
  let closes = store.readCandleCache("NVDA").candles.map(c => c.close);
  assert.ok(closes.every(c => c === 100), "toutes les séances à la nouvelle échelle");
  const count = closes.length;
  // Le recouvrement suivant renvoie encore la division : elle n'est pas réappliquée.
  fakeYahoo({ first: "2025-12-01", last: "2026-02-17", price: () => 100, splits: split });
  res = await A.updateSeries({ ticker: "NVDA", port: 8765, cache: store.readCandleCache("NVDA"), transactions: store.state.transactions, today: day("2026-02-17") });
  store.writeCandleCache("NVDA", res.candles, res.currency, id, res);
  closes = store.readCandleCache("NVDA").candles.map(c => c.close);
  assert.ok(closes.every(c => c === 100));
  assert.equal(closes.length, count + 1);
});

test("ajustement rétroactif non signalé : toute la période est relue, aucune séance perdue", async () => {
  const store = St.createStore({ storage: memoryStorage() });
  store.update(s => { s.transactions = TX.map(t => Object.assign({ id: "t1" }, t)); s.assetTicker = "X"; });
  fakeYahoo({ first: "2025-12-01", last: "2026-02-10", price: () => 50 });
  let res = await A.updateSeries({ ticker: "X", port: 8765, transactions: store.state.transactions, today: day("2026-02-10") });
  store.writeCandleCache("X", res.candles, res.currency, store.activeId, res);
  const before = store.readCandleCache("X").candles.length;
  const req = fakeYahoo({ first: "2025-12-01", last: "2026-02-12", price: () => 40 });
  res = await A.updateSeries({ ticker: "X", port: 8765, cache: store.readCandleCache("X"), transactions: store.state.transactions, today: day("2026-02-12") });
  assert.equal(res.reloaded, true);
  assert.equal(req.length, 2, "fin, puis toute la période");
  store.writeCandleCache("X", res.candles, res.currency, store.activeId, res);
  const after = store.readCandleCache("X").candles;
  assert.equal(after.length, before + 2);
  assert.ok(after.every(c => c.close === 40));
});

test("période sans cotation avant l'introduction en bourse : pas une erreur, pas redemandée", async () => {
  const store = St.createStore({ storage: memoryStorage() });
  store.update(s => { s.transactions = TX.map(t => Object.assign({ id: "t1" }, t)); s.assetTicker = "NEW"; });
  fakeYahoo({ first: "2026-01-02", last: "2026-02-10" });
  let res = await A.updateSeries({ ticker: "NEW", port: 8765, transactions: store.state.transactions, today: day("2026-02-10") });
  store.writeCandleCache("NEW", res.candles, res.currency, store.activeId, res);
  // Une transaction bien plus ancienne : la période « avant » est demandée une fois, vide.
  store.update(s => { s.transactions.push({ id: "t0", iso: "2025-01-02", amount: -10, quantity: 1 }); });
  let req = fakeYahoo({ first: "2026-01-02", last: "2026-02-11" });
  res = await A.updateSeries({ ticker: "NEW", port: 8765, cache: store.readCandleCache("NEW"), transactions: store.state.transactions, today: day("2026-02-11") });
  assert.equal(req.length, 2);
  store.writeCandleCache("NEW", res.candles, res.currency, store.activeId, res);
  req = fakeYahoo({ first: "2026-01-02", last: "2026-02-11" });
  await A.updateSeries({ ticker: "NEW", port: 8765, cache: store.readCandleCache("NEW"), transactions: store.state.transactions, today: day("2026-02-11") });
  assert.equal(req.length, 1, "seulement la fin");
});

test("proxy injoignable : erreur `proxy`", async () => {
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(A.updateSeries({ ticker: "X", port: 8765, transactions: TX }), e => e.code === "proxy");
});
