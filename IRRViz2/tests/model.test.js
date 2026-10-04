/* Tests du moteur de calcul — à lancer avec : node --test IRRViz2/tests/ */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const U = require("../js/util.js");
const M = require("../js/model.js");

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

const SAMPLE = [
  { id: "a", iso: "2026-01-01", amount: -1000, quantity: 1000 },
  { id: "b", iso: "2026-02-01", amount: 500, quantity: -400 },
  { id: "c", iso: "2026-03-01", amount: 10, quantity: 0 },
  { id: "d", iso: "2026-04-01", amount: -500, quantity: 410 },
];

test("parseNum accepte les formats usuels", () => {
  assert.equal(U.parseNum("1 234,56"), 1234.56);
  assert.equal(U.parseNum("1,234.56"), 1234.56);
  assert.equal(U.parseNum("1.234,56 €"), 1234.56);
  assert.equal(U.parseNum("-1000.5"), -1000.5);
  assert.equal(U.parseNum("−12,5"), -12.5);
  assert.equal(U.parseNum("(42)"), -42);
  assert.ok(Number.isNaN(U.parseNum("abc")));
  assert.ok(Number.isNaN(U.parseNum("")));
});

test("parseDate gère jj/mm/aaaa, aa et ISO, rejette les dates impossibles", () => {
  assert.equal(U.msToIso(U.parseDate("01/02/2026")), "2026-02-01");
  assert.equal(U.msToIso(U.parseDate("1-2-26")), "2026-02-01");
  assert.equal(U.msToIso(U.parseDate("2026-02-01")), "2026-02-01");
  assert.ok(Number.isNaN(U.parseDate("31/02/2026")));
  assert.ok(Number.isNaN(U.parseDate("2026-13-01")));
});

test("buildModel trie et cumule les quantités", () => {
  const m = M.buildModel([SAMPLE[3], SAMPLE[0], SAMPLE[2], SAMPLE[1]]);
  assert.deepEqual(m.points.map(p => p.id), ["a", "b", "c", "d"]);
  assert.deepEqual(m.points.map(p => p.cumQty), [1000, 600, 600, 1010]);
  assert.equal(M.buildModel([]), null);
});

test("à 0 % sans frais, le prix seuil est le prix de revient net", () => {
  const m = M.buildModel(SAMPLE);
  const p = M.makePricer(m, 0, 0)(U.isoToMs("2026-06-01"));
  close(p, (1000 - 500 - 10 + 500) / 1010);
});

test("le prix seuil et le TRI sont réciproques (avec frais)", () => {
  const m = M.buildModel(SAMPLE);
  const ms = U.isoToMs("2027-06-15");
  for(const pct of [-10, 0, 3, 6, 10, 20, 35]){
    const price = M.makePricer(m, pct, 0.0035)(ms);
    const irr = M.irrForSale(m, ms, price, 0.0035);
    close(irr, pct, 1e-6);
  }
});

test("séries par segments cohérentes avec makePricer", () => {
  const m = M.buildModel(SAMPLE);
  const start = U.isoToMs("2025-12-01"), end = U.isoToMs("2027-01-01");
  const segs = M.buildSegments(m, start, end, 200);
  const series = M.seriesForSegments(m, segs, 10, 0.01);
  const pricer = M.makePricer(m, 10, 0.01);
  segs.forEach((seg, i) => {
    if(seg.gap) return;
    // On évite l'instant exact d'une transaction (frontière de segment).
    const j = Math.floor(seg.ts.length / 2);
    close(series[i][j], pricer(seg.ts[j]), 1e-9);
  });
});

test("position soldée : pas de prix seuil, TRI réalisé calculable", () => {
  const tx = [
    { iso: "2025-01-01", amount: -1000, quantity: 10 },
    { iso: "2026-01-01", amount: 1100, quantity: -10 },
  ];
  const m = M.buildModel(tx);
  assert.equal(M.makePricer(m, 5, 0)(U.isoToMs("2026-06-01")), null);
  close(M.irrForSale(m, U.isoToMs("2026-06-01"), 0, 0), 10, 1e-6);
});

test("positionSummary ventile achats, ventes et flux", () => {
  const m = M.buildModel(SAMPLE);
  const s = M.positionSummary(m, U.isoToMs("2030-01-01"));
  assert.equal(s.qty, 1010);
  assert.equal(s.bought, 1500);
  assert.equal(s.sold, 500);
  assert.equal(s.income, 10);
  assert.equal(s.netFlow, -990);
});

const CSV = require("../js/csv.js");

test("parseCsv : séparateurs, guillemets, en-tête et lignes rejetées", () => {
  const { rows, rejected, headerSkipped } = CSV.parseCsv(
    "﻿Date;Montant;Quantité\n" +
    "01/01/2026;-1 000,50;1000\n" +
    '2026-02-01,"500,25",-400\n' +
    "01/03/2026\t10\t0\n" +
    "31/02/2026;1;1\n" +
    "n'importe quoi\n"
  );
  assert.equal(headerSkipped, true);
  assert.deepEqual(rows.map(r => [r.iso, r.amount, r.quantity]), [
    ["2026-01-01", -1000.5, 1000],
    ["2026-02-01", 500.25, -400],
    ["2026-03-01", 10, 0],
  ]);
  assert.equal(rejected.length, 2);
});

test("toCsv puis parseCsv redonne les mêmes transactions", () => {
  const back = CSV.parseCsv(CSV.toCsv(SAMPLE)).rows.map(r => [r.iso, r.amount, r.quantity]);
  assert.deepEqual(back, SAMPLE.map(t => [t.iso, t.amount, t.quantity]));
});
