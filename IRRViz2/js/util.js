/* =========================================================================
   IRRViz 2 — utilitaires partagés : dates, formatage, saisie numérique, palette.
   Script classique (pas de module ES) : l'application reste utilisable en ouvrant
   simplement index.html depuis le disque (file://). Chargeable aussi sous Node
   pour les tests (voir tests/).
   ========================================================================= */

(function(root){
"use strict";

const IRR = root.IRR = root.IRR || {};

const DAY = 86400000;
const YEAR_DAYS = 365;

/* ---------------------------------------------------------------------
   Dates — toutes manipulées comme timestamps UTC "minuit" (ms)
   --------------------------------------------------------------------- */

function ymdToMs(y, m, d){ return Date.UTC(y, m - 1, d); }

function isValidYmd(y, m, d){
  if(!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if(m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isoToMs(iso){
  if(typeof iso !== "string") return NaN;
  const mt = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(iso.trim());
  if(!mt) return NaN;
  const y = +mt[1], m = +mt[2], d = +mt[3];
  return isValidYmd(y, m, d) ? ymdToMs(y, m, d) : NaN;
}

function msToIso(ms){
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Accepte "jj/mm/aaaa", "jj-mm-aa", "jj.mm.aaaa" ainsi que l'ISO "aaaa-mm-jj".
function parseDate(str){
  if(typeof str !== "string") return NaN;
  const s = str.trim().replace(/^"|"$/g, "");
  if(/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) return isoToMs(s);
  const parts = s.split(/[\/\-.]/);
  if(parts.length !== 3) return NaN;
  let [d, m, y] = parts.map(p => parseInt(p, 10));
  if(parts[2].length <= 2 && Number.isFinite(y)) y += 2000;
  return isValidYmd(y, m, d) ? ymdToMs(y, m, d) : NaN;
}

const MONTHS_SHORT = ["janv.","févr.","mars","avr.","mai","juin","juil.","août","sept.","oct.","nov.","déc."];

function fmtDate(ms, withYear = true){
  const d = new Date(ms);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = MONTHS_SHORT[d.getUTCMonth()];
  return withYear ? `${dd} ${mm} ${d.getUTCFullYear()}` : `${dd} ${mm}`;
}

function fmtMonth(ms, withYear){
  const d = new Date(ms);
  const mm = MONTHS_SHORT[d.getUTCMonth()];
  return withYear ? `${mm} ${d.getUTCFullYear()}` : mm;
}

function todayMs(){
  const n = new Date();
  return ymdToMs(n.getFullYear(), n.getMonth() + 1, n.getDate());
}

function addMonths(ms, months){
  const d = new Date(ms);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  const target = new Date(Date.UTC(y, m + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay));
}

/* ---------------------------------------------------------------------
   Saisie numérique tolérante : "1 234,56", "-1000.5", "12,5 €", "1,234.56"
   --------------------------------------------------------------------- */

function parseNum(input){
  if(typeof input === "number") return input;
  if(typeof input !== "string") return NaN;
  let s = input.trim().replace(/^"|"$/g, "").replace(/[\s  €$£]/g, "");
  if(s === "" || s === "-" || s === "+") return NaN;
  s = s.replace(/^\((.*)\)$/, "-$1"); // notation comptable (123) = -123
  s = s.replace(/[−–]/g, "-"); // vrais signes moins typographiques
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  if(lastComma >= 0 && lastDot >= 0){
    // Les deux présents : le dernier rencontré est le séparateur décimal.
    if(lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if(lastComma >= 0){
    s = s.replace(",", ".");
  }
  if(!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return NaN;
  return Number(s);
}

/* ---------------------------------------------------------------------
   Formatage
   --------------------------------------------------------------------- */

const CURRENCY = "EUR";
const LOCALE = "fr-FR";

const fmtEUR = new Intl.NumberFormat(LOCALE, { style: "currency", currency: CURRENCY, maximumFractionDigits: 2 });
// Prix unitaires : 3 décimales — utile pour les biens dont le prix unitaire est faible.
const fmtEUR3 = new Intl.NumberFormat(LOCALE, { style: "currency", currency: CURRENCY, minimumFractionDigits: 3, maximumFractionDigits: 3 });
const fmtNum = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 4 });
const fmtNum2 = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const eurByDecimals = {};
function fmtEURd(v, decimals){
  const k = Math.max(0, Math.min(4, decimals | 0));
  if(!eurByDecimals[k]){
    eurByDecimals[k] = new Intl.NumberFormat(LOCALE, { style: "currency", currency: CURRENCY, minimumFractionDigits: k, maximumFractionDigits: k });
  }
  return eurByDecimals[k].format(v);
}

function fmtPct(x, { sign = true, decimals = 2 } = {}){
  if(x == null || !Number.isFinite(x)) return "—";
  const f = decimals === 2 ? fmtNum2 : new Intl.NumberFormat(LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const s = (sign && x > 0 ? "+" : "") + f.format(x);
  return `${s} %`;
}

function fmtThreshold(pct){
  return `${fmtNum.format(pct)} %`;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------------------------------------------------------------
   Palette rouge → orange → jaune → vert → sarcelle (reprise d'IRRViz v1).
   Les arrêts sont ancrés à des valeurs (%) précises : la zone 0-10 %, la plus
   utilisée, reçoit des teintes très contrastées tous les 2 à 4 points.
   --------------------------------------------------------------------- */

const COLOR_STOPS = [
  { v: -20, hex: "#5c0f14" },
  { v: -12, hex: "#96222a" },
  { v: -6,  hex: "#c8452f" },
  { v: -2,  hex: "#dd6a2e" },
  { v: 0,   hex: "#e88a1d" },
  { v: 2,   hex: "#f0b429" },
  { v: 4,   hex: "#f6d63c" },
  { v: 6,   hex: "#cfe33c" },
  { v: 8,   hex: "#9fdb4d" },
  { v: 10,  hex: "#6fcf5a" },
  { v: 15,  hex: "#3fb968" },
  { v: 20,  hex: "#229c58" },
  { v: 30,  hex: "#0f7a53" },
  { v: 40,  hex: "#0a5a63" },
];

function hexToRgb(hex){
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const STOPS_RGB = COLOR_STOPS.map(s => hexToRgb(s.hex));

function rgbForReturn(pct){
  const n = COLOR_STOPS.length;
  if(!(pct > COLOR_STOPS[0].v)) return STOPS_RGB[0];
  if(pct >= COLOR_STOPS[n - 1].v) return STOPS_RGB[n - 1];
  for(let i = 0; i < n - 1; i++){
    const a = COLOR_STOPS[i], b = COLOR_STOPS[i + 1];
    if(pct >= a.v && pct <= b.v){
      const t = (pct - a.v) / (b.v - a.v);
      const ca = STOPS_RGB[i], cb = STOPS_RGB[i + 1];
      return [0, 1, 2].map(j => Math.round(ca[j] + (cb[j] - ca[j]) * t));
    }
  }
  return STOPS_RGB[n - 1];
}

// `shade` < 0 assombrit (utile en thème clair, où le jaune manque de contraste), > 0 éclaircit.
function colorForReturn(pct, shade = 0){
  let [r, g, b] = rgbForReturn(pct);
  if(shade < 0){ const k = 1 + shade; r *= k; g *= k; b *= k; }
  else if(shade > 0){ r += (255 - r) * shade; g += (255 - g) * shade; b += (255 - b) * shade; }
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

/* ---------------------------------------------------------------------
   Divers
   --------------------------------------------------------------------- */

function debounce(fn, ms){
  let t = null;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
  wrapped.flush = (...args) => { if(t){ clearTimeout(t); t = null; fn(...args); } };
  return wrapped;
}

function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

let uid = 0;
function makeId(prefix = "t"){
  uid++;
  return `${prefix}${Date.now().toString(36)}${uid.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* Version de l'application : la même valeur figure dans index.html (meta irrviz-version).
   À changer à chaque mise en ligne d'une évolution : un écart entre les deux révèle des
   scripts d'une ancienne version servis avec une page récente (cache). */
const VERSION = "2026.10.06-2";

IRR.util = {
  VERSION,
  DAY, YEAR_DAYS,
  ymdToMs, isoToMs, msToIso, parseDate, fmtDate, fmtMonth, todayMs, addMonths,
  parseNum,
  fmtEUR, fmtEUR3, fmtEURd, fmtNum, fmtNum2, fmtPct, fmtThreshold, escapeHtml,
  colorForReturn, rgbForReturn,
  debounce, clamp, makeId,
};

if(typeof module !== "undefined" && module.exports) module.exports = IRR.util;

})(typeof window !== "undefined" ? window : globalThis);
