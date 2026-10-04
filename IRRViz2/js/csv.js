/* =========================================================================
   IRRViz 2 — import / export CSV des transactions.
   ========================================================================= */

(function(root){
"use strict";

const IRR = root.IRR = root.IRR || {};
const U = IRR.util || (typeof require !== "undefined" ? require("./util.js") : null);

// Découpe une ligne en respectant les guillemets ("1,5" reste un seul champ).
function splitLine(line, sep){
  const out = [];
  let cur = "", quoted = false;
  for(let i = 0; i < line.length; i++){
    const ch = line[i];
    if(quoted){
      if(ch === '"' && line[i + 1] === '"'){ cur += '"'; i++; }
      else if(ch === '"') quoted = false;
      else cur += ch;
    } else if(ch === '"') quoted = true;
    else if(ch === sep){ out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  while(out.length > 3 && out[out.length - 1] === "") out.pop();
  return out;
}

const SEPARATORS = [";", "\t", ","];

function parseCsv(text){
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const rows = [], rejected = [];
  let headerSkipped = false;
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if(!line || line.startsWith("#")) return;
    let parts = null;
    for(const sep of SEPARATORS){
      const cand = splitLine(line, sep);
      if(cand.length === 3){ parts = cand; break; }
    }
    if(!parts){
      rejected.push({ line: idx + 1, text: line, reason: "3 colonnes attendues" });
      return;
    }
    const [d, a, q] = parts;
    const ms = U.parseDate(d);
    const amount = U.parseNum(a);
    const quantity = U.parseNum(q);
    if(!Number.isFinite(ms)){
      // Une première ligne non numérique est considérée comme un en-tête.
      if(!rows.length && !rejected.length && !headerSkipped && /[a-zA-Zéû]/.test(d) && !Number.isFinite(amount)){
        headerSkipped = true;
        return;
      }
      rejected.push({ line: idx + 1, text: line, reason: `date invalide « ${d} »` });
      return;
    }
    if(!Number.isFinite(amount)){ rejected.push({ line: idx + 1, text: line, reason: `montant invalide « ${a} »` }); return; }
    if(!Number.isFinite(quantity)){ rejected.push({ line: idx + 1, text: line, reason: `quantité invalide « ${q} »` }); return; }
    rows.push({ iso: U.msToIso(ms), amount, quantity, line: idx + 1 });
  });
  return { rows, rejected, headerSkipped };
}

function toCsv(transactions){
  const fmt = v => String(v).replace(".", ",");
  const lines = ["date;montant;quantite"];
  transactions
    .slice()
    .sort((a, b) => (a.iso || "").localeCompare(b.iso || ""))
    .forEach(t => {
      const ms = U.isoToMs(t.iso);
      if(!Number.isFinite(ms)) return;
      const d = new Date(ms);
      const fr = `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
      lines.push(`${fr};${fmt(t.amount)};${fmt(t.quantity)}`);
    });
  return lines.join("\r\n") + "\r\n";
}

/* ---------------------------------------------------------------------
   Historique de cours : « date;cours » ou « date;ouverture;haut;bas;clôture ».
   Accepte aussi les exports usuels (Yahoo Finance : Date,Open,High,Low,Close,
   Adj Close,Volume ; Investing.com : "Date","Price","Open","High","Low",…)
   grâce à la lecture de la ligne d'en-tête.
   --------------------------------------------------------------------- */

const norm = s => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const HEADER_ALIASES = {
  date: ["date", "jour", "day", "seance", "time"],
  open: ["open", "ouverture", "ouv", "premier"],
  high: ["high", "haut", "plus haut", "max", "maximum"],
  low: ["low", "bas", "plus bas", "min", "minimum"],
  close: ["close", "cloture", "price", "prix", "cours", "valeur", "valeur liquidative", "vl", "nav", "dernier", "last", "value", "adj close"],
};

// Associe chaque rôle à l'index de colonne correspondant dans l'en-tête (null si absent).
function mapHeader(cells){
  const names = cells.map(norm);
  const find = role => {
    for(const alias of HEADER_ALIASES[role]){
      const i = names.indexOf(alias);
      if(i >= 0) return i;
    }
    return null;
  };
  const map = { date: find("date"), open: find("open"), high: find("high"), low: find("low"), close: find("close") };
  return map.date != null && map.close != null ? map : null;
}

// Choisit le séparateur qui donne un nombre de colonnes stable (≥ 2) sur les premières lignes.
function detectSeparator(lines){
  const sample = lines.slice(0, 8);
  let best = null;
  for(const sep of SEPARATORS){
    const counts = sample.map(l => splitLine(l, sep).length);
    const n = counts[counts.length - 1];
    if(n >= 2 && counts.every(c => c === n) && (!best || n > best.n)) best = { sep, n };
  }
  return best ? best.sep : null;
}

// Ordre jour/mois des dates "a/b/aaaa" : jj/mm par défaut, mm/jj si un 2e nombre dépasse 12.
function detectDateOrder(dates){
  let dmy = false, mdy = false;
  dates.forEach(d => {
    const m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(String(d).trim().replace(/^"|"$/g, ""));
    if(!m) return;
    if(+m[1] > 12) dmy = true;
    if(+m[2] > 12) mdy = true;
  });
  return mdy && !dmy ? "mdy" : "dmy";
}

function parseDateOrdered(str, order){
  if(order === "mdy"){
    const m = /^(\d{1,2})([\/.\-])(\d{1,2})\2(\d{2,4})$/.exec(String(str).trim().replace(/^"|"$/g, ""));
    if(m) return U.parseDate(`${m[3]}/${m[1]}/${m[4]}`);
  }
  return U.parseDate(str);
}

// `maxMs` (optionnel) : les cours datés après cette date sont rejetés (un historique ne peut être futur).
function parsePriceCsv(text, { maxMs = Infinity } = {}){
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  const out = { rows: [], rejected: [], headerSkipped: false, kind: "close", dateOrder: "dmy", duplicates: 0 };
  if(!lines.length) return out;
  const sep = detectSeparator(lines);
  if(!sep){
    out.rejected.push({ line: 1, text: lines[0], reason: "colonnes non reconnues (séparateur ; , ou tabulation attendu)" });
    return out;
  }
  let cells = lines.map(l => splitLine(l, sep));
  let map = null;
  if(!Number.isFinite(U.parseDate(cells[0][0]))){
    map = mapHeader(cells[0]);
    out.headerSkipped = true;
    cells = cells.slice(1);
    if(!map){
      const n = cells.length ? cells[0].length : 0;
      map = n >= 5 ? { date: 0, open: 1, high: 2, low: 3, close: 4 } : { date: 0, open: null, high: null, low: null, close: 1 };
    }
  } else {
    const n = cells[0].length;
    map = n >= 5 ? { date: 0, open: 1, high: 2, low: 3, close: 4 } : { date: 0, open: null, high: null, low: null, close: 1 };
  }
  const ohlc = map.open != null && map.high != null && map.low != null;
  out.kind = ohlc ? "ohlc" : "close";
  out.dateOrder = detectDateOrder(cells.map(c => c[map.date]));
  const lineOffset = out.headerSkipped ? 2 : 1;
  const byDay = new Map();
  cells.forEach((c, i) => {
    const lineNo = i + lineOffset;
    const raw = lines[i + (out.headerSkipped ? 1 : 0)];
    const ms = parseDateOrdered(c[map.date] || "", out.dateOrder);
    if(!Number.isFinite(ms)){ out.rejected.push({ line: lineNo, text: raw, reason: `date invalide « ${c[map.date] || ""} »` }); return; }
    if(ms > maxMs){ out.rejected.push({ line: lineNo, text: raw, reason: "date dans le futur" }); return; }
    const close = U.parseNum(c[map.close] || "");
    if(!(close > 0)){ out.rejected.push({ line: lineNo, text: raw, reason: `cours invalide « ${c[map.close] || ""} »` }); return; }
    let row = { ms, open: close, high: close, low: close, close };
    if(ohlc){
      const o = U.parseNum(c[map.open] || ""), h = U.parseNum(c[map.high] || ""), l = U.parseNum(c[map.low] || "");
      if(!(o > 0 && h > 0 && l > 0)){ out.rejected.push({ line: lineNo, text: raw, reason: "ouverture / haut / bas invalides" }); return; }
      row = { ms, open: o, high: Math.max(h, o, close), low: Math.min(l, o, close), close };
    }
    if(byDay.has(ms)) out.duplicates++;
    byDay.set(ms, row);
  });
  out.rows = [...byDay.values()].sort((a, b) => a.ms - b.ms);
  return out;
}

function toPriceCsv(rows, kind){
  const fmt = v => String(Math.round(v * 1e6) / 1e6).replace(".", ",");
  const lines = [kind === "ohlc" ? "date;ouverture;haut;bas;cloture" : "date;cours"];
  rows.forEach(r => {
    const d = new Date(r.ms);
    const fr = `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
    lines.push(kind === "ohlc" ? `${fr};${fmt(r.open)};${fmt(r.high)};${fmt(r.low)};${fmt(r.close)}` : `${fr};${fmt(r.close)}`);
  });
  return lines.join("\r\n") + "\r\n";
}

IRR.csv = { parseCsv, toCsv, splitLine, parsePriceCsv, toPriceCsv };

if(typeof module !== "undefined" && module.exports) module.exports = IRR.csv;

})(typeof window !== "undefined" ? window : globalThis);
