/* =========================================================================
   IRRViz 2 — graphique SVG interactif.

   - Courbes de prix seuil par rendement cible, zones colorées entre seuils
   - Bougies OHLC de l'asset (ou ligne de clôture quand le zoom est trop large)
   - Marqueurs de transactions (cliquables : sélection dans la liste)
   - Survol : réticule, étiquettes de prix par seuil, pastilles d'axes, infobulle
     avec le TRI obtenu si l'on vendait au prix pointé
   - Zoom / déplacement : molette, pavé tactile, glisser, pincer (tactile),
     glisser sur l'axe des prix pour l'étirer, double-clic pour réinitialiser
   ========================================================================= */

(function(root){
"use strict";

const IRR = root.IRR = root.IRR || {};
const U = IRR.util;
const M = IRR.model;
const { DAY, clamp } = U;

const MIN_SPAN = 3 * DAY;
const MAX_SPAN = 80 * 365 * DAY;

function niceStep(range, targetTicks){
  const raw = range / Math.max(1, targetTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return step * mag;
}

function yTicks(min, max, plotH){
  const step = niceStep(max - min, clamp(plotH / 52, 3, 10));
  const decimals = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step) - 1e-9));
  const ticks = [];
  for(let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-6; v += step){
    ticks.push({ v, label: U.fmtEURd(Math.abs(v) < step * 1e-6 ? 0 : v, decimals) });
  }
  return { ticks, decimals };
}

const TICK_STEPS = [
  { unit: "day", n: 1 }, { unit: "day", n: 2 }, { unit: "day", n: 7 }, { unit: "day", n: 14 },
  { unit: "month", n: 1 }, { unit: "month", n: 2 }, { unit: "month", n: 3 }, { unit: "month", n: 6 },
  { unit: "year", n: 1 }, { unit: "year", n: 2 }, { unit: "year", n: 5 }, { unit: "year", n: 10 }, { unit: "year", n: 20 },
];
const UNIT_MS = { day: DAY, month: 30.44 * DAY, year: 365.25 * DAY };

function timeTicks(start, end, plotW){
  const target = Math.max(2, Math.floor(plotW / 92));
  const span = end - start;
  const st = TICK_STEPS.find(s => span / (s.n * UNIT_MS[s.unit]) <= target) || TICK_STEPS[TICK_STEPS.length - 1];
  const ticks = [];
  if(st.unit === "day"){
    let cur = Math.ceil(start / (st.n * DAY)) * st.n * DAY;
    for(; cur <= end; cur += st.n * DAY){
      const d = new Date(cur);
      const withYear = ticks.length === 0 || (d.getUTCMonth() === 0 && d.getUTCDate() <= st.n);
      ticks.push({ ms: cur, label: U.fmtDate(cur, withYear), major: d.getUTCDate() === 1 });
    }
  } else if(st.unit === "month"){
    const d = new Date(start);
    let y = d.getUTCFullYear(), mo = d.getUTCMonth();
    let cur = Date.UTC(y, mo, 1);
    while(cur < start || mo % st.n !== 0){ mo++; if(mo > 11){ mo = 0; y++; } cur = Date.UTC(y, mo, 1); }
    while(cur <= end){
      ticks.push({ ms: cur, label: U.fmtMonth(cur, mo === 0 || ticks.length === 0), major: mo === 0 });
      mo += st.n; while(mo > 11){ mo -= 12; y++; }
      cur = Date.UTC(y, mo, 1);
    }
  } else {
    let y = new Date(start).getUTCFullYear();
    y = Math.ceil(y / st.n) * st.n;
    for(let cur = Date.UTC(y, 0, 1); cur <= end; y += st.n, cur = Date.UTC(y, 0, 1)){
      if(cur >= start) ticks.push({ ms: cur, label: String(y), major: true });
    }
  }
  return ticks;
}

const f1 = v => (Math.round(v * 10) / 10).toString();

