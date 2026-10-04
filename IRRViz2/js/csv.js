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
  const lines = String(text || "").replace(/^﻿/, "").split(/\r?\n/);
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

IRR.csv = { parseCsv, toCsv, splitLine };

if(typeof module !== "undefined" && module.exports) module.exports = IRR.csv;

})(typeof window !== "undefined" ? window : globalThis);
