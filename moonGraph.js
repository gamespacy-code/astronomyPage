// /livewetter/astronomie/mond/moonGraph.js

window.drawMoonGraph = function(canvas, moon) {

    if (!canvas || !moon || !moon.fineElevation) {
        console.warn("moonGraph: Canvas oder Mond-Daten fehlen");
        return;
    }
    
    window.currentMoonData = moon;

  const ctx = canvas.getContext('2d');
  // persist last payload for debugging and external checks
  try { window.__lastDrawMoonGraphPayload = moon || null; } catch(e) {}

    // HiDPI scaling: compute CSS size and scale canvas backing store by devicePixelRatio
const dpr = window.devicePixelRatio || 1;

// get CSS size (fallback to attributes if style not set)
const rect = canvas.getBoundingClientRect();
const cssW = rect && rect.width ? rect.width : (canvas.width || 300);
const cssH = rect && rect.height ? rect.height : (canvas.height || 150);

// set backing store size in device pixels
canvas.width = Math.round(cssW * dpr);
canvas.height = Math.round(cssH * dpr);

// keep CSS size for layout
canvas.style.width = cssW + "px";
canvas.style.height = cssH + "px";

// scale drawing context so 1 unit = 1 CSS pixel
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

// use CSS sizes for all subsequent layout math
const W = cssW;
const H = cssH;

    function formatHM(decimalTime) {
  const t = (typeof decimalTime === 'number' && isFinite(decimalTime)) ? decimalTime : 0;
  const norm = ((t % 24) + 24) % 24;
  let hh = Math.floor(norm);
  let mm = Math.round((norm - hh) * 60);
  if (mm === 60) { mm = 0; hh = (hh + 1) % 24; }
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}

    const leftPad   = 28;
    const rightPad  = 12;
    const topPad    = 10;
    const bottomPad = 20;

    const innerW = W - leftPad - rightPad;
    const innerH = H - topPad - bottomPad;

    const maxElev = 85;
    const minElev = -85;

    // Map minute (0..1439) to pixel inside inner drawing area.
    // Use minutes as canonical unit to avoid timezone/date confusion.
    const xMinute = (minute) => {
      try {
        if (!Number.isFinite(minute)) return null;
        const m = ((Math.round(minute) % 1440) + 1440) % 1440;
        return leftPad + (m / 1440) * innerW;
      } catch (e) { return null; }
    };

    // hoursFloat may be fractional hours (0..24). Convert to minutes and delegate.
    const xHour = (hoursFloat) => {
      try {
        const hf = Number(hoursFloat);
        if (!Number.isFinite(hf)) return null;
        return xMinute(hf * 60);
      } catch (e) { return null; }
    };

    const yElev = e => {
        const norm = (e - minElev) / (maxElev - minElev);
        return topPad + (1 - norm) * innerH;
    };

    // Export renderer layout and safe xHour for external use
try {
  const layout = { leftPad: leftPad, rightPad: rightPad, topPad: topPad, bottomPad: bottomPad, innerW: innerW, innerH: innerH, canvasWidth: W, canvasHeight: H, devicePixelRatio: window.devicePixelRatio || 1 };
  try { Object.defineProperty(window, '__moonGraph_layout', { value: layout, writable: false, configurable: false, enumerable: true }); } catch(e){ window.__moonGraph_layout = layout; }
  try { Object.defineProperty(window, '__moonGraph_xHour', { value: function(h){ try { return xHour(h); } catch(e){ return leftPad; } }, writable: false, configurable: false, enumerable: false }); } catch(e){ window.__moonGraph_xHour = function(h){ try { return xHour(h); } catch(e){ return leftPad; } }; }
  try { Object.defineProperty(window, '__moonGraph_xMinute', { value: function(m){ try { return xMinute(m); } catch(e){ return leftPad; } }, writable: false, configurable: false, enumerable: false }); } catch(e){ window.__moonGraph_xMinute = function(m){ try { return xMinute(m); } catch(e){ return leftPad; } }; }
} catch(e){}

    // Hintergrund
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#eaf4ff";
    ctx.fillRect(leftPad, topPad, innerW, innerH);

    // ----------------------------
    // Normalize timeline and draw night/phase overlays (minutes-based)
    // ----------------------------
    const panel = window.moonPanel;
    const toMinutes = v => { if (!Number.isFinite(v)) return null; return Math.abs(v) <= 24 ? Math.round(v * 60) : Math.round(v); };
    const normalizeTimelineToMinutes = (raw) => {
      if (!raw) return null;
      if (Array.isArray(raw)) return raw.map(s => ({ ...s, start: toMinutes(s.start), end: s.end === 24 ? 1440 : toMinutes(s.end) }));
      const out = {};
      for (const k of Object.keys(raw)) {
        out[k] = (raw[k] || []).map(seg => {
          if (Array.isArray(seg) && seg.length >= 2) return [ toMinutes(seg[0]), seg[1] === 24 ? 1440 : toMinutes(seg[1]) ];
          if (seg && typeof seg === 'object') return [ toMinutes(seg.start), seg.end === 24 ? 1440 : toMinutes(seg.end) ];
          return null;
        }).filter(Boolean);
      }
      return out;
    };

    const timelineRaw = (moon && moon.sunPhaseTimeline) || (panel && panel.sunPhaseTimeline) || null;
    const effectiveTimeline = normalizeTimelineToMinutes(timelineRaw);

    // compute sunrise/sunset minutes (prefer explicit values, otherwise derive from timeline)
    let sunriseMin = Number.isFinite(moon?.sunrise) ? toMinutes(moon.sunrise) : (Number.isFinite(panel?.lastSunrise) ? toMinutes(panel.lastSunrise) : null);
    let sunsetMin  = Number.isFinite(moon?.sunset)  ? toMinutes(moon.sunset)  : (Number.isFinite(panel?.lastSunset)  ? toMinutes(panel.lastSunset)  : null);
    if ((!Number.isFinite(sunriseMin) || !Number.isFinite(sunsetMin)) && effectiveTimeline) {
      // try to derive from effectiveTimeline.day if present
      const dayRanges = effectiveTimeline.day || [];
      if (dayRanges.length) {
        sunriseMin = sunriseMin ?? dayRanges[0][0] ?? dayRanges[0].start;
        const last = dayRanges[dayRanges.length - 1];
        sunsetMin = sunsetMin ?? ((last[1] === 1440) ? 1439 : (last[1] - 1));
      }
    }

    // draw night band (wrap-aware)
    ctx.fillStyle = "#00264a";
    if (Number.isFinite(sunriseMin) && Number.isFinite(sunsetMin)) {
      const s = ((sunriseMin % 1440) + 1440) % 1440;
      const e = ((sunsetMin  % 1440) + 1440) % 1440;
      const xS = xHour(s / 60);
      const xE = xHour(e / 60);
      if (s <= e) {
        ctx.fillRect(leftPad, topPad, xS - leftPad, innerH);
        ctx.fillRect(xE, topPad, (W - rightPad) - xE, innerH);
      } else {
        // night between sunset and sunrise (wrap)
        ctx.fillRect(xE, topPad, xS - xE, innerH);
      }
    }

    // Sonnenhöhe für Dämmerungszonen: prefer effectiveTimeline (minutes) else compute from sunFineElevation
    const baseBlue  = a => `rgba(33,141,255,${a})`;
    const baseBlue2 = a => `rgba(38,143,255,${a})`;
    const goldColor = a => `rgba(255,200,0,${a})`;

  // Helper: canonical minute->label formatter
  const labelForMinute = (m) => {
    const mm = ((Math.round(m) % 1440) + 1440) % 1440;
    const hh = Math.floor(mm / 60);
    const mn = Math.round(mm % 60);
    return `${String(hh).padStart(2,'0')}:${String(mn).padStart(2,'0')}`;
  };
    
    // Robust gradient drawer: normalizes minutes, tolerates subpixel widths and falls back to a faint fill
    const drawGradientForMinuteRange = (sMin, eMin, alphaStart, alphaEnd, baseColor) => {
      if (!Number.isFinite(sMin) || !Number.isFinite(eMin)) return;
      const s = ((Math.round(sMin) % 1440) + 1440) % 1440;
      const e = ((Math.round(eMin) % 1440) + 1440) % 1440;

      const safeX = (minute) => {
        if (!Number.isFinite(minute)) return null;
        try {
          const m = ((Math.round(minute) % 1440) + 1440) % 1440;
          const px = xHour(m / 60);
          return Number.isFinite(px) ? px : null;
        } catch (err) {
          return null;
        }
      };

      const drawSeg = (a, b) => {
        const x1 = safeX(a);
        const x2 = safeX(b);
        if (x1 === null && x2 === null) return;
        const left = (x1 === null) ? (x2 - 1) : Math.min(x1, x2 === null ? x1 + 1 : x2);
        const right = (x2 === null) ? (x1 + 1) : Math.max(x1 === null ? x2 - 1 : x1, x2);
        const width = Math.max(1, right - left);
        try {
          const grad = ctx.createLinearGradient(left, 0, left + width, 0);
          const c0 = (typeof baseColor === 'function') ? baseColor(alphaStart) : baseColor;
          const c1 = (typeof baseColor === 'function') ? baseColor(alphaEnd) : baseColor;
          // If colors are identical or invalid, draw a faint fill instead of an invisible gradient
          if (!c0 || !c1 || String(c0) === String(c1)) {
            ctx.fillStyle = c0 || 'rgba(200,200,200,0.18)';
            ctx.fillRect(left, topPad, width, innerH);
          } else {
            grad.addColorStop(0, c0);
            grad.addColorStop(1, c1);
            ctx.fillStyle = grad;
            ctx.fillRect(left, topPad, width, innerH);
          }
        } catch (e) {
          // final fallback: faint rectangle so zone remains visible
          try { ctx.fillStyle = 'rgba(200,200,200,0.18)'; ctx.fillRect(left, topPad, width, innerH); } catch(err){}
          if (window.console && window.console.warn) window.console.warn('gradient draw fallback used', e);
        }
      };

      if (s <= e) drawSeg(s, e);
      else { drawSeg(s, 1440); drawSeg(0, e); }
    };

    // If effectiveTimeline exists (minutes), draw ranges from it using sunGraph style
    if (effectiveTimeline && (Array.isArray(effectiveTimeline.day) || Array.isArray(effectiveTimeline.civil) || Array.isArray(effectiveTimeline.golden))) {
      // helper: split intervals into morning/evening
      const splitIntervals = (intervals) => {
        const morning = [], evening = [];
        (intervals || []).forEach(([i1, i2]) => {
          const mid = (i1 + i2) / 2;
          if (mid < 720) morning.push([i1, i2]); else evening.push([i1, i2]);
        });
        return { morning, evening };
      };

      // helper: draw gradient for an array of [start,end] minute intervals    
      const drawAlphaGradient = (intervals, alphaStart, alphaEnd, baseColorFn) => {
        (intervals || []).forEach(([i1, i2]) => {
          // Use minute-based mapping to avoid hours/minutes conversion errors
          const x1 = (typeof xMinute === 'function') ? xMinute(i1) : (typeof xHour === 'function' ? xHour(i1 / 60) : null);
          const x2 = (typeof xMinute === 'function') ? xMinute(i2) : (typeof xHour === 'function' ? xHour(i2 / 60) : null);

          if (!Number.isFinite(x1) || !Number.isFinite(x2) || x2 === x1) return;
          try {
            const grad = ctx.createLinearGradient(x1, 0, x2, 0);
            grad.addColorStop(0, baseColorFn(alphaStart));
            grad.addColorStop(1, baseColorFn(alphaEnd));
            ctx.fillStyle = grad;
            ctx.fillRect(x1, topPad, x2 - x1, innerH);
          } catch (e) {
            // fallback to faint fill if gradient fails
            try { ctx.fillStyle = baseColorFn(alphaEnd || 0.25); ctx.fillRect(x1, topPad, Math.max(1, x2 - x1), innerH); } catch(err){}
          }
        });
      };

      // convert timeline segments to minute arrays if necessary
      const toArr = seg => Array.isArray(seg) ? seg : [seg.start, seg.end];

      const astro = splitIntervals((effectiveTimeline.astronomical || []).map(toArr));
      const naut  = splitIntervals((effectiveTimeline.nautical || []).map(toArr));
      const civil = splitIntervals((effectiveTimeline.civil || []).map(toArr));
      const gold  = splitIntervals((effectiveTimeline.golden || []).map(toArr));

      // morning
      drawAlphaGradient(astro.morning, 0.00, 0.27, baseBlue2);
      drawAlphaGradient(naut.morning, 0.27, 0.45, baseBlue2);
      drawAlphaGradient(civil.morning, 0.45, 0.70, baseBlue);
      drawAlphaGradient(gold.morning, 0.00, 0.65, a => `rgba(255,200,0,${a})`);
      // evening (draw after morning)
      drawAlphaGradient(civil.evening, 0.70, 0.45, baseBlue);
      drawAlphaGradient(naut.evening, 0.45, 0.27, baseBlue2);
      drawAlphaGradient(astro.evening, 0.27, 0.00, baseBlue2);
      drawAlphaGradient(gold.evening, 0.65, 0.00, a => `rgba(255,200,0,${a})`);
    } else {

  // robust sunElevation selection (accept sunFineElevation or sunFine or fallback)
  const sunElevation = (Array.isArray(moon.sunFineElevation) && moon.sunFineElevation.length === 1440)
    ? moon.sunFineElevation
    : (Array.isArray(moon.sunFine) && moon.sunFine.length === 1440)
      ? moon.sunFine
      : (Array.isArray(window.__moonGraph_sunElevationFallback) && window.__moonGraph_sunElevationFallback.length === 1440)
        ? window.__moonGraph_sunElevationFallback
        : new Array(1440).fill(NaN);

      // find minute intervals from sunElevation (same logic as sunGraph)
      const findIntervals = (minDeg, maxDeg) => {
        const intervals = [];
        let start = null;
        for (let i = 0; i < 1440; i++) {
          const e = sunElevation[i];
          const ok = Number.isFinite(e) && e > minDeg && e <= maxDeg;
          if (ok && start === null) start = i;
          if (!ok && start !== null) { intervals.push([start, i]); start = null; }
        }
        if (start !== null) intervals.push([start, 1440]);
        return intervals;
      };

      const splitIntervals = (intervals) => {
        const morning = [], evening = [];
        (intervals || []).forEach(([i1, i2]) => {
          const mid = (i1 + i2) / 2;
          if (mid < 720) morning.push([i1, i2]); else evening.push([i1, i2]);
        });
        return { morning, evening };
      };

      const drawAlphaGradient = (intervals, alphaStart, alphaEnd, baseColorFn) => {
        (intervals || []).forEach(([i1, i2]) => {
          const x1 = xHour(i1 / 60);
          const x2 = xHour(i2 / 60);
          if (!Number.isFinite(x1) || !Number.isFinite(x2) || x2 === x1) return;
          try {
            const grad = ctx.createLinearGradient(x1, 0, x2, 0);
            grad.addColorStop(0, baseColorFn(alphaStart));
            grad.addColorStop(1, baseColorFn(alphaEnd));
            ctx.fillStyle = grad;
            ctx.fillRect(x1, topPad, x2 - x1, innerH);
          } catch (e) {
            try { ctx.fillStyle = baseColorFn(alphaEnd || 0.25); ctx.fillRect(x1, topPad, Math.max(1, x2 - x1), innerH); } catch(err){}
          }
        });
      };

      const astroInt = splitIntervals(findIntervals(-18, -12));
      const nautInt  = splitIntervals(findIntervals(-12, -6));
      const civilInt = splitIntervals(findIntervals(-6, 0));
      const goldInt  = splitIntervals(findIntervals(0, 6));

      // morning
      drawAlphaGradient(astroInt.morning, 0.00, 0.27, baseBlue2);
      drawAlphaGradient(nautInt.morning, 0.27, 0.45, baseBlue2);
      drawAlphaGradient(civilInt.morning, 0.45, 0.70, baseBlue);
      drawAlphaGradient(goldInt.morning, 0.00, 0.65, goldColor);
      // evening
      drawAlphaGradient(civilInt.evening, 0.70, 0.45, baseBlue);
      drawAlphaGradient(nautInt.evening, 0.45, 0.27, baseBlue2);
      drawAlphaGradient(astroInt.evening, 0.27, 0.00, baseBlue2);
      drawAlphaGradient(goldInt.evening, 0.65, 0.00, goldColor);
    }

    // Achsen
    ctx.fillStyle = "#4e4e4e";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";

    const yTicks = [80, 60, 40, 20, 0, -20, -40, -60, -80];

    for (const val of yTicks) {
        const y = yElev(val);
        ctx.strokeStyle = "#aeaeae";
        ctx.beginPath();
        ctx.moveTo(leftPad - 6, y);
        ctx.lineTo(leftPad, y);
        ctx.stroke();
        ctx.fillText(val + "°", leftPad - 8, y + 3);
    }

    ctx.textAlign = "center";
    // hour ticks expressed as hours but mapped via minutes to avoid unit mismatch
    const xTicks = [0, 3, 6, 9, 12, 15, 18, 21, 24];

    for (const h of xTicks) {
        // prefer minute-based mapping; fallback to xHour if xMinute not available
        const tickMinute = h * 60;
        const x = (typeof xMinute === 'function') ? xMinute(tickMinute) : (typeof xHour === 'function' ? xHour(h) : null);
        if (!Number.isFinite(x)) continue;
        ctx.strokeStyle = "#aeaeae";
        ctx.beginPath();
        ctx.moveTo(x, H - bottomPad);
        ctx.lineTo(x, H - bottomPad + 6);
        ctx.stroke();
        // use minute-based label generator if available
        const label = (typeof labelForMinute === 'function') ? labelForMinute(tickMinute) : (h === 24 ? '24h' : (h + 'h'));
        ctx.fillText(label, x, H - 4);
    }

    // 0° Linie
    ctx.strokeStyle = "#999";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(leftPad, yElev(0));
    ctx.lineTo(W - rightPad, yElev(0));
    ctx.stroke();
    ctx.setLineDash([]);

    // Mondkurve (robust: unterbreche Pfad bei Tageswechsel / großen Sprüngen / fehlenden Werten)
    ctx.strokeStyle = "#b4c8ff";
    ctx.lineWidth = 2;

    // Pixel‑Schwelle für "großen Sprung" (in Elevations‑Pixeln)
    const MAX_ELEV_JUMP_DEG = 10; // treat >10° as discontinuity
    const maxPixelJump = (MAX_ELEV_JUMP_DEG - minElev) / (maxElev - minElev) * innerH;

    let prevX = null;
    let prevY = null;
    let started = false;

    for (let i = 0; i < 1440; i++) {
        const elev = moon.fineElevation[i];
        // missing value -> separator
        if (typeof elev !== "number" || Number.isNaN(elev)) {
            prevX = prevY = null;
            started = false;
            continue;
        }
        // out of vertical bounds -> separator
        if (elev < minElev || elev > maxElev) {
            prevX = prevY = null;
            started = false;
            continue;
        }

        const x = xHour(i / 60);
        const y = yElev(elev);

        if (!started) {
            ctx.beginPath();
            ctx.moveTo(x, y);
            started = true;
        } else {
            // break path if X is not strictly increasing (defensive) or if elevation jump is large
            const xNotIncreasing = (prevX !== null && x <= prevX);
            const largeJump = (prevY !== null && Math.abs(y - prevY) > maxPixelJump);
            if (xNotIncreasing || largeJump) {+                // finish previous stroke and start a new subpath to avoid connecting across discontinuity
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }

        prevX = x;
        prevY = y;
    }

    if (started) ctx.stroke();

    // Kulmination (Tag/Nacht-kontrast) - normalize and draw safely (time only label)
    if (moon.kulmination) {
      try {
        // normalize kulmination: accept minute, time (hours float) or timeStr "HH:MM"
        const _kul = moon.kulmination;
        if (_kul.minute != null && (_kul.time == null || !Number.isFinite(_kul.time))) {
          _kul.time = _kul.minute / 60;
        } else if (_kul.timeStr && (_kul.time == null || !Number.isFinite(_kul.time))) {
          const parts = String(_kul.timeStr).split(':').map(Number);
          if (Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
            _kul.time = parts[0] + (parts[1] / 60);
          }
        }

        // determine minute to draw (integer 0..1439) and guard
        const minuteToDraw = Number.isFinite(_kul.minute)
          ? _kul.minute
          : (Number.isFinite(_kul.time) ? Math.round(_kul.time * 60) : null);

        if (minuteToDraw == null || !Number.isFinite(minuteToDraw)) {
          // nothing to draw
        } else {
          // compute x safely via xHour
          const computeX = (minute) => {
            try {
              const h = minute / 60;
              const px = xHour(h);
              return Number.isFinite(px) ? px : null;
            } catch (e) { return null; }
          };
          const x = computeX(minuteToDraw);

          // compute y safely via yElev if elevation present
          const elev = Number.isFinite(_kul.elev) ? _kul.elev : null;
          const computeY = (e) => {
            if (e == null) return null;
            try {
              const yy = (typeof yElev === 'function') ? yElev(e) : null;
              return Number.isFinite(yy) ? yy : null;
            } catch (err) { return null; }
          };
          const y = computeY(elev);

          // determine day/night using sun elevation at that minute (if available)
          let isNight = false;
          try {
            if (Array.isArray(moon.sunFineElevation) && Number.isFinite(minuteToDraw)) {
              const idx = ((Math.round(minuteToDraw) % 1440) + 1440) % 1440;
              const sunElevAtKulm = moon.sunFineElevation[idx];
              if (Number.isFinite(sunElevAtKulm)) isNight = sunElevAtKulm < 0;
            }
          } catch (e) {
            // fallback: treat as day
          }

          // only proceed if x is finite (y optional for aura/label)
          if (x !== null && Number.isFinite(x)) {
            const auraColor = isNight ? "rgba(180,200,255,0.35)" : "rgba(70,79,255,0.30)";
            const pointColor = isNight ? "#b4c8ff" : "#464fff";
            const lineColor = isNight ? "rgba(180,200,255,0.35)" : "rgba(70,79,255,0.35)";
            const textColor = isNight ? "#b4c8ff" : "#464fff";

            // Aura (radial gradient) only if y is finite
            if (y !== null && Number.isFinite(y)) {
              try {
                const r = 12;
                const aura = ctx.createRadialGradient(x, y, 0, x, y, r);
                aura.addColorStop(0, auraColor);
                aura.addColorStop(1, "rgba(0,0,0,0.0)");
                ctx.fillStyle = aura;
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fill();
              } catch (e) {
                if (window.console && window.console.warn) window.console.warn('kulmination aura skipped', e);
              }
            }

            // Punkt (if y available, else draw at topPad + small offset)
            const py = (y !== null && Number.isFinite(y)) ? y : (topPad + 16);
            try {
              ctx.fillStyle = pointColor;
              ctx.beginPath();
              ctx.arc(x, py, 3, 0, Math.PI * 2);
              ctx.fill();
            } catch (e) {
              if (window.console && window.console.warn) window.console.warn('kulmination point skipped', e);
            }

            // Vertical line (full inner height)
            try {
              ctx.strokeStyle = lineColor;
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(x, topPad);
              ctx.lineTo(x, topPad + innerH);
              ctx.stroke();
            } catch (e) {
              if (window.console && window.console.warn) window.console.warn('kulmination line skipped', e);
            }

            // Time-Label neben Kulmination (kontrastreich) — show time only (no elevation)
            try {
              ctx.fillStyle = textColor;
              ctx.font = "11px sans-serif";
              ctx.textAlign = "left";
              const timeLabel = _kul.timeStr || (Number.isFinite(_kul.time) ? formatHM(_kul.time) : (Number.isFinite(minuteToDraw) ? `${String(Math.floor(minuteToDraw/60)).padStart(2,'0')}:${String(minuteToDraw%60).padStart(2,'0')}` : null));
              if (timeLabel) {
                ctx.lineWidth = 2;
                ctx.strokeStyle = isNight ? "rgba(0,0,0,0.65)" : "rgba(255,255,255,0.85)";
                ctx.strokeText(timeLabel, x + 6, (y !== null && Number.isFinite(y)) ? y - 10 : (topPad + 6));
                ctx.fillText(timeLabel, x + 6, (y !== null && Number.isFinite(y)) ? y - 10 : (topPad + 6));
              }
            } catch (e) {
              if (window.console && window.console.warn) window.console.warn('kulmination label skipped', e);
            }
          }
        }
      } catch (e) {
        if (window.console && window.console.warn) window.console.warn('kulmination draw skipped', e);
      }
    }
  
    // Pfeile
    ctx.fillStyle = "#b4c8ff";
    ctx.font = "14px sans-serif";

    if (moon.riseBefore) {
        const y0 = (typeof moon.fineElevation[0] === "number") ? yElev(moon.fineElevation[0]) : topPad + 4;
        ctx.fillText("←", leftPad + 2, y0 - 5);
    }
    if (moon.setAfter) {
        const y1 = (typeof moon.fineElevation[1439] === "number") ? yElev(moon.fineElevation[1439]) : topPad + 4;
        ctx.fillText("→", W - rightPad - 10, y1 - 5);
    }
 
    // ---------------------------------------------------------
    // Sunrise / Sunset Linien (Tag/Nacht Grenze)
    // Einfügen zwischen Zeitbeschriftung und Live-Punkt
    // ---------------------------------------------------------
    try {
      ctx.strokeStyle = "#363636";
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;

      if (typeof moon.sunrise === "number" && !Number.isNaN(moon.sunrise)) {
        const x = xHour(moon.sunrise);
        ctx.beginPath();
        ctx.moveTo(x, topPad);
        ctx.lineTo(x, H - bottomPad);
        ctx.stroke();
      }

      if (typeof moon.sunset === "number" && !Number.isNaN(moon.sunset)) {
        const x = xHour(moon.sunset);
        ctx.beginPath();
        ctx.moveTo(x, topPad);
        ctx.lineTo(x, H - bottomPad);
        ctx.stroke();
      }

      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    } catch (e) {
      // non-fatal: falls drawing fehlschlägt, nichts tun
      try { console.warn('moonGraph: sunrise/sunset lines draw failed', e); } catch (_) {}
    }

    // Live-Punkt (robust, sichtbar, optional)
    // Erwartet: moon.livePos = { time: decimalHours, elev: degrees, az: degrees }
    // Optional: moon.showLivePoint = false  -> unterdrückt das Zeichnen
    if (moon.showLivePoint !== false) {

        // Determine live position: prefer moon.livePos if provided, else derive from global moonPanel
        let livePos = moon.livePos || null;

        // Use panel secondMap / interpolation if available and livePos missing or to refine
        try {
            const panel = window.moonPanel;
            if ((!livePos || livePos.elev === undefined || livePos.time === undefined) && panel && panel.minuteMap) {
                // compute nowServer (ms) as before, but then derive a single canonical reference:
// panel._lastTargetOffset is expected to be minutes to add to UTC to get local (e.g. +60 for CET).
const nowServer = panel._lastServerDate
  ? new Date(panel._lastServerDate.getTime() + (Date.now() - panel._lastServerTimestamp))
  : new Date();

                // canonical offset in minutes: prefer panel value if finite, otherwise browser TZ
                const offsetMin = Number.isFinite(panel && panel._lastTargetOffset) ? Number(panel._lastTargetOffset) : -new Date().getTimezoneOffset();

                // Derive local minute float defensively.
                // Treat nowServer as a local Date object (the codebase provides ts_local / local timestamps).
                // compute local minute as fractional minutes since local midnight (hours->minutes + minutes + seconds + ms)
                let localMinuteFloat = (nowServer.getHours() * 60)
                + nowServer.getMinutes()
                + (nowServer.getSeconds() / 60)
                + (nowServer.getMilliseconds() / 60000);

                // normalize to 0..1440 to avoid negative or overflow values
                localMinuteFloat = ((localMinuteFloat % 1440) + 1440) % 1440;

                // Prefer exact secondMap neighbor lookup (±2s) to avoid ms rounding drift
                let resolved = null;
                if (panel.secondMap && panel._lastServerDate) {

                    // compute canonical local midnight ms for the server day represented by panel._lastServerDate
                    // prefer panel._referenceLocalMidnightMs if available
                    const referenceLocalMidnightMs = Number.isFinite(panel && panel._referenceLocalMidnightMs)
                      ? panel._referenceLocalMidnightMs
                      : (new Date(
                          panel._lastServerDate.getFullYear(),
                          panel._lastServerDate.getMonth(),
                          panel._lastServerDate.getDate(),
                          0, 0, 0
                        )).getTime();
                    // seconds relative to that local midnight
                    const secRel = Math.round((nowServer.getTime() - referenceLocalMidnightMs) / 1000);
                    const neighbors = [0, -1, 1, -2, 2];
                    for (const d of neighbors) {
                        const p = panel.secondMap.get(secRel + d);
                        if (p) { resolved = { elev: p.elev, az: p.az, sec: secRel + d }; break; }
                    }
                }

                // Fallback: use second precision interpolation or minute interpolation
                if (!resolved) {
                    const interpFn = (typeof window._moonInterpolation?.interpolateSecondPrecision === 'function')
                        ? window._moonInterpolation.interpolateSecondPrecision
                        : window._moonInterpolation.interpolateMinuteMapAt;
                    resolved = interpFn(panel.minuteMap, localMinuteFloat);
                }
                if (resolved) {
  try {
    // current minute index (0..1439)
    const minuteNow = Number.isFinite(localMinuteFloat) ? Math.round(localMinuteFloat) : NaN;
    const wrapMinute = m => Number.isFinite(m) ? (((m % 1440) + 1440) % 1440) : NaN;

    // infer minute index from resolved (sec, minuteKey, _minuteIndex)
    let resolvedMinute = NaN;
    if (resolved.sec !== undefined && Number.isFinite(resolved.sec) && panel && panel._lastServerDate) {
      resolvedMinute = Math.floor((((resolved.sec % 86400) + 86400) % 86400) / 60);
    } else if (resolved.minuteKey !== undefined && Number.isFinite(resolved.minuteKey)) {
      resolvedMinute = wrapMinute(resolved.minuteKey);
    } else if (resolved._minuteIndex !== undefined && Number.isFinite(resolved._minuteIndex)) {
      resolvedMinute = wrapMinute(resolved._minuteIndex);
    }

    // Defensive: ensure resolved carries a minute hint if possible (helps avoid cross-day hits)
    try {
      if (resolved && typeof resolved === 'object') {
        // 1) prefer existing minute index if present
        if (resolved._minuteIndex !== undefined) {
          resolved._resolvedMinute = resolved._minuteIndex;
        } else if (Number.isFinite(localMinuteFloat)) {
          // 2) fallback: annotate with current local minute (inferred) so matching has a value
          resolved._minuteIndex = Math.round(localMinuteFloat);
          resolved._resolvedMinute = resolved._minuteIndex;
          resolved._resolvedMinute_inferred = true;
        }

        // compute canonical referenceLocalMidnightMs if panel._referenceLocalMidnightMs not present
const canonicalRefLocalMidnightMs = Number.isFinite(panel && panel._referenceLocalMidnightMs)
  ? panel._referenceLocalMidnightMs
  : (typeof referenceLocalMidnightMs === 'number' ? referenceLocalMidnightMs : undefined);

if (resolved._resolvedRaw && resolved._resolvedRaw._utcMs && Number.isFinite(canonicalRefLocalMidnightMs)) {
  resolved._resolvedMinute = Math.round((resolved._resolvedRaw._utcMs - canonicalRefLocalMidnightMs) / 60000);
} else if (resolved._utcMs && Number.isFinite(canonicalRefLocalMidnightMs)) {
  resolved._resolvedMinute = Math.round((resolved._utcMs - canonicalRefLocalMidnightMs) / 60000);
}

        // 4) preserve a copy of raw data for debugging if not already present
        if (!resolved._resolvedRaw && (resolved._utcMs || resolved._raw)) {
          resolved._resolvedRaw = resolved._raw || (resolved._utcMs ? { _utcMs: resolved._utcMs } : null);
        }

        // 5) ensure a source label exists
        if (!resolved._liveSource && resolved._source) resolved._liveSource = resolved._source;
      }
    } catch (e) { /* non-fatal */ }

    // If resolvedMinute is missing or far from minuteNow, try minuteMap near minuteNow
    const minuteDiff = (Number.isFinite(resolvedMinute) && Number.isFinite(minuteNow)) ? Math.abs(resolvedMinute - minuteNow) : Infinity;
    if (!Number.isFinite(resolvedMinute) || minuteDiff > (window.__moonGraph_minuteDiffTolerance || 3)) {

      // expanded candidate window: current ±5 minutes and previous/next day equivalents
      let fallback = null;
      if (panel && panel.minuteMap) {
        const candidates = [
          minuteNow,
          minuteNow - 1, minuteNow + 1,
          minuteNow - 2, minuteNow + 2,
          minuteNow - 3, minuteNow + 3,
          minuteNow - 4, minuteNow + 4,
          minuteNow - 5, minuteNow + 5,
          minuteNow - 1440, minuteNow + 1440
        ];
        for (const m of candidates) {
          const key = wrapMinute(m);
          const p = panel.minuteMap.get(key);
          if (p) { fallback = p; resolvedMinute = wrapMinute(key); break; }
        }
      }
      if (fallback) {
        resolved = { elev: (fallback.elevation ?? fallback.elev ?? fallback.elevationValue), az: (fallback.azimuth ?? fallback.az ?? fallback.azValue), _source: 'minuteMap-fallback' };
      } else {
        // No valid resolved for current minute window -> treat as no livePos
        resolved = null;
      }
    }

    // If after fallback resolved is null, do not set livePos
    if (!resolved) {
      livePos = null;
    } else {
      // Derive time always from localMinuteFloat (defensive normalization)
      const rawTime = Number.isFinite(localMinuteFloat) ? (localMinuteFloat / 60) : NaN;
      const normTime = Number.isFinite(rawTime) ? (((rawTime % 24) + 24) % 24) : NaN;
      livePos = {
        time: Number.isFinite(normTime) ? normTime : rawTime,
        elev: Number.isFinite(resolved.elev) ? resolved.elev : NaN,
        az: Number.isFinite(resolved.az) ? resolved.az : NaN,
        _resolvedMinute: Number.isFinite(resolvedMinute) ? resolvedMinute : undefined,
        _liveSource: resolved._source || (resolved.sec !== undefined ? 'secondMap' : 'minuteMap'),
        
      serverUtcMs: (function(){
          try {
            // compute canonical local midnight ms for the panel day
            const localMidMs = Number.isFinite(panel && panel._referenceLocalMidnightMs)
              ? panel._referenceLocalMidnightMs
              : (new Date(
                  panel._lastServerDate.getFullYear(),
                  panel._lastServerDate.getMonth(),
                  panel._lastServerDate.getDate(),
                  0,0,0
                )).getTime();

            // If resolved.sec is present it is seconds relative to local midnight
            if (resolved.sec !== undefined && panel && panel._lastServerDate) {
              return localMidMs + (resolved.sec * 1000);
            }
            if (resolved._utcMs) return resolved._utcMs;
            if (Number.isFinite(resolvedMinute) && panel && panel._lastServerDate) {
              return localMidMs + (resolvedMinute * 60000);
            }
          } catch(e){}
          return undefined;
        })(),
        _resolvedRaw: resolved
      };
    }
  } catch (e) {
    // fallback: do not set livePos if something goes wrong
    livePos = null;
  }
}
            }
        } catch (e) {
            // non-fatal: keep livePos as-is or null
        }

        // If we now have a valid livePos, draw it
        if (livePos && typeof livePos.time === "number" && typeof livePos.elev === "number" && !Number.isNaN(livePos.elev)) {

            // only draw if within vertical bounds
            if (livePos.elev >= minElev && livePos.elev <= maxElev) {

                const normLiveTime = (typeof livePos.time === 'number' && isFinite(livePos.time)) ? (((livePos.time % 24) + 24) % 24) : livePos.time;
                const xNow = xHour(normLiveTime);
                const yNow = yElev(livePos.elev);

                // determine day/night for styling
                let isNightNow = false;
                try {
                    
                    if (Array.isArray(moon.sunFineElevation)) {
                        const minuteIndex = Number.isFinite(normLiveTime) ? ((Math.round(normLiveTime * 60) % 1440) + 1440) % 1440 : NaN;
                        const sunElevAtNow = moon.sunFineElevation[minuteIndex];
                        if (typeof sunElevAtNow === "number" && !Number.isNaN(sunElevAtNow)) {
                            isNightNow = sunElevAtNow < 0;
                        }
                    }
        
                } catch (e) { /* ignore */ }

                const liveOuterFill = isNightNow ? "rgba(255,255,255,0.18)" : "rgba(180,200,255,0.30)";
                const liveStrokeColor = isNightNow ? "rgba(255,255,255,0.35)" : "rgba(20,40,80,0.25)";
                const liveInnerFill = isNightNow ? "#ffffff" : "#779bff";

                ctx.save();
                // Halo
                ctx.beginPath();
                ctx.fillStyle = liveOuterFill;
                ctx.arc(xNow, yNow, 9.5, 0, Math.PI * 2);
                ctx.fill();

                // Stroke
                ctx.beginPath();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = liveStrokeColor;
                ctx.arc(xNow, yNow, 9.5, 0, Math.PI * 2);
                ctx.stroke();

                // Inner point
                ctx.beginPath();
                ctx.fillStyle = liveInnerFill;
                ctx.arc(xNow, yNow, 4, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();

                // Label
                ctx.font = "11px sans-serif";
                ctx.textAlign = "center";
                let textColor = "#000";
                try {

                    if (Array.isArray(moon.sunFineElevation)) {
                        const minuteIndex = Number.isFinite(normLiveTime) ? ((Math.round(normLiveTime * 60) % 1440) + 1440) % 1440 : NaN;
                        const sunElev = moon.sunFineElevation[minuteIndex];
                        if (typeof sunElev === "number" && !Number.isNaN(sunElev) && sunElev < 0) textColor = "#fff";
                    }

                } catch (e) { /* ignore */ }

                const outlineColor = (textColor === "#fff") ? "rgba(0,0,0,0.65)" : "rgba(255,255,255,0.85)";
                ctx.lineWidth = 2;
                ctx.strokeStyle = outlineColor;
                ctx.fillStyle = textColor;
                const timeLabel = formatHM(normLiveTime);
                const labelYOffset = -18;
                
                const elevLabel = livePos.elev.toFixed(1) + "°";

                ctx.strokeText(timeLabel, xNow, yNow + labelYOffset);
                ctx.fillText(timeLabel, xNow, yNow + labelYOffset);

                ctx.strokeText(elevLabel, xNow, yNow + labelYOffset + 12);
                ctx.fillText(elevLabel, xNow, yNow + labelYOffset + 12);
            }
        }
    }
};

   // ... Ende der bestehenden drawMoonGraph Logik ...
  // Persistent debug overlay: set window.__moonGraph_debug = true to enable
  try {
    if (window.__moonGraph_debug) {
      const dbg = (x, color, label) => {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, topPad);
        ctx.lineTo(x, topPad + innerH);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.font = '12px sans-serif';
        ctx.fillText(label, x + 4, topPad + 12);
        ctx.restore();
      };
      const payload = window.__lastDrawMoonGraphPayload || moon;
      const sPx = (Number.isFinite(payload?.sunrise) ? xMinute(payload.sunrise) : null);
      const ePx = (Number.isFinite(payload?.sunset) ? xMinute(payload.sunset) : null);
      const kPx = (payload?.kulmination && Number.isFinite(payload.kulmination.minute)) ? xMinute(payload.kulmination.minute) : null;
      if (sPx) dbg(sPx, 'magenta', 'sunrise');
      if (ePx) dbg(ePx, 'purple', 'sunset');
      if (kPx) dbg(kPx, 'lime', `kul ${payload.kulmination.timeStr || ''}`);
    }
  } catch(e){}

try {
  const layout = { leftPad, rightPad, topPad, bottomPad, innerW, innerH, canvasWidth: W, canvasHeight: H, devicePixelRatio: window.devicePixelRatio || 1 };
  try { Object.defineProperty(window, '__moonGraph_layout', { value: layout, writable: false, configurable: false, enumerable: true }); } catch(e){ window.__moonGraph_layout = layout; }
  try { Object.defineProperty(window, '__moonGraph_xHour', { value: function(h){ try { return xHour(h); } catch(e){ return leftPad; } }, writable: false, configurable: false, enumerable: false }); } catch(e){ window.__moonGraph_xHour = function(h){ try { return xHour(h); } catch(e){ return leftPad; } }; }
} catch(e){}

// --- Fallback: use authoritative sun elevation if moon.sunFineElevation missing ---
try {
  // If moonGraph uses a variable named moon.sunFineElevation internally, ensure a fallback is available.
  // We expose a helper variable that existing code can use if adapted; but to be safe, we also patch
  // the runtime usage below via moonSunFine.
  if (typeof window !== 'undefined') {
    window.__moonGraph_sunElevationFallback = (window.sunData && Array.isArray(window.sunData.fineElevation)) ? window.sunData.fineElevation : null;
  }
} catch (e) { /* ignore */ }

// --- Adapter wrapper: if drawToOffscreenAndBlit exists, route draw calls through it ---
if (typeof window.drawToOffscreenAndBlit === 'function' && typeof window.drawMoonGraph === 'function') {
  (function(){
    const orig = window.drawMoonGraph;
    window.drawMoonGraph = function(canvas, moon) {
      // draw into offscreen and blit; adapt original function to use offscreen context
      window.drawToOffscreenAndBlit(canvas, (ctx, W, H) => {
        // create a minimal fake canvas that the original implementation can use
        const fakeCanvas = {
          getContext: () => ctx,
          getBoundingClientRect: () => ({ width: W, height: H }),
          width: W,
          height: H,
          style: canvas && canvas.style ? canvas.style : {}
        };
        // ensure moon has sunFineElevation fallback if missing
        if (moon && !Array.isArray(moon.sunFineElevation) && Array.isArray(window.__moonGraph_sunElevationFallback)) {
          try { moon.sunFineElevation = window.__moonGraph_sunElevationFallback; } catch(e){/*ignore*/ }
        }
        // call original implementation with the fake canvas
        try { orig(fakeCanvas, moon); } catch (e) { console.warn('drawMoonGraph (offscreen adapter) failed', e); }
      });
    };
  })();
}