IRR.createChart = function createChart({ wrap, svg, tooltip, onSelectTx, onViewChange }){
  let input = null;
  let fullDomain = null;
  let view = null;          // fenêtre temporelle { start, end }
  let userZoomed = false;   // false = la vue suit automatiquement les données / l'horizon
  let yView = null;         // échelle de prix figée par l'utilisateur { min, max } (null = auto)
  let layout = null;
  let pricers = {};
  let markerHits = [];
  let hover = null;         // dernière position de survol { clientX, clientY }
  let renderQueued = false;

  /* ------------------------------------------------------------------ */

  function computeFullDomain(model){
    const today = U.todayMs();
    const horizon = Number.isFinite(input.horizonMs) ? input.horizonMs : today + 365 * DAY;
    const end = Math.max(horizon, model.lastMs, today);
    const pad = Math.max((end - model.d0) * 0.025, 2 * DAY);
    return { start: model.d0 - pad, end: end + pad };
  }

  function clampView(){
    let span = clamp(view.end - view.start, MIN_SPAN, MAX_SPAN);
    const c = (view.start + view.end) / 2;
    view.start = c - span / 2; view.end = c + span / 2;
    // La fenêtre doit toujours recouvrir au moins un peu le domaine des données.
    const fs = fullDomain.start, fe = fullDomain.end;
    const margin = span * 0.85;
    if(view.end < fs + span - margin){ const d = fs + span - margin - view.end; view.start += d; view.end += d; }
    if(view.start > fe - span + margin){ const d = view.start - (fe - span + margin); view.start -= d; view.end -= d; }
  }

  function requestRender(){
    if(renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  let viewNotifyTimer = null;
  function notifyView(){
    clearTimeout(viewNotifyTimer);
    viewNotifyTimer = setTimeout(() => onViewChange && onViewChange(getView()), 300);
  }

  function getView(){
    if(!userZoomed && !yView) return null;
    const v = {};
    if(userZoomed && view){ v.start = view.start; v.end = view.end; }
    if(yView){ v.yMin = yView.min; v.yMax = yView.max; }
    return v;
  }

  function restoreView(v){
    if(!v) return;
    if(Number.isFinite(v.start) && Number.isFinite(v.end)){ view = { start: v.start, end: v.end }; userZoomed = true; }
    if(Number.isFinite(v.yMin) && Number.isFinite(v.yMax)) yView = { min: v.yMin, max: v.yMax };
  }

  function resetView(which = "both"){
    if(which !== "y"){ userZoomed = false; view = fullDomain ? { ...fullDomain } : null; }
    if(which !== "x") yView = null;
    requestRender();
    notifyView();
  }

  /* ------------------------------------------------------------------
     Rendu
     ------------------------------------------------------------------ */

  function render(){
    const rect = wrap.getBoundingClientRect();
    const model = input && input.model;
    if(!model || rect.width < 40 || rect.height < 40){
      svg.innerHTML = ""; layout = null; markerHits = []; hideHover();
      return;
    }
    const width = Math.round(rect.width), height = Math.round(rect.height);
    const light = input.theme === "light";
    const lineShade = light ? -0.22 : 0;

    fullDomain = computeFullDomain(model);
    if(!view || !userZoomed) view = { ...fullDomain };
    clampView();

    const thresholds = input.thresholds;
    const feeFrac = input.feeFrac;
    pricers = {};
    thresholds.forEach(p => { pricers[p] = M.makePricer(model, p, feeFrac); });

    const resolution = clamp(Math.round(width - 80), 60, 1000);
    const segs = M.buildSegments(model, view.start, view.end, resolution);
    const curves = {};
    thresholds.forEach(p => { curves[p] = M.seriesForSegments(model, segs, p, feeFrac); });

    const candles = input.showCandles && input.candles && input.candles.length ? input.candles : null;

    // ---- Domaine des prix (auto : ajusté au contenu visible, ou figé par l'utilisateur) ----
    let lo = Infinity, hi = 0;
    const see = v => { if(Number.isFinite(v) && v > 0){ if(v < lo) lo = v; if(v > hi) hi = v; } };
    thresholds.forEach(p => curves[p].forEach(s => { if(s) s.forEach(see); }));
    model.points.forEach(p => {
      if(p.ms >= view.start && p.ms <= view.end) see(M.impliedPrice(p));
    });
    if(candles){
      candles.forEach(c => { if(c.ms >= view.start && c.ms <= view.end){ see(c.high); see(c.low); } });
    }
    if(!(hi > 0)){ lo = 0; hi = 1; }
    const pad = Math.max((hi - lo) * 0.12, hi * 0.02);
    let yMax = hi + pad;
    // L'axe démarre à 0 quand les prix couvrent une large plage, sinon on resserre sur les données.
    let yMin = lo - pad < hi * 0.35 ? 0 : lo - pad;
    if(yView){ yMin = yView.min; yMax = yView.max; }

    const top = 14, bottom = 28, right = 14;
    const plotH = height - top - bottom;
    const yt = yTicks(yMin, yMax, plotH);
    const maxLabel = yt.ticks.reduce((w, t) => Math.max(w, t.label.length), 4);
    const left = Math.round(clamp(maxLabel * 6.7 + 18, 52, 120));
    const m = { top, right, bottom, left };
    const plotW = width - left - right;

    const xScale = t => m.left + (t - view.start) / (view.end - view.start) * plotW;
    const yScale = p => m.top + plotH - (p - yMin) / (yMax - yMin) * plotH;
    const xInv = px => view.start + (px - m.left) / plotW * (view.end - view.start);
    const yInv = py => yMin + (m.top + plotH - py) / plotH * (yMax - yMin);
    // Coordonnées bornées pour éviter des valeurs gigantesques hors zone (le clip fait le reste).
    const ySafe = p => clamp(yScale(p), m.top - plotH, m.top + 2 * plotH);

    layout = { m, plotW, plotH, width, height, xScale, yScale, xInv, yInv, yMin, yMax, decimals: yt.decimals, lineShade, light };

    const out = [];
    out.push(`<defs>
      <clipPath id="irrClip"><rect x="${m.left}" y="${m.top}" width="${plotW}" height="${plotH}"/></clipPath>
      <pattern id="irrHatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="7" class="hatch-line"/></pattern>
    </defs>`);

    // ---- Grille ----
    out.push(`<g class="grid">`);
    yt.ticks.forEach(t => {
      const y = f1(yScale(t.v));
      out.push(`<line class="gridline" x1="${m.left}" x2="${m.left + plotW}" y1="${y}" y2="${y}"/>`);
    });
    const xt = timeTicks(view.start, view.end, plotW);
    xt.forEach(t => {
      const x = f1(xScale(t.ms));
      out.push(`<line class="gridline${t.major ? " major" : ""}" x1="${x}" x2="${x}" y1="${m.top}" y2="${m.top + plotH}"/>`);
    });
    out.push(`</g>`);

    out.push(`<g clip-path="url(#irrClip)">`);

    // ---- Périodes sans position (soldée) ----
    segs.forEach(seg => {
      if(!seg.gap) return;
      const x1 = xScale(seg.start), x2 = xScale(seg.end);
      out.push(`<rect class="gap-area" x="${f1(x1)}" y="${m.top}" width="${f1(Math.max(0, x2 - x1))}" height="${plotH}" fill="url(#irrHatch)"/>`);
    });

    // ---- Zones colorées entre seuils consécutifs ----
    if(input.showBands && thresholds.length){
      const n = thresholds.length;
      const inner = light ? 0.32 : 0.46, outer = light ? 0.14 : 0.2;
      for(let i = -1; i < n; i++){
        const lo = i >= 0 ? thresholds[i] : null;
        const up = i + 1 < n ? thresholds[i + 1] : null;
        const color = lo == null ? U.colorForReturn(up - 8)
                    : up == null ? U.colorForReturn(lo + 8)
                    : U.colorForReturn((lo + up) / 2);
        const op = (lo == null || up == null) ? outer : inner;
        segs.forEach((seg, idx) => {
          if(seg.gap) return;
          const upV = up == null ? null : curves[up][idx];
          const loV = lo == null ? null : curves[lo][idx];
          const pts = [];
          for(let j = 0; j < seg.ts.length; j++) pts.push(`${f1(xScale(seg.ts[j]))} ${f1(upV ? ySafe(upV[j]) : m.top - 2)}`);
          for(let j = seg.ts.length - 1; j >= 0; j--) pts.push(`${f1(xScale(seg.ts[j]))} ${f1(loV ? ySafe(loV[j]) : ySafe(Math.min(0, yMin)))}`);
          out.push(`<path d="M ${pts.join(" L ")} Z" fill="${color}" fill-opacity="${op}"/>`);
        });
      }
    }

    // ---- Asset : bougies ou ligne de clôture ----
    if(candles) drawCandles(out, candles, layout);

    out.push(`</g>`);

    // ---- Horizon et aujourd'hui ----
    const today = U.todayMs();
    const todayX = xScale(today);
    const todayVisible = todayX >= m.left && todayX <= m.left + plotW;
    if(Number.isFinite(input.horizonMs)){
      const hx = xScale(input.horizonMs);
      if(hx >= m.left && hx <= m.left + plotW && Math.abs(hx - todayX) > 2){
        out.push(`<line class="horizon-line" x1="${f1(hx)}" x2="${f1(hx)}" y1="${m.top}" y2="${m.top + plotH}"/>`);
        out.push(`<text class="line-tag horizon-tag" x="${f1(hx - 5)}" y="${m.top + 12}" text-anchor="end">horizon</text>`);
      }
    }
    if(todayVisible){
      out.push(`<line class="today-line" x1="${f1(todayX)}" x2="${f1(todayX)}" y1="${m.top}" y2="${m.top + plotH}"/>`);
      out.push(`<text class="line-tag today-tag" x="${f1(todayX + 5)}" y="${m.top + 12}">aujourd'hui</text>`);
    }

    // ---- Courbes ----
    out.push(`<g clip-path="url(#irrClip)" class="curves">`);
    thresholds.forEach(p => {
      const color = U.colorForReturn(p, lineShade);
      const strong = p === 0;
      segs.forEach((seg, idx) => {
        const vals = curves[p][idx];
        if(!vals) return;
        const d = seg.ts.map((t, j) => `${f1(xScale(t))} ${f1(ySafe(vals[j]))}`).join(" L ");
        out.push(`<path d="M ${d}" fill="none" stroke="${color}" stroke-width="${strong ? 2.4 : 1.8}" stroke-linejoin="round"/>`);
      });
    });
    out.push(`</g>`);

    // ---- Marqueurs de transactions ----
    markerHits = [];
    out.push(`<g class="markers">`);
    model.points.forEach(p => {
      const x = xScale(p.ms);
      if(x < m.left - 6 || x > m.left + plotW + 6) return;
      const hl = input.highlightId && p.id === input.highlightId;
      if(!p.quantity){
        const y = m.top + plotH;
        out.push(`<path class="mk mk-cash${p.amount < 0 ? " neg" : ""}" d="M ${f1(x - 5.5)} ${y} L ${f1(x + 5.5)} ${y} L ${f1(x)} ${y - 10} Z"/>`);
        if(hl) out.push(`<circle class="mk-ring" cx="${f1(x)}" cy="${y - 4}" r="10"/>`);
        markerHits.push({ x, y: y - 4, r: 9, id: p.id, point: p });
      } else {
        const price = M.impliedPrice(p);
        const y = clamp(yScale(price), m.top, m.top + plotH);
        const buy = p.quantity > 0;
        out.push(`<circle class="mk ${buy ? "mk-buy" : "mk-sell"}" cx="${f1(x)}" cy="${f1(y)}" r="${hl ? 6.5 : 5}"/>`);
        if(hl) out.push(`<circle class="mk-ring" cx="${f1(x)}" cy="${f1(y)}" r="11"/>`);
        markerHits.push({ x, y, r: 9, id: p.id, point: p, price });
      }
    });
    out.push(`</g>`);

    // ---- Axes ----
    out.push(`<g class="axes">`);
    yt.ticks.forEach(t => {
      out.push(`<text class="axis" x="${m.left - 8}" y="${f1(yScale(t.v) + 4)}" text-anchor="end">${t.label}</text>`);
    });
    let lastRight = -Infinity;
    xt.forEach(t => {
      const x = xScale(t.ms);
      const w = t.label.length * 6.2;
      if(x - w / 2 < lastRight + 6 || x < m.left - 2 || x > m.left + plotW + 2) return;
      lastRight = x + w / 2;
      out.push(`<text class="axis${t.major ? " major" : ""}" x="${f1(x)}" y="${m.top + plotH + 18}" text-anchor="middle">${t.label}</text>`);
    });
    out.push(`<line class="axis-line" x1="${m.left}" x2="${m.left}" y1="${m.top}" y2="${m.top + plotH}"/>`);
    out.push(`<line class="axis-line" x1="${m.left}" x2="${m.left + plotW}" y1="${m.top + plotH}" y2="${m.top + plotH}"/>`);
    out.push(`</g>`);

    // ---- Étiquettes de prix permanentes (aujourd'hui, ou bord de la vue) ----
    if(input.showLabels && thresholds.length){
      let anchorMs = today, anchorX = todayX, edgeNote = null;
      if(!todayVisible){
        anchorMs = today > view.end ? view.end : view.start;
        anchorX = today > view.end ? m.left + plotW : m.left;
        edgeNote = U.fmtDate(anchorMs);
      }
      out.push(`<g class="price-labels${todayVisible ? "" : " at-edge"}">${labelsAt(anchorMs, anchorX, { edgeNote, dots: todayVisible })}</g>`);
    }

    out.push(`<g class="hover-layer"></g>`);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.innerHTML = out.join("");

    if(hover) drawHover(hover);
  }

  function drawCandles(out, candles, L){
    const { xScale, yScale, m, plotW, yMax } = L;
    const vis = [];
    for(const c of candles){ if(c.ms >= view.start - 2 * DAY && c.ms <= view.end + 2 * DAY) vis.push(c); }
    if(!vis.length) return;
    const step = vis.length >= 2 ? (vis[vis.length - 1].ms - vis[0].ms) / (vis.length - 1) : DAY;
    const stepPx = step / (view.end - view.start) * plotW;
    if(stepPx < 3.2){
      // Trop de bougies pour être lisibles : ligne de clôture + enveloppe haut/bas.
      const hi = vis.map(c => `${f1(xScale(c.ms))} ${f1(yScale(Math.min(c.high, yMax * 2)))}`);
      const lo = vis.slice().reverse().map(c => `${f1(xScale(c.ms))} ${f1(yScale(Math.max(c.low, 0)))}`);
      out.push(`<path class="asset-range" d="M ${hi.join(" L ")} L ${lo.join(" L ")} Z"/>`);
      out.push(`<path class="asset-close" d="M ${vis.map(c => `${f1(xScale(c.ms))} ${f1(yScale(c.close))}`).join(" L ")}"/>`);
      return;
    }
    const bodyW = clamp(stepPx * 0.68, 2, 16);
    for(const c of vis){
      const cx = xScale(c.ms);
      if(cx < m.left - bodyW || cx > m.left + plotW + bodyW) continue;
      const up = c.close >= c.open;
      const yO = yScale(c.open), yC = yScale(c.close);
      const yTop = Math.min(yO, yC), h = Math.max(1, Math.abs(yO - yC));
      const cls = up ? "candle-up" : "candle-down";
      out.push(`<line class="wick ${cls}" x1="${f1(cx)}" x2="${f1(cx)}" y1="${f1(yScale(c.high))}" y2="${f1(yScale(Math.max(0, c.low)))}"/>`);
      out.push(`<rect class="candle-body ${cls}" x="${f1(cx - bodyW / 2)}" y="${f1(yTop)}" width="${f1(bodyW)}" height="${f1(h)}" rx="1"/>`);
    }
  }

  /* Étiquettes "seuil · prix" le long d'une verticale (aujourd'hui ou survol).
     Les étiquettes sont écartées verticalement pour ne pas se chevaucher et
     restent dans la zone de tracé ; un trait relie l'étiquette à la courbe. */
  let labelsFlipped = false;
  function labelsAt(ms, anchorX, { edgeNote = null, dots = true } = {}){
    const L = layout;
    const { m, plotW, plotH, yScale, lineShade } = L;
    const items = [];
    input.thresholds.forEach(p => {
      const val = pricers[p] ? pricers[p](ms) : null;
      if(val == null) return;
      const yRaw = yScale(val);
      const y0 = clamp(yRaw, m.top + 8, m.top + plotH - 8);
      const arrow = yRaw < m.top ? "▲ " : yRaw > m.top + plotH ? "▼ " : "";
      items.push({ p, val, yRaw, y0, y: y0, text: `${arrow}${U.fmtThreshold(p)} · ${U.fmtEUR3.format(val)}` });
    });
    if(!items.length) return "";
    const gap = 17;
    items.sort((a, b) => a.y - b.y);
    for(let i = 1; i < items.length; i++) if(items[i].y - items[i - 1].y < gap) items[i].y = items[i - 1].y + gap;
    const maxY = m.top + plotH - 8;
    if(items[items.length - 1].y > maxY){
      items[items.length - 1].y = maxY;
      for(let i = items.length - 2; i >= 0; i--) if(items[i + 1].y - items[i].y < gap) items[i].y = items[i + 1].y - gap;
    }

    const parts = [];
    const boxH = 16;
    const widest = items.reduce((w, it) => Math.max(w, it.text.length * 6.1 + 14), 0);
    const flip = anchorX + 10 + widest > m.left + plotW + m.right - 2;
    labelsFlipped = flip;
    if(edgeNote){
      const tx = flip ? anchorX - 10 : anchorX + 10;
      parts.push(`<text class="edge-note" x="${f1(tx)}" y="${m.top + 26}" text-anchor="${flip ? "end" : "start"}">au ${edgeNote}</text>`);
    }
    items.forEach(it => {
      const color = U.colorForReturn(it.p, lineShade);
      const w = it.text.length * 6.1 + 14;
      const bx = flip ? anchorX - 10 - w : anchorX + 10;
      const lx = flip ? bx + w : bx;
      parts.push(`<path class="label-leader" d="M ${f1(anchorX)} ${f1(it.y0)} L ${f1(lx)} ${f1(it.y)}" stroke="${color}"/>`);
      parts.push(`<rect class="label-box" x="${f1(bx)}" y="${f1(it.y - boxH / 2)}" width="${f1(w)}" height="${boxH}" rx="5" stroke="${color}"/>`);
      parts.push(`<text class="label-text" x="${f1(bx + w / 2)}" y="${f1(it.y + 4)}" text-anchor="middle" fill="${color}">${it.text}</text>`);
      if(dots && it.yRaw >= m.top && it.yRaw <= m.top + plotH){
        parts.push(`<circle class="label-dot" cx="${f1(anchorX)}" cy="${f1(it.yRaw)}" r="3.2" fill="${color}"/>`);
      }
    });
    return parts.join("");
  }

  /* ------------------------------------------------------------------
     Survol
     ------------------------------------------------------------------ */

  function toLocal(clientX, clientY){
    const r = svg.getBoundingClientRect();
    return { px: (clientX - r.left) * layout.width / r.width, py: (clientY - r.top) * layout.height / r.height };
  }

  function markerAt(px, py){
    let best = null, bestD = Infinity;
    for(const h of markerHits){
      const d = Math.hypot(h.x - px, h.y - py);
      if(d <= h.r && d < bestD){ best = h; bestD = d; }
    }
    return best;
  }

  function candleAt(ms){
    const cs = input.showCandles && input.candles;
    if(!cs || !cs.length) return null;
    let lo = 0, hi = cs.length - 1;
    while(lo < hi){ const mid = (lo + hi) >> 1; if(cs[mid].ms < ms) lo = mid + 1; else hi = mid; }
    let best = cs[lo];
    if(lo > 0 && Math.abs(cs[lo - 1].ms - ms) < Math.abs(best.ms - ms)) best = cs[lo - 1];
    return Math.abs(best.ms - ms) <= 0.75 * DAY ? best : null;
  }

  function hideHover(){
    hover = null;
    tooltip.classList.add("hidden");
    const g = svg.querySelector(".hover-layer");
    if(g) g.innerHTML = "";
    wrap.classList.remove("on-marker", "hovering");
  }

  function row(k, v, cls = ""){ return `<div class="tt-row${cls ? " " + cls : ""}"><span class="tt-k">${k}</span><span class="tt-v">${v}</span></div>`; }

  function irrRow(ms, price){
    const model = input.model;
    if(ms <= model.d0 + DAY) return "";
    const r = M.irrForSale(model, ms, price, input.feeFrac);
    if(r == null) return "";
    const cls = r >= 0 ? "pos" : "neg";
    const shown = r > 9999 ? "> +9 999 %" : U.fmtPct(r);
    return row("TRI si vente à ce prix", `<b class="${cls}">${shown}</b><span class="tt-unit"> /an</span>`, "tt-irr");
  }

  function drawHover(h){
    if(!layout) return;
    const g = svg.querySelector(".hover-layer");
    if(!g) return;
    const L = layout;
    const { m, plotW, plotH, xInv, yInv, xScale, yScale } = L;
    const { px: rawX, py: rawY } = toLocal(h.clientX, h.clientY);
    if(rawX < 0 || rawY < 0 || rawX > L.width || rawY > L.height){ hideHover(); return; }
    const px = clamp(rawX, m.left, m.left + plotW);
    const py = clamp(rawY, m.top, m.top + plotH);
    const model = input.model;

    const marker = markerAt(rawX, rawY);
    const ms = marker ? marker.point.ms : Math.round(xInv(px) / DAY) * DAY;
    const cx = marker ? marker.x : xScale(ms);
    const candle = marker ? null : candleAt(ms);
    const price = marker && marker.price != null ? marker.price : yInv(py);
    const cy = marker && marker.price != null ? marker.y : py;

    const parts = [];
    parts.push(`<line class="crosshair" x1="${f1(cx)}" x2="${f1(cx)}" y1="${m.top}" y2="${m.top + plotH}"/>`);
    parts.push(`<line class="crosshair" x1="${m.left}" x2="${m.left + plotW}" y1="${f1(cy)}" y2="${f1(cy)}"/>`);
    let labelSide = 0; // côté occupé par les étiquettes : 1 = droite, -1 = gauche, 0 = aucune
    if(!marker && input.thresholds.length){
      const lbl = labelsAt(ms, cx);
      if(lbl){ parts.push(lbl); labelSide = labelsFlipped ? -1 : 1; }
    }
    if(marker) parts.push(`<circle class="mk-ring" cx="${f1(marker.x)}" cy="${f1(marker.y)}" r="11"/>`);
    if(candle) parts.push(`<circle class="candle-dot" cx="${f1(cx)}" cy="${f1(yScale(candle.close))}" r="3.5"/>`);

    // Pastilles sur les axes (date en bas, prix à gauche)
    const dateTxt = U.fmtDate(ms);
    const dw = dateTxt.length * 6.3 + 14;
    const dx = clamp(cx - dw / 2, m.left, m.left + plotW - dw);
    parts.push(`<rect class="axis-pill" x="${f1(dx)}" y="${m.top + plotH + 4}" width="${f1(dw)}" height="18" rx="4"/>`);
    parts.push(`<text class="axis-pill-text" x="${f1(dx + dw / 2)}" y="${m.top + plotH + 17}" text-anchor="middle">${dateTxt}</text>`);
    const priceTxt = U.fmtEURd(price, Math.max(2, L.decimals + 1));
    const pw = Math.max(m.left - 4, priceTxt.length * 6.3 + 12);
    parts.push(`<rect class="axis-pill" x="${f1(m.left - pw - 1)}" y="${f1(cy - 9)}" width="${f1(pw)}" height="18" rx="4"/>`);
    parts.push(`<text class="axis-pill-text" x="${f1(m.left - 6)}" y="${f1(cy + 4)}" text-anchor="end">${priceTxt}</text>`);
    g.innerHTML = parts.join("");

    // ---- Infobulle ----
    let html;
    if(marker){
      const p = marker.point;
      const kind = M.txKind(p);
      const kindLabel = { buy: "Achat", sell: "Vente", income: "Flux entrant", cost: "Frais / flux sortant" }[kind];
      html = `<div class="tt-head"><span>${U.fmtDate(p.ms)}</span><span class="tt-badge k-${kind}">${kindLabel}</span></div>`;
      html += row("Montant", U.fmtEUR.format(p.amount));
      if(p.quantity){
        html += row("Quantité", U.fmtNum.format(p.quantity));
        html += row("Prix unitaire", U.fmtEUR3.format(marker.price));
      }
      html += row("Position après", U.fmtNum.format(p.cumQty));
      html += `<div class="tt-foot">Cliquer pour retrouver la transaction</div>`;
    } else if(candle){
      const ch = candle.close - candle.open;
      const chPct = candle.open ? ch / candle.open * 100 : 0;
      html = `<div class="tt-head"><span>${U.fmtDate(candle.ms)}</span><span class="tt-badge k-asset">${U.escapeHtml(input.ticker || "Asset")}</span></div>`;
      html += row("Ouverture", U.fmtEUR3.format(candle.open));
      html += row("Plus haut", U.fmtEUR3.format(candle.high));
      html += row("Plus bas", U.fmtEUR3.format(candle.low));
      html += row("Clôture", `<b>${U.fmtEUR3.format(candle.close)}</b>`);
      html += row("Variation", `<span class="${ch >= 0 ? "pos" : "neg"}">${U.fmtPct(chPct)}</span>`);
      const irr = irrRow(candle.ms, candle.close);
      if(irr) html += `<div class="tt-sep"></div>` + irr.replace("à ce prix", "à la clôture");
    } else {
      html = `<div class="tt-head"><span>${U.fmtDate(ms)}</span></div>`;
      html += row("Prix pointé", `<b>${U.fmtEUR3.format(price)}</b>`);
      if(ms >= model.d0){
        const k = M.indexAt(model, ms);
        const qty = k >= 0 ? model.points[k].cumQty : 0;
        html += row("Position", Math.abs(qty) > 0 ? U.fmtNum.format(qty) : "soldée");
        html += irrRow(ms, price);
      } else {
        html += `<div class="tt-foot">Avant la première transaction</div>`;
      }
    }
    tooltip.innerHTML = html;
    tooltip.classList.remove("hidden");
    wrap.classList.toggle("on-marker", !!marker);
    wrap.classList.add("hovering");

    // Positionnement : à droite du curseur, bascule à gauche / vers le bas près des bords.
    const wr = wrap.getBoundingClientRect();
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    const lx = h.clientX - wr.left, ly = h.clientY - wr.top;
    // L'infobulle se place du côté opposé aux étiquettes de seuils pour ne pas les masquer.
    const left = lx - tw - 18, right = lx + 18;
    let tx = labelSide === 1 ? left : right;
    if(tx < 6) tx = right;
    if(tx + tw > wr.width - 6) tx = left;
    if(tx < 6) tx = 6;
    let ty = ly - th - 14;
    if(ty < 6) ty = Math.min(ly + 18, wr.height - th - 6);
    tooltip.style.transform = `translate(${Math.round(tx)}px, ${Math.round(ty)}px)`;
  }

  /* ------------------------------------------------------------------
     Zoom / déplacement
     ------------------------------------------------------------------ */

  function zoomX(factor, anchorMs){
    if(!view) return;
    if(anchorMs == null) anchorMs = (view.start + view.end) / 2;
    let span = clamp((view.end - view.start) * factor, MIN_SPAN, MAX_SPAN);
    const ratio = (anchorMs - view.start) / (view.end - view.start);
    view = { start: anchorMs - ratio * span, end: anchorMs + (1 - ratio) * span };
    userZoomed = true;
    requestRender(); notifyView();
  }

  function zoomY(factor, anchorPrice){
    if(!layout) return;
    const cur = yView || { min: layout.yMin, max: layout.yMax };
    if(anchorPrice == null) anchorPrice = (cur.min + cur.max) / 2;
    let min = anchorPrice - (anchorPrice - cur.min) * factor;
    let max = anchorPrice + (cur.max - anchorPrice) * factor;
    min = Math.max(0, min);
    const minSpan = Math.max(1e-4, (cur.max - cur.min) * 0.01);
    if(max - min < minSpan) max = min + minSpan;
    yView = { min, max };
    requestRender(); notifyView();
  }

  function panX(fraction){
    if(!view) return;
    const d = (view.end - view.start) * fraction;
    view = { start: view.start + d, end: view.end + d };
    userZoomed = true;
    requestRender(); notifyView();
  }

  function panY(fraction){
    if(!layout) return;
    const cur = yView || { min: layout.yMin, max: layout.yMax };
    let d = (cur.max - cur.min) * fraction;
    if(cur.min + d < 0) d = -cur.min;
    yView = { min: cur.min + d, max: cur.max + d };
    requestRender(); notifyView();
  }

  const pointers = new Map();
  let drag = null, pinch = null;

  svg.addEventListener("pointerdown", e => {
    if(!layout || (e.pointerType === "mouse" && e.button !== 0)) return;
    wrap.focus({ preventScroll: true });
    try{ svg.setPointerCapture(e.pointerId); }catch(err){ /* ignore */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if(pointers.size === 1){
      const { px, py } = toLocal(e.clientX, e.clientY);
      drag = {
        x0: e.clientX, y0: e.clientY, moved: false, type: e.pointerType,
        view0: { ...view }, y0dom: { min: layout.yMin, max: layout.yMax },
        onYAxis: px < layout.m.left && py >= layout.m.top && py <= layout.m.top + layout.plotH,
        anchorPrice: layout.yInv(clamp(py, layout.m.top, layout.m.top + layout.plotH)),
      };
    } else if(pointers.size === 2){
      drag = null;
      const [a, b] = [...pointers.values()];
      const c = toLocal((a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch = { d0: Math.max(10, Math.abs(a.x - b.x)), view0: { ...view }, anchorMs: layout.xInv(c.px) };
      hideHover();
    }
  });

  svg.addEventListener("pointermove", e => {
    if(pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if(!layout) return;
    if(pinch && pointers.size >= 2){
      const [a, b] = [...pointers.values()];
      const d = Math.max(10, Math.abs(a.x - b.x));
      const span = clamp((pinch.view0.end - pinch.view0.start) * pinch.d0 / d, MIN_SPAN, MAX_SPAN);
      const c = toLocal((a.x + b.x) / 2, (a.y + b.y) / 2);
      const ratio = (c.px - layout.m.left) / layout.plotW;
      view = { start: pinch.anchorMs - ratio * span, end: pinch.anchorMs + (1 - ratio) * span };
      userZoomed = true;
      requestRender(); notifyView();
      return;
    }
    if(drag){
      const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
      if(!drag.moved && Math.hypot(dx, dy) < 4) return;
      if(!drag.moved){ drag.moved = true; wrap.classList.add("is-dragging"); hideHover(); }
      const r = svg.getBoundingClientRect();
      const sx = layout.width / r.width, sy = layout.height / r.height;
      if(drag.onYAxis){
        // Glisser sur l'axe des prix : étire (vers le haut) ou compresse l'échelle.
        const f = Math.exp(dy * sy * 0.006);
        const a = drag.anchorPrice;
        let min = Math.max(0, a - (a - drag.y0dom.min) * f);
        let max = a + (drag.y0dom.max - a) * f;
        if(max - min < 1e-4) max = min + 1e-4;
        yView = { min, max };
      } else {
        const dMs = -dx * sx / layout.plotW * (drag.view0.end - drag.view0.start);
        view = { start: drag.view0.start + dMs, end: drag.view0.end + dMs };
        userZoomed = true;
        const ySpan = drag.y0dom.max - drag.y0dom.min;
        let min = drag.y0dom.min + dy * sy / layout.plotH * ySpan;
        if(min < 0) min = 0;
        // Un glisser essentiellement horizontal ne fige pas l'échelle des prix automatique.
        if(yView || Math.abs(dy) > 12) yView = { min, max: min + ySpan };
      }
      requestRender(); notifyView();
      return;
    }
    if(e.pointerType === "mouse"){
      hover = { clientX: e.clientX, clientY: e.clientY };
      drawHover(hover);
      const { px, py } = toLocal(e.clientX, e.clientY);
      wrap.classList.toggle("on-yaxis", px < layout.m.left && py >= layout.m.top && py <= layout.m.top + layout.plotH);
    }
  });

  function endPointer(e){
    const wasDrag = drag;
    pointers.delete(e.pointerId);
    if(pointers.size < 2) pinch = null;
    if(pointers.size === 0){
      drag = null;
      wrap.classList.remove("is-dragging");
    }
    if(wasDrag && !wasDrag.moved && e.type === "pointerup" && layout){
      const { px, py } = toLocal(e.clientX, e.clientY);
      const hit = markerAt(px, py);
      if(hit && onSelectTx) onSelectTx(hit.id);
      if(e.pointerType !== "mouse"){ hover = { clientX: e.clientX, clientY: e.clientY }; drawHover(hover); }
    }
  }
  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);
  svg.addEventListener("pointerleave", e => {
    if(e.pointerType === "mouse" && !drag){ hideHover(); wrap.classList.remove("on-yaxis"); }
  });

  svg.addEventListener("wheel", e => {
    if(!layout) return;
    e.preventDefault();
    const { px, py } = toLocal(e.clientX, e.clientY);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    let dx = e.deltaX * unit, dy = e.deltaY * unit;
    if(e.shiftKey && !dy){ dy = dx; dx = 0; }
    const { m, plotW, plotH } = layout;
    if(!e.shiftKey && !e.ctrlKey && Math.abs(dx) > Math.abs(dy)){
      panX(dx / plotW);
      return;
    }
    const factor = Math.exp(clamp(dy, -300, 300) * (e.ctrlKey ? 0.01 : 0.0018));
    if(e.shiftKey || px < m.left){
      zoomY(factor, layout.yInv(clamp(py, m.top, m.top + plotH)));
    } else {
      zoomX(factor, layout.xInv(clamp(px, m.left, m.left + plotW)));
    }
    if(hover) hover = { clientX: e.clientX, clientY: e.clientY };
  }, { passive: false });

  svg.addEventListener("dblclick", e => {
    if(!layout) return;
    const { px } = toLocal(e.clientX, e.clientY);
    resetView(px < layout.m.left ? "y" : "both");
  });

  wrap.addEventListener("keydown", e => {
    if(e.target !== wrap || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    let handled = true;
    if(k === "ArrowLeft") panX(e.shiftKey ? -0.3 : -0.1);
    else if(k === "ArrowRight") panX(e.shiftKey ? 0.3 : 0.1);
    else if(k === "ArrowUp") panY(0.1);
    else if(k === "ArrowDown") panY(-0.1);
    else if(k === "+" || k === "=") zoomX(1 / 1.25);
    else if(k === "-" || k === "_") zoomX(1.25);
    else handled = false;
    if(handled) e.preventDefault();
  });

  if(root.ResizeObserver) new ResizeObserver(() => requestRender()).observe(wrap);
  else root.addEventListener("resize", requestRender);

  return {
    setInput(next){ input = next; requestRender(); },
    render,
    requestRender,
    resetView,
    zoomIn(){ zoomX(1 / 1.35); },
    zoomOut(){ zoomX(1.35); },
    panX,
    getView,
    restoreView,
    isZoomed(){ return userZoomed || !!yView; },
  };
};

})(typeof window !== "undefined" ? window : globalThis);
