/* Tests de l'import d'historiques de cours — node --test IRRViz2/tests/*.test.js */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const U = require("../js/util.js");
const CSV = require("../js/csv.js");

const iso = r => U.msToIso(r.ms);

test("deux colonnes date;cours, sans en-tête, décimales à la virgule", () => {
  const r = CSV.parsePriceCsv("02/01/2026;101,5\n01/01/2026;100\n03/01/2026;abc\n");
  assert.equal(r.kind, "close");
  assert.deepEqual(r.rows.map(x => [iso(x), x.close, x.open, x.high, x.low]), [
    ["2026-01-01", 100, 100, 100, 100],
    ["2026-01-02", 101.5, 101.5, 101.5, 101.5],
  ]);
  assert.equal(r.rejected.length, 1);
});

test("export Yahoo Finance (7 colonnes, en-tête, ISO, lignes null)", () => {
  const r = CSV.parsePriceCsv(
    "Date,Open,High,Low,Close,Adj Close,Volume\n" +
    "2026-01-02,10,12,9,11,10.5,1000\n" +
    "2026-01-05,null,null,null,null,null,null\n" +
    "2026-01-06,11,11.5,10.8,10.9,10.4,800\n"
  );
  assert.equal(r.headerSkipped, true);
  assert.equal(r.kind, "ohlc");
  assert.deepEqual(r.rows.map(x => [iso(x), x.open, x.high, x.low, x.close]), [
    ["2026-01-02", 10, 12, 9, 11],
    ["2026-01-06", 11, 11.5, 10.8, 10.9],
  ]);
  assert.equal(r.rejected.length, 1);
});

test("export Investing.com : colonnes dans un autre ordre, dates mm/jj/aaaa", () => {
  const r = CSV.parsePriceCsv(
    '"Date","Price","Open","High","Low","Vol.","Change %"\n' +
    '"01/15/2026","1,234.50","1,200.00","1,240.00","1,190.00","1.2M","0.5%"\n' +
    '"01/16/2026","1,250.00","1,234.50","1,260.00","1,230.00","1.1M","1.3%"\n'
  );
  assert.equal(r.dateOrder, "mdy");
  assert.equal(r.kind, "ohlc");
  assert.deepEqual(r.rows.map(x => [iso(x), x.close, x.open]), [
    ["2026-01-15", 1234.5, 1200],
    ["2026-01-16", 1250, 1234.5],
  ]);
});

test("en-tête français « Date;Valeur liquidative », doublons de date : la dernière l'emporte", () => {
  const r = CSV.parsePriceCsv("Date;Valeur liquidative\n31/03/2026;250,10\n30/06/2026;252,40\n30/06/2026;253\n");
  assert.equal(r.kind, "close");
  assert.equal(r.duplicates, 1);
  assert.deepEqual(r.rows.map(x => [iso(x), x.close]), [["2026-03-31", 250.1], ["2026-06-30", 253]]);
});

test("haut / bas incohérents corrigés pour encadrer ouverture et clôture", () => {
  const r = CSV.parsePriceCsv("01/02/2026;10;10,5;9,8;11\n");
  assert.deepEqual([r.rows[0].high, r.rows[0].low], [11, 9.8]);
});

test("toPriceCsv puis parsePriceCsv redonne les mêmes cours", () => {
  const rows = CSV.parsePriceCsv("01/01/2026;1;2;0,5;1,5\n02/01/2026;1,5;1,7;1,4;1,6\n").rows;
  const back = CSV.parsePriceCsv(CSV.toPriceCsv(rows, "ohlc"));
  assert.deepEqual(back.rows, rows);
  const closeOnly = CSV.parsePriceCsv(CSV.toPriceCsv(rows, "close"));
  assert.deepEqual(closeOnly.rows.map(r => r.close), [1.5, 1.6]);
});

test("texte vide ou sans séparateur", () => {
  assert.equal(CSV.parsePriceCsv("").rows.length, 0);
  assert.equal(CSV.parsePriceCsv("blabla").rejected.length, 1);
});

test("maxMs : les cours datés dans le futur sont rejetés", () => {
  const r = CSV.parsePriceCsv("01/01/2026;1\n01/01/2030;2\n", { maxMs: Date.UTC(2026, 9, 5) });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rejected[0].reason, "date dans le futur");
});
