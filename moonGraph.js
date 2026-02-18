// /livewetter/astronomie/mond/moonGraph.js

window.drawMoonGraph = function(canvas, moon) {

    if (!canvas || !moon || !moon.fineElevation) {
        console.warn("moonGraph: Canvas oder Mond-Daten fehlen");
        return;
    }
    
    window.currentMoonData = moon;

    const ctx = canvas.getContext("2d");
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
        const hh = Math.floor(decimalTime);
        const mm = Math.round((decimalTime - hh) * 60);
        return `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`;
    }

    const leftPad   = 28;
    const rightPad  = 12;
    const topPad    = 10;
    const bottomPad = 20;

    const innerW = W - leftPad - rightPad;
    const innerH = H - topPad - bottomPad;

    const maxElev = 85;
    const minElev = -85;

    const xHour = h => leftPad + (h / 24) * innerW;

    const yElev = e => {
        const norm = (e - minElev) / (maxElev - minElev);
        return topPad + (1 - norm) * innerH;
    };

    // Hintergrund
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#eaf4ff";
    ctx.fillRect(leftPad, topPad, innerW, innerH);

    // Nachtbereiche
    ctx.fillStyle = "#00264a";

    if (moon.sunrise != null) {
        ctx.fillRect(leftPad, topPad, xHour(moon.sunrise) - leftPad, innerH);
    }
    if (moon.sunset != null) {
        ctx.fillRect(xHour(moon.sunset), topPad, (W - rightPad) - xHour(moon.sunset), innerH);
    }

    // Sonnenhöhe für Dämmerungszonen
    const sunElevation = moon.sunFineElevation || new Array(1440).fill(NaN);

    function findIntervals(minDeg, maxDeg) {
        const intervals = [];
        let start = null;

        for (let i = 0; i < 1440; i++) {
            const e = sunElevation[i];
            if (e >= minDeg && e <= maxDeg) {
                if (start === null) start = i;
            } else {
                if (start !== null) {
                    intervals.push([start, i]);
                    start = null;
                }
            }
        }
        if (start !== null) intervals.push([start, 1440]);
        return intervals;
    }

    function splitIntervals(intervals) {
        const morning = [];
        const evening = [];
        intervals.forEach(([i1, i2]) => {
            const mid = (i1 + i2) / 2;
            if (mid < 720) morning.push([i1, i2]);
            else evening.push([i1, i2]);
        });
        return { morning, evening };
    }

    function drawAlphaGradient(intervals, alphaStart, alphaEnd, baseColor) {
        intervals.forEach(([i1, i2]) => {
            const x1 = xHour(i1 / 60);
            const x2 = xHour(i2 / 60);

            const grad = ctx.createLinearGradient(x1, 0, x2, 0);
            grad.addColorStop(0, baseColor(alphaStart));
            grad.addColorStop(1, baseColor(alphaEnd));

            ctx.fillStyle = grad;
            ctx.fillRect(x1, topPad, x2 - x1, innerH);
        });
    }

    const baseBlue  = a => `rgba(33,141,255,${a})`;
    const baseBlue2 = a => `rgba(38,143,255,${a})`;

    const astroInt = splitIntervals(findIntervals(-18, -12));
    const nautInt  = splitIntervals(findIntervals(-12, -6));
    const civilInt = splitIntervals(findIntervals(-6, 0));
    const goldInt  = splitIntervals(findIntervals(0, 6));

    drawAlphaGradient(astroInt.morning, 0.00, 0.27, baseBlue2);
    drawAlphaGradient(nautInt.morning, 0.27, 0.45, baseBlue2);
    drawAlphaGradient(civilInt.morning, 0.45, 0.70, baseBlue);
    drawAlphaGradient(goldInt.morning, 0.00, 0.65, a => `rgba(255,200,0,${a})`);

    drawAlphaGradient(civilInt.evening, 0.70, 0.45, baseBlue);
    drawAlphaGradient(nautInt.evening, 0.45, 0.27, baseBlue2);
    drawAlphaGradient(astroInt.evening, 0.27, 0.00, baseBlue2);
    drawAlphaGradient(goldInt.evening, 0.65, 0.00, a => `rgba(255,200,0,${a})`);

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
    const xTicks = [0, 3, 6, 9, 12, 15, 18, 21, 24];

    for (const h of xTicks) {
        const x = xHour(h);
        ctx.strokeStyle = "#aeaeae";
        ctx.beginPath();
        ctx.moveTo(x, H - bottomPad);
        ctx.lineTo(x, H - bottomPad + 6);
        ctx.stroke();
        ctx.fillText(h + "h", x, H - 4);
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

        // Kulmination (Tag/Nacht-kontrast)
    if (moon.kulmination) {
        const x = xHour(moon.kulmination.time);
        const y = yElev(moon.kulmination.elev);

        // Bestimme lokale Minute für Sonnenhöhe (falls vorhanden)
        let isNight = false;
        try {
            if (Array.isArray(moon.sunFineElevation)) {
                const minuteIndex = Math.round((moon.kulmination.time % 24) * 60) % 1440;
                const sunElevAtKulm = moon.sunFineElevation[minuteIndex];
                if (typeof sunElevAtKulm === "number" && !Number.isNaN(sunElevAtKulm)) {
                    isNight = sunElevAtKulm < 0; // Nacht wenn Sonne unter Horizont
                }
            }
        } catch (e) {
            // fallback: treat as day (isNight = false)
        }

        // Farben je nach Tag/Nacht
        const auraColor = isNight ? "rgba(180,200,255,0.35)" : "rgba(70,79,255,0.30)";
        const pointColor = isNight ? "#b4c8ff" : "#464fff";
        const outlineColor = isNight ? "rgba(180,200,255,0.35)" : "rgba(120,80,0,0.25)";
        const lineColor = isNight ? "rgba(180,200,255,0.35)" : "rgba(70,79,255,0.35)";
        const textColor = isNight ? "#b4c8ff" : "#464fff";

        // Aura
        const aura = ctx.createRadialGradient(x, y, 0, x, y, 12);
        aura.addColorStop(0, auraColor);
        aura.addColorStop(1, "rgba(0,0,0,0.0)");

        ctx.fillStyle = aura;
        ctx.beginPath();
        ctx.arc(x, y, 12, 0, Math.PI * 2);
        ctx.fill();

        // Punkt
        ctx.fillStyle = pointColor;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();

        // Vertikale Linie
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, topPad);
        ctx.lineTo(x, H - bottomPad);
        ctx.stroke();

        // Zeit-Label neben Kulmination (kontrastreich)
        ctx.fillStyle = textColor;
        ctx.font = "11px sans-serif";
        ctx.textAlign = "left";

        // Outline für Lesbarkeit
        const label = formatHM(moon.kulmination.time);
        ctx.lineWidth = 2;
        ctx.strokeStyle = isNight ? "rgba(0,0,0,0.65)" : "rgba(255,255,255,0.85)";
        ctx.strokeText(label, x + 6, y - 10);
        ctx.fillText(label, x + 6, y - 10);
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
                const nowServer = panel._lastServerDate ? new Date(panel._lastServerDate.getTime() + (Date.now() - panel._lastServerTimestamp)) : new Date();
                const offsetMin = panel._lastTargetOffset || -new Date().getTimezoneOffset();
                const utcMinutesNowFloat = nowServer.getUTCHours()*60 + nowServer.getUTCMinutes() + nowServer.getUTCSeconds()/60 + nowServer.getUTCMilliseconds()/60000;
                const localMinuteFloat = (utcMinutesNowFloat + offsetMin + 1440) % 1440;

                // Prefer exact secondMap neighbor lookup (±2s) to avoid ms rounding drift
                let resolved = null;
                if (panel.secondMap && panel._lastServerDate) {
                    const ref = Date.UTC(panel._lastServerDate.getUTCFullYear(), panel._lastServerDate.getUTCMonth(), panel._lastServerDate.getUTCDate(), 0, 0, 0);
                    const secRel = Math.round((nowServer.getTime() - ref) / 1000);
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
                    livePos = {
                        time: localMinuteFloat / 60,
                        elev: resolved.elev,
                        az: resolved.az
                    };
                }
            }
        } catch (e) {
            // non-fatal: keep livePos as-is or null
        }

        // If we now have a valid livePos, draw it
        if (livePos && typeof livePos.time === "number" && typeof livePos.elev === "number" && !Number.isNaN(livePos.elev)) {

            // only draw if within vertical bounds
            if (livePos.elev >= minElev && livePos.elev <= maxElev) {

                // compute float X from decimal hours (time is decimal hours)
                const xNow = xHour(livePos.time);
                const yNow = yElev(livePos.elev);

                // determine day/night for styling
                let isNightNow = false;
                try {
                    if (Array.isArray(moon.sunFineElevation)) {
                        const minuteIndex = Math.round((livePos.time % 24) * 60) % 1440;
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
                        const minuteIndex = Math.round((livePos.time % 24) * 60) % 1440;
                        const sunElev = moon.sunFineElevation[minuteIndex];
                        if (typeof sunElev === "number" && !Number.isNaN(sunElev) && sunElev < 0) textColor = "#fff";
                    }
                } catch (e) { /* ignore */ }

                const outlineColor = (textColor === "#fff") ? "rgba(0,0,0,0.65)" : "rgba(255,255,255,0.85)";
                ctx.lineWidth = 2;
                ctx.strokeStyle = outlineColor;
                ctx.fillStyle = textColor;

                const labelYOffset = -18;
                const timeLabel = formatHM(livePos.time);
                const elevLabel = livePos.elev.toFixed(1) + "°";

                ctx.strokeText(timeLabel, xNow, yNow + labelYOffset);
                ctx.fillText(timeLabel, xNow, yNow + labelYOffset);

                ctx.strokeText(elevLabel, xNow, yNow + labelYOffset + 12);
                ctx.fillText(elevLabel, xNow, yNow + labelYOffset + 12);
            }
        }
    }
};

