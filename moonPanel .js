// moonPanel.js
// Server-time based local display (Europe/Zurich)
// Vollständige, bereinigte und gepatchte Version mit:
// - robuster Zeitparser (ts_utc, ts_local, _utcMs, raw_nearest._utcMs, fallback date+time)
// - sichere time.split-Verwendungen
// - Auto-rebuild im init() falls minuteMap ungültig
// - Live-Ticker Fallbacks
// - Guard gegen ungültige minuteMap-Überschreibungen
// - defensive interpolation / gap-filling
// - stellt sicher, dass drawMoonGraph immer sunrise/sunset und sunFineElevation erhält
//
// Erwartete Hilfsfunktionen/Module:
//   /livewetter/astronomie/mond/moonTime.js
//   /livewetter/astronomie/mond/moonInterpolation.js
// (füge die helper-Funktion an einer sinnvollen Stelle ein, z.B. nahe anderen Hilfsfunktionen oder am Datei‑Anfang)
// helper: normalize minute index into 0..1439
function wrapMinute(m) {
  return Number.isFinite(m) ? (((m % 1440) + 1440) % 1440) : NaN;
}

import { getMoonDay, getMoonDurationForCalendarDay } from "/livewetter/astronomie/mond/moonTime.js";
import {
  interpolateSecondPrecision,
  interpolateMinuteMapAt,
  zurichDecimalFromUTC,
  timeToMinutes,
  buildMinuteMapFromRaw
} from "/livewetter/astronomie/mond/moonInterpolation.js";

(function () {
  // Expose interpolation helpers for console debugging
  window._moonInterpolation = window._moonInterpolation || {
    interpolateSecondPrecision,
    interpolateMinuteMapAt,
    timeToMinutes,
    buildMinuteMapFromRaw
  };

  // Main object
  window.moonPanel = {
    // internal timers / flags
    _midnightTimeoutId: null,
    _dstIntervalId: null,
    _liveTickerId: null,
    _lastTargetOffset: null,
    _forceRecompute: false,
    _lastServerCheck: null,
    _lastBrowserOffset: null,
    _lastServerDate: null,
    _lastServerTimestamp: null,
    _lastServerPerf: null, // monotone reference (performance.now) to avoid system clock jumps

    // Monitoring state (throttle + change detection)
    _monitorLastLogMs: null,
    _monitorLastSunriseRaw: null,
    _monitorLastSunsetRaw: null,
    _initCalled: false,

    // Debug flag (set in console to true to enable verbose logs)
    _debug: false,
    // internal guard: whether a valid minuteMap has been built
    _minuteMapBuilt: false,

    // Helper: quick validity check for minuteMap (returns true if any numeric elev found)
    _hasValidMinuteMap(m) {
      try {
        if (!(m instanceof Map) || m.size === 0) return false;
        for (const v of m.values()) {
          if (v && Number.isFinite(v.elev)) return true;
        }
        return false;
      } catch (e) {
        return false;
      }
    },

  // Deterministic moon minuteMap builder and fine elevation generator
// Loads yesterday/today/tomorrow out_YYYY-MM-DD.json from moonpos folder,
// normalizes timestamps and resolves per-minute conflicts deterministically.
async buildMoonMinuteMapAndFine(referenceLocalMidnightMs) {
  try {
    const z = n => String(n).padStart(2,'0');
    const refMs = Number.isFinite(referenceLocalMidnightMs) ? referenceLocalMidnightMs : (this._referenceLocalMidnightMs || Date.now());
    const d = new Date(refMs);
    const yyyy = d.getFullYear(), mm = z(d.getMonth()+1), dd = z(d.getDate());
    const y = new Date(refMs - 86400000), yy = y.getFullYear(), ym = z(y.getMonth()+1), yd = z(y.getDate());
    const t = new Date(refMs + 86400000), ty = t.getFullYear(), tm = z(t.getMonth()+1), td = z(t.getDate());
    const monthsDe = ['januar','februar','maerz','april','mai','juni','juli','august','september','oktober','november','dezember'];
    const monthFolder = monthsDe[d.getMonth()] || mm;
    const base = `/livewetter/astronomie/mond/moonpos/${yyyy}/${monthFolder}`;
    const urls = [
      `${base}/out_${yy}-${ym}-${yd}.json`,
      `${base}/out_${yyyy}-${mm}-${dd}.json`,
      `${base}/out_${ty}-${tm}-${td}.json`
    ];

    const fetchJson = async u => {
      try { const r = await fetch(u, {cache:'no-store'}); if (!r.ok) return null; return await r.json(); } catch(e){ return null; }
    };

    const blocks = [];
    for (const u of urls) {
      const j = await fetchJson(u);
      if (!j) continue;
      if (Array.isArray(j.data)) blocks.push(j.data);
      else {
        const key = Object.keys(j).find(k => Array.isArray(j[k]));
        if (key) blocks.push(j[key]);
      }
    }
    if (!blocks.length) {
      if (this._debug) console.warn('buildMoonMinuteMapAndFine: no moon blocks found', urls);
      this.moonMinuteMap = new Map();
      this.lastFineElevationLocal = new Array(1440).fill(NaN);
      if (typeof this.onFineElevationUpdated === 'function') this.onFineElevationUpdated();
      return;
    }

    // normalize records to { _utcMs, elevation, azimuth }
    const normalized = [];
    for (const blk of blocks) {
      for (const rec of blk) {
        const elev = rec.elevation ?? rec[1];
        const az = rec.azimuth ?? rec[2];
        let ms = null;
        if (rec.raw_nearest && Number.isFinite(rec.raw_nearest._utcMs)) ms = rec.raw_nearest._utcMs;
        else if (rec._utcMs && Number.isFinite(rec._utcMs)) ms = rec._utcMs;
        else if (rec.ts_utc) ms = (new Date(rec.ts_utc)).getTime();
        else if (rec.ts_local) ms = (new Date(rec.ts_local)).getTime();
        else if (rec.time) {
          const tstr = String(rec.time).replace(/^-/, '');
          const [hh, mm] = tstr.split(':').map(Number);
          const neg = String(rec.time).startsWith('-');
          const dayOffset = neg ? -1 : 0;
          ms = refMs + dayOffset*86400000 + hh*3600000 + mm*60000;
        }
        if (!Number.isFinite(ms)) continue;
        normalized.push({ _utcMs: ms, elevation: Number.isFinite(elev) ? elev : NaN, azimuth: az });
      }
    }

    // conflict resolution: choose per-minute record with minimal distance to minute center
    const minuteCenterMs = i => refMs + i*60000 + 30000;
    const tmp = new Map(); // minute -> { rec, dist }
    for (const r of normalized) {
      const minuteIndex = Math.round((r._utcMs - refMs) / 60000);
      const norm = (((minuteIndex % 1440) + 1440) % 1440);
      const center = minuteCenterMs(norm);
      const dist = Math.abs(r._utcMs - center);
      const existing = tmp.get(norm);
      if (!existing || dist < existing.dist) tmp.set(norm, { rec: r, dist });
    }

    const moonMinuteMap = new Map();
    for (const [min, obj] of tmp.entries()) {
      moonMinuteMap.set(Number(min), { elev: obj.rec.elevation, az: obj.rec.azimuth, _utcMs: obj.rec._utcMs, raw: obj.rec });
    }

    this.moonMinuteMap = moonMinuteMap;
    this._referenceLocalMidnightMs = refMs;
    this._lastMoonNormalized = normalized.slice(0,200);

    // compute fine elevation using interpolation helper if available
    const interp = window._moonInterpolation?.interpolateMinuteMapAt;
    if (typeof interp === 'function') {
      const arr = new Array(1440).fill(NaN);
      for (let i=0;i<1440;i++){
        const r = interp(this.moonMinuteMap, i);
        arr[i] = (r && Number.isFinite(r.elev)) ? r.elev : NaN;
      }
      this.lastFineElevationLocal = arr;
      if (typeof this.onFineElevationUpdated === 'function') this.onFineElevationUpdated();
    } else {
      this.lastFineElevationLocal = new Array(1440).fill(NaN);
      if (typeof this.onFineElevationUpdated === 'function') this.onFineElevationUpdated();
    }
  } catch (e) {
    if (this._debug) console.warn('buildMoonMinuteMapAndFine failed', e);
    this.moonMinuteMap = new Map();
    this.lastFineElevationLocal = new Array(1440).fill(NaN);
    if (typeof this.onFineElevationUpdated === 'function') this.onFineElevationUpdated();
  }
},

// ----------------------------
// Sun data helpers (minutes-based canonicalization)
// ----------------------------
buildMinuteMapFromSunJson(rawData, referenceLocalMidnightMs) {
  try {
    if (!Array.isArray(rawData) || rawData.length === 0) return { minuteMap: new Map(), referenceLocalMidnightMs: referenceLocalMidnightMs || null };
    const firstLocal = rawData[0].ts_local ? new Date(rawData[0].ts_local) : null;
    const refMs = Number.isFinite(referenceLocalMidnightMs) ? referenceLocalMidnightMs
      : (firstLocal ? new Date(firstLocal.getFullYear(), firstLocal.getMonth(), firstLocal.getDate(), 0, 0, 0).getTime() : null);
    const minuteMap = new Map();
    for (const rec of rawData) {
      try {
        const utcMs = rec._utcMs || (rec.ts_utc ? new Date(rec.ts_utc).getTime() : (rec._raw && rec._raw._utcMs) || null);
        if (!Number.isFinite(utcMs)) continue;
        const minuteIndex = Math.round((utcMs - refMs) / 60000);
        const norm = (((minuteIndex % 1440) + 1440) % 1440);
        minuteMap.set(norm, { elev: Number.isFinite(rec.elevation) ? rec.elevation : NaN, az: rec.azimuth, _utcMs: utcMs, raw: rec });
      } catch (e) { /* ignore per-record errors */ }
    }
    return { minuteMap, referenceLocalMidnightMs: refMs };
  } catch (e) {
    if (this._debug) console.warn('buildMinuteMapFromSunJson failed', e);
    return { minuteMap: new Map(), referenceLocalMidnightMs: referenceLocalMidnightMs || null };
  }
},

computeFineElevationFromMinuteMap(minuteMap, interpFn) {
  try {
    const arr = new Array(1440).fill(NaN);
    for (let i = 0; i < 1440; i++) {
      const p = minuteMap.get(i);
      if (p && Number.isFinite(p.elev)) { arr[i] = p.elev; continue; }
      if (typeof interpFn === 'function') {
        const r = interpFn(minuteMap, i);
        if (r && Number.isFinite(r.elev)) arr[i] = r.elev;
      }
    }
    return arr;
  } catch (e) {
    if (this._debug) console.warn('computeFineElevationFromMinuteMap failed', e);
    return new Array(1440).fill(NaN);
  }
},

// --- Replace existing computeSunPhaseTimelineFromFine with this implementation ---
// Uses only localized minute values from the raw sun JSON (minuteLocal or ts_local).
computeSunPhaseTimelineFromFine(sunFineElevation) {
  try {
    // Helper: get raw day rows (prefer internal raw, else global loaded JSON)
    const rawRows = this._lastSunRaw || window.__lastSunNormalized || window.__sunData || [];
    const refMs = Number.isFinite(this._referenceLocalMidnightMs) ? this._referenceLocalMidnightMs : (window.__sunMeta && window.__sunMeta.referenceLocalMidnightMs) || null;

    // Build minute -> elevation map from raw rows (sparse)
    const minuteElev = new Map();
    for (const r of rawRows) {
      let minute = Number(r.minuteLocal);
      if (!Number.isFinite(minute) && typeof r.ts_local === 'string') {
        const d = new Date(r.ts_local);
        if (!Number.isNaN(d.getTime())) minute = d.getHours() * 60 + d.getMinutes();
      }
      if (!Number.isFinite(minute)) continue;
      minute = ((minute % 1440) + 1440) % 1440;
      const elev = Number(r.elev ?? r.elevation ?? r.raw_nearest?.elevation ?? NaN);
      minuteElev.set(minute, Number.isFinite(elev) ? elev : NaN);
    }

    // If minuteElev is empty, fall back to sunFineElevation (if available) by scanning indices
    if (!minuteElev.size && Array.isArray(sunFineElevation) && sunFineElevation.length === 1440) {
      for (let i = 0; i < 1440; i++) {
        const v = sunFineElevation[i];
        if (Number.isFinite(v)) minuteElev.set(i, v);
      }
    }

    // Utility: find minute (from minuteElev keys) whose elevation is nearest to threshold
    const nearestMinuteTo = (threshold) => {
      let bestMin = null, bestDiff = Infinity;
      for (const [m, e] of minuteElev.entries()) {
        if (!Number.isFinite(e)) continue;
        const diff = Math.abs(e - threshold);
        if (diff < bestDiff) { bestDiff = diff; bestMin = m; }
      }
      return bestMin;
    };

    // Build simple timeline using raw minutes (no interpolation)
    // Dawn/dusk thresholds
    const astroMin = nearestMinuteTo(-18);
    const nautMin  = nearestMinuteTo(-12);
    const civilMin = nearestMinuteTo(-6);

    // Sunrise / Sunset: pick nearest-to-0 candidates and choose ordering (sunrise earlier than sunset)
    const zeroCandidates = Array.from(minuteElev.entries())
      .filter(([m,e]) => Number.isFinite(e))
      .map(([m,e]) => ({ m, e, d: Math.abs(e) }))
      .sort((a,b) => a.d - b.d || a.m - b.m);

    let sunrise = null, sunset = null;
    if (zeroCandidates.length) {
      sunrise = zeroCandidates[0].m;
      // prefer a candidate after sunrise for sunset
      const alt = zeroCandidates.find(c => c.m !== sunrise && c.m > sunrise);
      if (alt) sunset = alt.m;
      else {
        const alt2 = zeroCandidates.find(c => c.m !== sunrise);
        if (alt2) {
          if (alt2.m > sunrise) sunset = alt2.m;
          else { sunset = sunrise; sunrise = alt2.m; }
        } else {
          sunset = null;
        }
      }
    }

    // Golden hours: simple 60-minute rule (if sunrise/sunset exist)
    const goldenMorning = (sunrise != null) ? { start: sunrise, end: Math.min(sunrise + 60, 1439) } : null;
    const goldenEvening = (sunset != null) ? { start: Math.max(sunset - 60, 0), end: sunset } : null;

    // Compose timeline entries (minute indices only)
    const timeline = [];
    if (astroMin != null) timeline.push({ type: 'astronomical_transition', minute: astroMin, threshold: -18 });
    if (nautMin  != null) timeline.push({ type: 'nautical_transition', minute: nautMin, threshold: -12 });
    if (civilMin != null) timeline.push({ type: 'civil_transition', minute: civilMin, threshold: -6 });
    if (sunrise != null) timeline.push({ type: 'sunrise', minute: sunrise });
    if (sunset  != null) timeline.push({ type: 'sunset', minute: sunset });
    if (goldenMorning) timeline.push(Object.assign({ type: 'golden_morning' }, goldenMorning));
    if (goldenEvening) timeline.push(Object.assign({ type: 'golden_evening' }, goldenEvening));

    // Attach local ms if referenceLocalMidnightMs is available
    if (Number.isFinite(refMs)) {
      for (const ev of timeline) {
        if (ev.minute != null) ev.localMs = Math.round(refMs + ev.minute * 60000);
        if (ev.start != null) ev.startLocalMs = Math.round(refMs + ev.start * 60000);
        if (ev.end != null) ev.endLocalMs = Math.round(refMs + ev.end * 60000);
      }
    }

    return timeline;
  } catch (e) {
    if (this._debug) console.warn('computeSunPhaseTimelineFromFine (simple) failed', e);
    return [];
  }
},
    // ---------------------------------------------------------
    // Helper: authoritative "now" based on server reference
    // Uses performance.now() if available to be robust against system clock changes
    // ---------------------------------------------------------
    _getNowServer() {
      if (this._lastServerDate && Number.isFinite(this._lastServerTimestamp)) {
        // prefer monotonic elapsed measurement
        const hasPerf = (typeof performance !== 'undefined' && typeof performance.now === 'function');
        if (hasPerf && Number.isFinite(this._lastServerPerf)) {
          const nowPerf = performance.now();
          const elapsedMs = nowPerf - this._lastServerPerf;
          return new Date(this._lastServerDate.getTime() + Math.round(elapsedMs));
        } else {
          // fallback to Date.now() delta
          return new Date(this._lastServerDate.getTime() + (Date.now() - this._lastServerTimestamp));
        }
      }
      return new Date();
    },

    // ---------------------------------------------------------
    // Helper: format a Date or ms as localized string for Europe/Zurich
    // ---------------------------------------------------------
    _formatServerLocal(dOrMs) {
      const d = (dOrMs instanceof Date) ? dOrMs : new Date(dOrMs);
      try {
        return d.toLocaleString('de-CH', { timeZone: 'Europe/Zurich' });
      } catch (e) {
        return d.toISOString();
      }
    },

    // ---------------------------------------------------------
    // fetch server Date header (returns Date or null)
    // supports optional window.simTime.getServerDateForPanel()
    // ---------------------------------------------------------
    async _fetchServerDate(timeout = 3000) {
      try {
        if (window.simTime && typeof window.simTime.getServerDateForPanel === "function") {
          const sim = window.simTime.getServerDateForPanel();
          if (sim instanceof Date) return sim;
        }
      } catch (e) {
        // ignore simTime errors
      }

      try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        let res = await fetch("/", { method: "HEAD", signal: controller.signal });
        if (!res || !res.ok) {
          res = await fetch("/", { method: "GET", signal: controller.signal });
        }
        clearTimeout(id);
        if (!res || !res.headers) return null;
        const dateHeader = res.headers.get("date");
        if (!dateHeader) return null;
        const d = new Date(dateHeader);
        if (Number.isNaN(d.getTime())) return null;
        return d;
      } catch (e) {
        return null;
      }
    },

    // ---------------------------------------------------------
    // computeTargetOffsetSigned
    // - Priority: explicit override window.SUN_PANEL_TZ_OFFSET_MIN (minutes)
    // - Next: compute offset for Europe/Zurich at server UTC (server applies DST)
    // - Fallback: browser local offset
    // Returns signed minutes east of UTC (e.g., +60)
    // ---------------------------------------------------------
    async _computeTargetOffsetSigned() {
      if (typeof window !== "undefined" && Number.isFinite(window.SUN_PANEL_TZ_OFFSET_MIN)) {
        return Number(window.SUN_PANEL_TZ_OFFSET_MIN);
      }

      // simTime hook
      const simDate = (window.simTime && typeof window.simTime.getServerDateForPanel === 'function')
        ? window.simTime.getServerDateForPanel()
        : null;

      const serverUtc = simDate || await this._fetchServerDate();
      if (serverUtc) {
        try {

          const zurichDec = zurichDecimalFromUTC(serverUtc);
          // serverUtc may be provided as a server timestamp; treat it as local for offset computation
          // Compute local decimal hour from the Date object to avoid mixing UTC fields with local data.
          const utcDec = (function(d){
            if (!d) return NaN;
            return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
          })(serverUtc);
          let offsetHours = zurichDec - utcDec;

          if (offsetHours > 12) offsetHours -= 24;
          if (offsetHours < -12) offsetHours += 24;
          return Math.round(offsetHours * 60);
        } catch (e) {
          // fall through
        }
      }

      return -new Date().getTimezoneOffset();
    },

    // ---------------------------------------------------------
    // Azimuth -> direction (German)
    // ---------------------------------------------------------
    azimuthToDirection(az) {
      if (typeof az !== "number" || Number.isNaN(az)) return "–";
      const a = ((az % 360) + 360) % 360;
      const dirs = [
        "Nord", "Nord-Nordost", "Nordost", "Ost-Nordost",
        "Ost", "Ost-Südost", "Südost", "Süd-Südost",
        "Süd", "Süd-Südwest", "Südwest", "West-Südwest",
        "West", "West-Nordwest", "Nordwest", "Nord-Nordwest"
      ];
      return dirs[Math.round(a / 22.5) % 16];
    },

    // ---------------------------------------------------------
    // fetchWithRetryJson
    // ---------------------------------------------------------
    async _fetchWithRetryJson(url, attempts = 3, delayMs = 300) {
      for (let i = 0; i < attempts; i++) {
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error('status ' + r.status);
          return await r.json();
        } catch (e) {
          if (i === attempts - 1) throw e;
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
    },

    // ---------------------------------------------------------
    // init: build minuteMap, secondMap, compute rise/set/duration
    // ---------------------------------------------------------
    async init() {
      try {
        if (this._initCalled) return;
        this._initCalled = true;

        const canvas = document.getElementById("moonGraph");
        if (!canvas) {
          console.warn("moonPanel.init: canvas #moonGraph nicht gefunden — Abbruch");
          return;
        }

        // compute authoritative target offset (minutes east of UTC)
        const targetOffset = await this._computeTargetOffsetSigned();
        this._lastTargetOffset = targetOffset;

        // authoritative now (server Date header preferred)
        const simDate = (window.simTime && typeof window.simTime.getServerDateForPanel === 'function') ? window.simTime.getServerDateForPanel() : null;
        const serverUtc = simDate || await this._fetchServerDate();
        const nowUtc = serverUtc || new Date();

        // store server date + timestamp for live tick reference
        this._lastServerDate = nowUtc;
        this._lastServerTimestamp = Date.now();
        // store monotonic perf reference if available to avoid system clock jumps
        this._lastServerPerf = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : null;
        // Ensure we have a target offset (minutes east of UTC) available for downstream logic
        if (!Number.isFinite(this._lastTargetOffset)) {
          try { this._lastTargetOffset = Number.isFinite(targetOffset) ? targetOffset : (-new Date().getTimezoneOffset()); } catch(e) { this._lastTargetOffset = -new Date().getTimezoneOffset(); }
        }
        // store server-localized convenience fields
        try {
          this.serverNow = this._getNowServer();
          this.serverNowLocalStr = this._formatServerLocal(this.serverNow);
          this.serverNowUtcMs = this.serverNow.getTime();
        } catch (e) {
          this.serverNow = nowUtc;
          this.serverNowLocalStr = this._formatServerLocal(nowUtc);
          this.serverNowUtcMs = nowUtc.getTime();
        }

        const localCalendarDate = new Date(nowUtc.getTime() + (targetOffset * 60000));
        const localDate = localCalendarDate;
        const yyyy = localCalendarDate.getFullYear();
        const mm = localCalendarDate.getMonth() +1;
        const dd = localCalendarDate.getDate();

        const yyyyStr = String(yyyy);
        const mmStr = String(mm).padStart(2, "0");
        const ddStr = String(dd).padStart(2, "0");

        // yesterday local (target timezone)
        const yesterdayLocal = new Date(localDate.getTime() - 86400000);
        const yY = yesterdayLocal.getFullYear();
        const yM = yesterdayLocal.getMonth() +1;
        const yD = yesterdayLocal.getDate();

        const yYStr = String(yY);
        const yMStr = String(yM).padStart(2, "0");
        const yDStr = String(yD).padStart(2, "0");

        // per-day file URLs (files are in /livewetter/astronomie/mond/moonpos/2026/februar/)
        const urlTodayHyphen = `/livewetter/astronomie/mond/moonpos/2026/februar/out_${yyyyStr}-${mmStr}-${ddStr}.json`;
        const urlYesterdayHyphen = `/livewetter/astronomie/mond/moonpos/2026/februar/out_${yYStr}-${yMStr}-${yDStr}.json`;
        const urlTodayUnderscore = `/livewetter/astronomie/mond/moonpos/2026/februar/out_${yyyyStr}_${mmStr}_${ddStr}.json`;
        const urlYesterdayUnderscore = `/livewetter/astronomie/mond/moonpos/2026/februar/out_${yYStr}_${yMStr}_${yDStr}.json`;

        // helper: fetch month file with fallback
        const fetchMonthWithFallback = async (hyphenUrl, underscoreUrl) => {
          try {
            let resp = null;
            try { resp = await this._fetchWithRetryJson(hyphenUrl); } catch (_) { resp = null; }
            if (resp && (Array.isArray(resp.data) || Array.isArray(resp.moonpos))) {
              if (!resp.data && resp.moonpos) resp.data = resp.moonpos;
              return resp;
            }
            let resp2 = null;
            try { resp2 = await this._fetchWithRetryJson(underscoreUrl); } catch (_) { resp2 = null; }
            if (resp2 && (Array.isArray(resp2.data) || Array.isArray(resp2.moonpos))) {
              if (!resp2.data && resp2.moonpos) resp2.data = resp2.moonpos;
              if (this._debug) console.info('moonPanel: used fallback underscore filename for month file', underscoreUrl);
              return resp2;
            }
            if (this._debug) console.warn('moonPanel: month file missing for', hyphenUrl, underscoreUrl);
            return { data: [] };
          } catch (e) {
            if (this._debug) console.warn('moonPanel: fetchMonthWithFallback failed', e);
            return { data: [] };
          }
        };

        // fetch both months
        let monthTodayResp = { data: [] };
        let monthYesterdayResp = { data: [] };
        try {
          monthTodayResp = await fetchMonthWithFallback(urlTodayHyphen, urlTodayUnderscore);
        } catch (e) { monthTodayResp = { data: [] }; }
        try {
          monthYesterdayResp = await fetchMonthWithFallback(urlYesterdayHyphen, urlYesterdayUnderscore);
        } catch (e) { monthYesterdayResp = { data: [] }; }

        const monthToday = monthTodayResp || { data: [] };
        const monthYesterday = monthYesterdayResp || { data: [] };

        // helper: parse entry date/time as UTC ms (tolerant: supports ts_utc, ts_local, _utcMs, raw_nearest)
        function parseEntryToMsUTC(entry) {
          if (!entry) return NaN;
          // 1) explicit numeric _utcMs
          if (Number.isFinite(entry._utcMs)) return Number(entry._utcMs);
          // 2) raw_nearest._utcMs (some payloads include nearest raw point)
          if (entry.raw_nearest && Number.isFinite(entry.raw_nearest._utcMs)) return Number(entry.raw_nearest._utcMs);
          // 3) ISO timestamps provided as ts_utc or ts_local
          if (entry.ts_utc && typeof entry.ts_utc === 'string') {
            const ms = Date.parse(entry.ts_utc);
            if (Number.isFinite(ms)) return ms;
          }
          if (entry.ts_local && typeof entry.ts_local === 'string') {
            const ms = Date.parse(entry.ts_local);
            if (Number.isFinite(ms)) return ms;
          }
          // 4) legacy fields: date + time (fallback) — only if time is string
          if (entry.date && entry.time && typeof entry.time === 'string') {
            const iso = entry.date + 'T' + String(entry.time).split('.')[0] + 'Z';
            const ms = Date.parse(iso);
            if (Number.isFinite(ms)) return ms;
          }
          // nothing matched
          return NaN;
        }

        // helper: compute local date key (YYYY-MM-DD) for a given UTC ms and targetOffset (minutes east of UTC)
        function localDateKeyFromMsWithOffset(msUtc, targetOffsetMin) {
          if (!Number.isFinite(msUtc)) return null;
          const localMs = msUtc + (targetOffsetMin * 60000);
          const d = new Date(localMs);
          return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        }

        const targetOffsetMin = targetOffset;

        // Build yesterdayBlock and todayBlock, keep _utcMs and source
        const yesterdayBlock = (monthYesterday.data || [])
          .map(r => {
            const ms = parseEntryToMsUTC(r);
            const key = localDateKeyFromMsWithOffset(ms, targetOffsetMin);
            return Object.assign({}, r, { _utcMs: ms, _localKey: key });
          })
          .filter(r => r._localKey === `${yYStr}-${yMStr}-${yDStr}`)
          .map(r => ({
            date: r.date,
            time: (r && typeof r.time === 'string') ? r.time.split(".")[0] : null,
            elevation: r.elevation,
            azimuth: r.azimuth,
            _utcMs: r._utcMs,
            source: 'yesterday'
          }));

        const todayBlock = (monthToday.data || [])
          .map(r => {
            const ms = parseEntryToMsUTC(r);
            const key = localDateKeyFromMsWithOffset(ms, targetOffsetMin);
            return Object.assign({}, r, { _utcMs: ms, _localKey: key });
          })
          .filter(r => r._localKey === `${yyyyStr}-${mmStr}-${ddStr}`)
          .map(r => ({
            date: r.date,
            time: (r && typeof r.time === 'string') ? r.time.split(".")[0] : null,
            elevation: r.elevation,
            azimuth: r.azimuth,
            _utcMs: r._utcMs,
            source: 'today'
          }));

        // compute UTC ms that corresponds to local midnight for the chosen localCalendarDate
        // take targetOffset into account so day boundary follows local midnight
        const serverNowForRef = this._getNowServer ? this._getNowServer() : new Date();
        const offsetMinForRef = Number.isFinite(this._lastTargetOffset) ? this._lastTargetOffset : -new Date().getTimezoneOffset();
        
        // derive a local date consistent with server + offset, then compute local midnight ms
        // prefer an existing reference if present, otherwise compute local midnight ms from the local date fields
        const localDateForRef = new Date(serverNowForRef.getTime() + offsetMinForRef * 60000);
        const referenceLocalMidnightMs = Number.isFinite(this._referenceLocalMidnightMs)
          ? this._referenceLocalMidnightMs
          : (new Date(
              localCalendarDate.getFullYear(),
              localCalendarDate.getMonth(),
              localCalendarDate.getDate(),
              0, 0, 0
            )).getTime();

        // persistente Referenz für alle Interpolationen (local midnight ms)
        this._referenceLocalMidnightMs = referenceLocalMidnightMs;

        function computeUtcMsFromEntry(entry) {
          if (!entry) return NaN;
          if (Number.isFinite(entry._utcMs)) return Number(entry._utcMs);
          if (entry.date && entry.time && typeof entry.time === 'string') {
            const iso = entry.date + 'T' + String(entry.time).split('.')[0] + 'Z';
            const ms = Date.parse(iso);
            return Number.isFinite(ms) ? ms : NaN;
          }
          if (entry.time && typeof entry.time === 'string') {
            const t = entry.time.replace(/^-/, '');
            const [hh, mm] = t.split(':').map(Number);
            if (!Number.isFinite(hh) || !Number.isFinite(mm)) return NaN;
            const isNeg = entry.time.startsWith('-');
            const dayOffset = isNeg ? -1 : 0;
            // compute ms relative to local midnight reference: convert hh:mm to ms and add dayOffset
            return referenceLocalMidnightMs + dayOffset * 86400000 + hh * 3600000 + mm * 60000;
          }
          // fallback: try parseEntryToMsUTC
          const ms = parseEntryToMsUTC(entry);
          if (Number.isFinite(ms)) return ms;
          return NaN;
        }

        // Build unified list once
        const unified = [];
        (yesterdayBlock || []).forEach(r => {
          const ms = computeUtcMsFromEntry(r);
          const minuteKey = Math.floor((ms - referenceLocalMidnightMs) / 60000); // negative for yesterday local minutes
          unified.push({
            minuteKey,
            elevation: r.elevation,
            azimuth: r.azimuth,
            _utcMs: ms,
            source: r.source || 'yesterday',
            rawTime: r.time
          });
        });
        (todayBlock || []).forEach(r => {
          const ms = computeUtcMsFromEntry(r);
          const minuteKey = Math.floor((ms - referenceLocalMidnightMs) / 60000);
          unified.push({
            minuteKey,
            elevation: r.elevation,
            azimuth: r.azimuth,
            _utcMs: ms,
            source: r.source || 'today',
            rawTime: r.time
          });
        });

        // sort by minuteKey asc
        unified.sort((a, b) => a.minuteKey - b.minuteKey);

        // debug: show first collisions (if any) before dedupe (max 8)
        (function debugPreDedupe(list) {
          const byKey = new Map();
          list.forEach(it => {
            const k = it.minuteKey;
            if (!byKey.has(k)) byKey.set(k, []);
            const arr = byKey.get(k);
            if (arr.length < 8) arr.push({ src: it.source, rawTime: it.rawTime, _utcMs: it._utcMs });
          });
          const collisions = [];
          for (const [k, arr] of byKey.entries()) if (arr.length > 1) collisions.push({ minuteKey: k, examples: arr });
          if (collisions.length) {
            console.info('moonPanel: pre-dedupe collisions count', collisions.length, 'showing first 8');
            console.table(collisions.slice(0,8).map(c => ({ minuteKey: c.minuteKey, count: c.examples.length, sample: JSON.stringify(c.examples) })));
          }
        })(unified);

        // dedupe: keep entry closest to nominal minute ms; tie-breaker: today > yesterday; then later _utcMs
        const dedupedMap = new Map();
        unified.forEach(item => {
          const key = item.minuteKey;
          const nominalMs = referenceLocalMidnightMs + key * 60000;
          if (!dedupedMap.has(key)) {
            dedupedMap.set(key, item);
            return;
          }
          const existing = dedupedMap.get(key);
          const itemDist = Number.isFinite(item._utcMs) ? Math.abs(item._utcMs - nominalMs) : Infinity;
          const existDist = Number.isFinite(existing._utcMs) ? Math.abs(existing._utcMs - nominalMs) : Infinity;
          if (itemDist < existDist) {
            dedupedMap.set(key, item);
          } else if (itemDist === existDist) {
            if (item.source === 'today' && existing.source === 'yesterday') {
              dedupedMap.set(key, item);
            } else if (item.source === existing.source) {
              if (Number.isFinite(item._utcMs) && Number.isFinite(existing._utcMs) && item._utcMs > existing._utcMs) {
                dedupedMap.set(key, item);
              }
            }
          }
        });

        // rebuild raw48h in the expected format (time string with negative prefix for <0)
        let raw48h = Array.from(dedupedMap.values()).map(it => {
          const k = it.minuteKey;
          const absKey = Math.abs(k);
          const hh = Math.floor(absKey / 60);
          const mmn = absKey % 60;
          const timeStr = `${k < 0 ? '-' : ''}${String(hh).padStart(2,'0')}:${String(mmn).padStart(2,'0')}:00`;
          // localTime for debugging/display (use UTC epoch and toLocaleString with Europe/Zurich)
          const localTime = Number.isFinite(it._utcMs) ? new Date(it._utcMs).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' }) : null;
          return { time: timeStr, elevation: it.elevation, azimuth: it.azimuth, _utcMs: it._utcMs, minuteKey: it.minuteKey, localTime };
        });

        // ensure sorted by minuteKey (ascending)
        raw48h.sort((a,b) => a.minuteKey - b.minuteKey);

        // quick validation: ensure no duplicate minuteKeys and reasonable coverage
        (function validateRaw48h(list) {
          const seen = new Map();
          let dupFound = false;
          for (const it of list) {
            const minuteKey = Number.isFinite(it.minuteKey) ? it.minuteKey : (Number.isFinite(it._utcMs) ? Math.round((it._utcMs - referenceLocalMidnightMs)/60000) : null);
            if (minuteKey === null) continue;
            const s = seen.get(minuteKey) || { count: 0, examples: [] };
            s.count++;
            if (s.examples.length < 3) s.examples.push(it);
            seen.set(minuteKey, s);
            if (s.count > 1) dupFound = true;
          }
          if (dupFound) {
            console.warn('moonPanel: duplicate minuteKey(s) found in raw48h — examples:');
            for (const [k,v] of seen.entries()) if (v.count > 1) console.warn(' minuteKey', k, 'count', v.count, v.examples);
          }
          if (list.length < 560) console.info('moonPanel: raw48h length suspiciously small', list.length);
        })(raw48h);

        // --- ensure next-day head is present to allow interpolation across midnight ---
        (function appendNextDayHead() {
          try {
            if (!Array.isArray(raw48h) || raw48h.length === 0) return;
            const Nmin = 120; // Anzahl Minuten vom nächsten Tag anhängen (z.B. 120 = 2h)
            const head = raw48h.filter(r => Number.isFinite(r.minuteKey) && r.minuteKey >= 0).slice(0, Nmin);
            if (!head.length) return;
            const appended = head.map(r => ({
              time: r.time,
              elevation: r.elevation,
              azimuth: r.azimuth,
              _utcMs: Number(r._utcMs) + 86400000,
              minuteKey: Number(r.minuteKey) + 1440,
              localTime: new Date(Number(r._utcMs) + 86400000).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' })
            }));
            raw48h = raw48h.concat(appended);
          } catch (e) {
            if (this._debug) console.warn('moonPanel: appendNextDayHead failed', e);
          }
        }).call(this);

        // ---------------------------------------------------------
        // Defensive expansion: fill large gaps in raw48h by minute-wise interpolation
        // Uses _utcMs timestamps to interpolate real-time gaps (prevents long flat zones).
        // ---------------------------------------------------------
        (function expandRaw48hByMinutes() {
          try {
            if (!Array.isArray(raw48h) || raw48h.length === 0) return;
            // ensure sorted by _utcMs ascending
            raw48h.sort((a,b) => {
              const am = Number.isFinite(a._utcMs) ? a._utcMs : 0;
              const bm = Number.isFinite(b._utcMs) ? b._utcMs : 0;
              return am - bm;
            });

            const expanded = [];
            for (let i = 0; i < raw48h.length; i++) {
              const cur = raw48h[i];
              expanded.push(Object.assign({}, cur));
              const next = raw48h[i + 1];
              if (!next) continue;

              const curMs = Number.isFinite(cur._utcMs) ? cur._utcMs : NaN;
              const nextMs = Number.isFinite(next._utcMs) ? next._utcMs : NaN;
              if (!Number.isFinite(curMs) || !Number.isFinite(nextMs)) continue;

              const deltaSec = Math.round((nextMs - curMs) / 1000);
              // if gap is larger than 90 seconds, interpolate per minute
              if (deltaSec > 90) {
                const startSec = Math.ceil(curMs / 1000);
                const endSec = Math.floor(nextMs / 1000);
                for (let s = startSec + 60; s < endSec; s += 60) {
                  const f = (s - (curMs/1000)) / (nextMs/1000 - curMs/1000);
                  const elev = (Number.isFinite(cur.elevation) && Number.isFinite(next.elevation))
                    ? (cur.elevation + (next.elevation - cur.elevation) * f)
                    : (cur.elevation ?? next.elevation);
                  let a0 = Number.isFinite(cur.azimuth) ? cur.azimuth : (next.azimuth ?? 0);
                  let a1 = Number.isFinite(next.azimuth) ? next.azimuth : a0;
                  let diff = a1 - a0;
                  if (diff > 180) diff -= 360;
                  if (diff < -180) diff += 360;
                  const az = (a0 + diff * f + 360) % 360;
                  const ms = s * 1000;
                  const relMs = ms - referenceLocalMidnightMs;
                  const minuteKey = Math.floor(relMs / 60000);
                  const absKey = Math.abs(minuteKey);
                  const hh = Math.floor(absKey / 60);
                  const mm = absKey % 60;
                  const timeStr = `${minuteKey < 0 ? '-' : ''}${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00`;
                  const localTime = new Date(ms).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' });
                  expanded.push({ time: timeStr, elevation: elev, azimuth: az, _utcMs: ms, minuteKey, localTime });
                }
              }
            }

            // additionally: interpolate across midnight between last and first (if gap)
            try {
              const ptsByUtc = raw48h
                .map(r => ({ ms: Number.isFinite(r._utcMs) ? r._utcMs : NaN, r }))
                .filter(p => Number.isFinite(p.ms))
                .sort((a,b)=>a.ms-b.ms);
              if (ptsByUtc.length >= 2) {
                const a = ptsByUtc[ptsByUtc.length-1];
                const b = ptsByUtc[0];
                if (a && a.r && b && b.r) {
                  let aSec = Math.round(a.ms/1000);
                  let bSec = Math.round(b.ms/1000);
                  if (bSec <= aSec) bSec += 86400;
                  const span = bSec - aSec;
                  if (span > 90 && span < 86400) {
                    for (let s = aSec + 60; s < bSec; s += 60) {
                      const f = (s - aSec) / (bSec - aSec);
                      const cur = a.r;
                      const next = b.r;
                      const elev = (Number.isFinite(cur.elevation) && Number.isFinite(next.elevation))
                        ? (cur.elevation + (next.elevation - cur.elevation) * f)
                        : (cur.elevation ?? next.elevation);
                      let a0 = Number.isFinite(cur.azimuth) ? cur.azimuth : (next.azimuth ?? 0);
                      let a1 = Number.isFinite(next.azimuth) ? next.azimuth : a0;
                      let diff = a1 - a0;
                      if (diff > 180) diff -= 360;
                      if (diff < -180) diff += 360;
                      const az = (a0 + diff * f + 360) % 360;
                      const ms = s * 1000;
                      const relMs = ms - referenceLocalMidnightMs;
                      const minuteKey = Math.floor(relMs / 60000);
                      const absKey = Math.abs(minuteKey);
                      const hh = Math.floor(absKey / 60);
                      const mm = absKey % 60;
                      const timeStr = `${minuteKey < 0 ? '-' : ''}${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00`;
                      const localTime = new Date(ms).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' });
                      expanded.push({ time: timeStr, elevation: elev, azimuth: az, _utcMs: ms, minuteKey, localTime });
                    }
                  }
                }
              }
            } catch (e) {
              // non-fatal
            }

            // sort expanded by minuteKey ascending (stable)
            expanded.sort((a,b) => {
              const ka = Number.isFinite(a.minuteKey) ? a.minuteKey : Math.round((a._utcMs - referenceLocalMidnightMs)/60000);
              const kb = Number.isFinite(b.minuteKey) ? b.minuteKey : Math.round((b._utcMs - referenceLocalMidnightMs)/60000);
              return ka - kb;
            });

            // replace raw48h with expanded version
            raw48h.length = 0;
            Array.prototype.push.apply(raw48h, expanded);
            if (this._debug) console.info('moonPanel: expanded raw48h by minute interpolation, new length', raw48h.length);
          } catch (e) {
            if (this._debug) console.warn('moonPanel: expandRaw48hByMinutes failed', e);
          }
        }).call(this);

        // build minuteMap covering -1440..1439 using module helper
        const minuteMap = buildMinuteMapFromRaw(raw48h);

        // Guarded assignment: only replace existing minuteMap when the new map is valid
        if (this._hasValidMinuteMap(minuteMap) || this._forceRecompute === true) {
          this.minuteMap = minuteMap;
          this._minuteMapBuilt = true;
          if (this._debug) console.info('moonPanel: minuteMap assigned (valid)', { size: minuteMap.size });
        } else {
          if (this._debug) console.warn('moonPanel: minuteMap assignment skipped (invalid minuteMap)', { minuteMapSize: minuteMap instanceof Map ? minuteMap.size : null });
          this.minuteMap = this.minuteMap || new Map();
        }

        // keep only valid entries for lastDayData
        this.lastDayData = Array.isArray(raw48h)
          ? raw48h.filter(r => Number.isFinite(r.elevation) && Number.isFinite(r.azimuth))
          : [];

        // --- Sun data (48h approach) ---
        const sunUrlToday = `/livewetter/astronomie/sonne/sun_${yyyyStr}_${mmStr}.json`;
        const sunUrlYesterday = `/livewetter/astronomie/sonne/sun_${yYStr}_${yMStr}.json`;

        let sunMonthTodayResp = {};
        let sunMonthYesterdayResp = {};
        try { sunMonthTodayResp = await this._fetchWithRetryJson(sunUrlToday).catch(() => ({})); } catch (e) { sunMonthTodayResp = {}; }
        try { sunMonthYesterdayResp = await this._fetchWithRetryJson(sunUrlYesterday).catch(() => ({})); } catch (e) { sunMonthYesterdayResp = {}; }

        const sunBlockToday = sunMonthTodayResp ? sunMonthTodayResp[`${yyyyStr}-${mmStr}-${ddStr}`] : null;
        const sunBlockYesterday = sunMonthYesterdayResp ? sunMonthYesterdayResp[`${yYStr}-${yMStr}-${yDStr}`] : null;

        let sunYesterdayBlock = Array.isArray(sunBlockYesterday) ? sunBlockYesterday.map(e => ({
          time: e[0].split(".")[0],
          elevation: e[1],
          azimuth: e[2]
        })) : [];

        let sunTodayBlock = Array.isArray(sunBlockToday) ? sunBlockToday.map(e => ({
          time: e[0].split(".")[0],
          elevation: e[1],
          azimuth: e[2]
        })) : [];

        let negSunYesterday = sunYesterdayBlock.map(r => {
          const [h, m] = r.time.split(":").map(Number);
          const total = h * 60 + m;
          const neg = total - 1440;
          const nh = Math.floor(Math.abs(neg) / 60);
          const nm = Math.abs(neg) % 60;
          return {
            time: `${neg < 0 ? "-" : ""}${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}:00`,
            elevation: r.elevation,
            azimuth: r.azimuth
          };
        });
        // Build rawSun48 using the same local-midnight reference as the moon data,
        // and append a next-day head so interpolation across midnight is robust.
        let rawSun48 = [...negSunYesterday, ...sunTodayBlock];

        // Normalize entries to include _utcMs and minuteKey relative to referenceLocalMidnightMs
        rawSun48 = rawSun48.map(r => {
          let ms = Number.isFinite(r._utcMs) ? Number(r._utcMs) : NaN;
          if (!Number.isFinite(ms)) {
            const t = String(r.time).replace(/^-/, '');
            const [hh, mm] = t.split(':').map(Number);
            const neg = String(r.time).startsWith('-');
            const dayOffset = neg ? -1 : 0;
            ms = referenceLocalMidnightMs + dayOffset * 86400000 + (hh * 3600000) + (mm * 60000);
          }
          const minuteKey = Math.floor((ms - referenceLocalMidnightMs) / 60000);
          const absKey = Math.abs(minuteKey);
          const hh = Math.floor(absKey / 60);
          const mmn = absKey % 60;
          const timeStr = `${minuteKey < 0 ? '-' : ''}${String(hh).padStart(2,'0')}:${String(mmn).padStart(2,'0')}:00`;
          return { time: timeStr, elevation: r.elevation, azimuth: r.azimuth, _utcMs: ms, minuteKey };
        });

        // append next-day head (first N minutes of day) to allow interpolation across midnight
        (function appendSunNextDayHead() {
          try {
            if (!Array.isArray(rawSun48) || rawSun48.length === 0) return;
            const Nmin = 120;
            const head = rawSun48.filter(r => Number.isFinite(r.minuteKey) && r.minuteKey >= 0).slice(0, Nmin);
            if (!head.length) return;
            const appended = head.map(r => ({
              time: r.time,
              elevation: r.elevation,
              azimuth: r.azimuth,
              _utcMs: Number(r._utcMs) + 86400000,
              minuteKey: Number(r.minuteKey) + 1440,
              localTime: new Date(Number(r._utcMs) + 86400000).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' })
            }));
            rawSun48 = rawSun48.concat(appended);
          } catch (e) { /* ignore */ }
        })();

        // sort and build minute map
        rawSun48.sort((a, b) => {
          const ka = Number.isFinite(a.minuteKey) ? a.minuteKey : Math.round((a._utcMs - referenceLocalMidnightMs)/60000);
          const kb = Number.isFinite(b.minuteKey) ? b.minuteKey : Math.round((b._utcMs - referenceLocalMidnightMs)/60000);
          return ka - kb;
        });
        const sunMinuteMap = buildMinuteMapFromRaw(rawSun48);
    
// --- replaced: compute sunFineElevation and phase timeline using new helpers ---
const offsetMinForSun = Number.isFinite(this._lastTargetOffset) ? Number(this._lastTargetOffset) : -new Date().getTimezoneOffset();

// Build a canonical sunMinuteMap from the finalRaw (if you have finalRaw array available)
// If you already have sunMinuteMap variable (as in file), keep it. Otherwise build from finalRaw:
// const sunMinuteMap = window._moonInterpolation?.buildMinuteMapFromRaw ? window._moonInterpolation.buildMinuteMapFromRaw(finalRaw, this._referenceLocalMidnightMs) : sunMinuteMap;

this.sunMinuteMap = sunMinuteMap; // keep reference for debugging

// Compute sunFineElevation (local minute domain) using interpolation helper if available
const interpFn = (typeof window._moonInterpolation?.interpolateMinuteMapAt === 'function') ? window._moonInterpolation.interpolateMinuteMapAt : null;
const sunFineElevation = this.computeFineElevationFromMinuteMap(this.sunMinuteMap, interpFn);

// store for renderer
this.lastSunFineElevationLocal = sunFineElevation;

// compute phase timeline and sunrise/sunset in minutes
const timelineResult = this.computeSunPhaseTimelineFromFine(sunFineElevation);

// store structured timeline (minutes)
this.sunPhaseTimeline = {
  day: timelineResult.day,
  civil: timelineResult.civil,
  nautical: timelineResult.nautical,
  astronomical: timelineResult.astronomical,
  golden: timelineResult.golden
};

// store sunrise/sunset as minutes (0..1439) and keep raw hours if you want
this.lastSunrise = Number.isFinite(timelineResult.sunriseMin) ? timelineResult.sunriseMin : null;
this.lastSunset  = Number.isFinite(timelineResult.sunsetMin)  ? timelineResult.sunsetMin  : null;
this.lastSunriseRaw = (this.lastSunrise !== null) ? (this.lastSunrise / 60) : null;
this.lastSunsetRaw  = (this.lastSunset  !== null) ? (this.lastSunset  / 60) : null;

       // debug log will be emitted after urls are known (moved below)

        this.sunMinuteMap = sunMinuteMap;

        // ---------------------------------------------------------
        // Build secondMap from raw48h and ensure 48h coverage
        // ---------------------------------------------------------
        try {
          (function buildSecondMap(self, raw, lastServerDate) {
            if (!Array.isArray(raw) || raw.length === 0) { self.secondMap = null; return; }

            const ref = Number.isFinite(self._referenceLocalMidnightMs)
  ? self._referenceLocalMidnightMs
  : (function(){
      // compute local midnight ms for lastServerDate (canonical)
      const last = lastServerDate || new Date();
      return (new Date(last.getFullYear(), last.getMonth(), last.getDate(), 0, 0, 0)).getTime();
    })();

            // Normalize points: ensure numeric sec, elev, az, ms
            const pts = raw.map(r => {
              const ms = Number.isFinite(r._utcMs) ? Number(r._utcMs) : (ref + (function(){
                const t = String(r.time).replace(/^-/, '');
                const [hh, mm, ss] = t.split(':').map(Number);
                const neg = String(r.time).startsWith('-');
                const dayOffset = neg ? -1 : 0;
                return dayOffset * 86400000 + ( (Number.isFinite(hh) ? hh : 0) * 3600 + (Number.isFinite(mm) ? mm : 0) * 60 + (Number.isFinite(ss) ? ss : 0) ) * 1000;
              })());
              const sec = Math.round((ms - ref) / 1000);
              const elev = Number.isFinite(r.elevation) ? r.elevation : (Number.isFinite(r.elev) ? r.elev : NaN);
              const az = Number.isFinite(r.azimuth) ? r.azimuth : (Number.isFinite(r.az) ? r.az : NaN);
              return { sec, elev, az, ms };
            }).filter(p => Number.isFinite(p.sec)).sort((a,b)=>a.sec-b.sec);

            const secondMap = new Map();

            // Insert primary points (keep latest if duplicate)
            for (const p of pts) {
              const key = Math.trunc(p.sec);
              const existing = secondMap.get(key);
              if (!existing) {
                secondMap.set(key, { elev: p.elev, az: p.az, ms: p.ms });
              } else {
                // prefer entry with numeric elev/az, or later ms
                if ((!Number.isFinite(existing.elev) && Number.isFinite(p.elev)) ||
                    (Number.isFinite(p.ms) && Number.isFinite(existing.ms) && p.ms > existing.ms)) {
                  secondMap.set(key, { elev: p.elev, az: p.az, ms: p.ms });
                }
              }
            }

            // Interpolate gaps: per-second for small spans, per-60s for large spans
            for (let i = 0; i < pts.length - 1; i++) {
              const a = pts[i], b = pts[i+1];
              const span = b.sec - a.sec;
              if (span <= 1) continue;
              if (span <= 600) {
                for (let s = a.sec + 1; s < b.sec; s++) {
                  if (secondMap.has(s)) continue;
                  const f = (s - a.sec) / (b.sec - a.sec);
                  const elev = (Number.isFinite(a.elev) && Number.isFinite(b.elev)) ? (a.elev + (b.elev - a.elev) * f) : (a.elev ?? b.elev);
                  let diff = Number.isFinite(a.az) && Number.isFinite(b.az) ? (b.az - a.az) : 0;
                  if (diff > 180) diff -= 360;
                  if (diff < -180) diff += 360;
                  const az = ( (Number.isFinite(a.az) ? a.az : 0) + diff * f + 360 ) % 360;
                  const ms = Math.round(ref + s * 1000);
                  secondMap.set(s, { elev, az, ms });
                }
              } else {
                for (let s = a.sec + 60; s < b.sec; s += 60) {
                  if (secondMap.has(s)) continue;
                  const f = (s - a.sec) / (b.sec - a.sec);
                  const elev = (Number.isFinite(a.elev) && Number.isFinite(b.elev)) ? (a.elev + (b.elev - a.elev) * f) : (a.elev ?? b.elev);
                  let diff = Number.isFinite(a.az) && Number.isFinite(b.az) ? (b.az - a.az) : 0;
                  if (diff > 180) diff -= 360;
                  if (diff < -180) diff += 360;
                  const az = ( (Number.isFinite(a.az) ? a.az : 0) + diff * f + 360 ) % 360;
                  const ms = Math.round(ref + s * 1000);
                  secondMap.set(s, { elev, az, ms });
                }
              }
            }

            // Ensure 48h coverage by duplicating ±86400 (use shallow copies to avoid accidental mutation)
            const keys = Array.from(secondMap.keys());
            for (const k of keys) {
              const v = secondMap.get(k);
              if (!secondMap.has(k + 86400)) secondMap.set(k + 86400, { elev: v.elev, az: v.az, ms: (Number.isFinite(v.ms) ? v.ms + 86400000 : undefined) });
              if (!secondMap.has(k - 86400)) secondMap.set(k - 86400, { elev: v.elev, az: v.az, ms: (Number.isFinite(v.ms) ? v.ms - 86400000 : undefined) });
            }

            self.secondMap = secondMap;
          })(this, raw48h, this._lastServerDate);
        } catch (e) {
          if (this._debug) console.warn('moonPanel: buildSecondMap failed', e);
          this.secondMap = null;
        }

        // ---------------------------------------------------------
        // Start live ticker if not running
        // ---------------------------------------------------------
        if (!this._liveTickerId) {
          this._startLiveTicker();
        }

        // ensure UI is drawn once data ready and start periodic redraw
        try {

    // Sanity Check: falls minuteMap/lastDayData inkonsistent sind, erzwinge Rebuild
    try {
      const inconsistent = (
        !this.lastDayData?.find(d => d.minuteKey === 0) ||
        (this.minuteMap instanceof Map && Array.from(this.minuteMap.keys()).filter(k => k < 0).length > 1000)
      );
      if (inconsistent) {
        console.warn('moonPanel: minuteMap/lastDayData inconsistent — forcing rebuild');
        this._forceRecompute = true;
        await this._rebuildFromPerDay();
        this._forceRecompute = false;
      }
    } catch (e) {
      if (this._debug) console.warn('moonPanel: sanity check failed', e);
    }

    if (typeof window.drawMoonGraph === 'function') {
      // buildMoonPayload: always compute fresh kulmination and sun arrays at call time
      const buildMoonPayload = (overrides = {}) => {
        // normalize kulmination from current panel state
        let kul = this.lastKulmination && Object.keys(this.lastKulmination).length ? this.lastKulmination : null;
        if (!kul) {
          kul = { minute: null, time: null, timeStr: null, elev: null };
        } else {
          if (kul.minute != null && !Number.isFinite(kul.time)) kul.time = kul.minute / 60;
          if (!kul.timeStr && Number.isFinite(kul.minute)) kul.timeStr = `${String(Math.floor(kul.minute/60)).padStart(2,'0')}:${String(kul.minute%60).padStart(2,'0')}`;
        }

        const sunFine = (Array.isArray(this.lastSunFineElevationLocal) && this.lastSunFineElevationLocal.length === 1440)
          ? this.lastSunFineElevationLocal
          : (Array.isArray(this.lastSunFine) && this.lastSunFine.length === 1440) ? this.lastSunFine : new Array(1440).fill(NaN);

        return {
          fineElevation: this.lastFineElevationLocal,
         sunFineElevation: sunFine,
          sunFine: sunFine,
          kulmination: kul,
          riseBefore: this.lastRiseBefore,
          setAfter: this.lastSetAfter,
          sunrise: Number.isFinite(this.lastSunrise) ? this.lastSunrise : null,
          sunset: Number.isFinite(this.lastSunset) ? this.lastSunset : null,
          sunPhaseTimeline: this.sunPhaseTimeline || null,
          currentSunPhase: this.currentSunPhase || null,
          showLivePoint: true,
          livePos: this.getLivePos ? this.getLivePos() : window.moonLivePos,
          serverTimeLocal: this.serverNowLocalStr,
          ...overrides
        };
      }; // Ende buildMoonPayload

      // expose buildMoonPayload on the panel instance
      this.buildMoonPayload = buildMoonPayload;

      // computeKulmination: find minute of max elevation and set this.lastKulmination
      this.computeKulmination = function() {
        const arr = Array.isArray(this.lastFineElevationLocal) ? this.lastFineElevationLocal : (this.lastFineElevation || []);
        if (!arr || !arr.length) {
          this.lastKulmination = { minute: null, time: null, timeStr: null, elev: null };
          return this.lastKulmination;
        }
        let maxElev = -Infinity, maxMin = null;
        arr.forEach((v,i)=>{ if (Number.isFinite(v) && v>maxElev){ maxElev=v; maxMin=i; }});
        if (maxMin === null) {
          this.lastKulmination = { minute: null, time: null, timeStr: null, elev: null };
        } else {
          this.lastKulmination = {
            minute: maxMin,
            time: +(maxMin/60).toFixed(6),
            timeStr: `${String(Math.floor(maxMin/60)).padStart(2,'0')}:${String(maxMin%60).padStart(2,'0')}`,
            elev: maxElev
          };
        }
        return this.lastKulmination;
      };

      // compute initial kulmination if fine array already present
      try { this.computeKulmination(); } catch(e) {}

      // Hook: call computeKulmination whenever lastFineElevationLocal is updated.
      // Call this.onFineElevationUpdated() after you set this.lastFineElevationLocal.
      this.onFineElevationUpdated = () => {
        this.computeKulmination();
        // optional: trigger redraw
        try {
          if (typeof this.render === 'function') this.render();
          else if (window.drawMoonGraph && document.getElementById('moonGraph')) {
            try { window.drawMoonGraph(document.getElementById('moonGraph'), this.buildMoonPayload()); } catch(e){ /* ignore */ }
          }
        } catch(e){}
      };

      // guarded initial draw: ensure moon + sun fine arrays exist before first draw
      try {
        const canvas = document.getElementById('moonGraph');
        const panel = this;
        const ensureFineArraysAndDraw = async () => {
          const maxAttempts = 6; // retry up to ~6 seconds
          let attempt = 0;
          const hasMoonFine = () => Array.isArray(panel.lastFineElevationLocal) && panel.lastFineElevationLocal.length === 1440;
          const hasSunFine  = () => Array.isArray(panel.lastSunFineElevationLocal) && panel.lastSunFineElevationLocal.length === 1440;

          while (attempt < maxAttempts) {
            if (!hasMoonFine()) {
              try { if (typeof panel.buildMoonMinuteMapAndFine === 'function') await panel.buildMoonMinuteMapAndFine(panel._referenceLocalMidnightMs); } catch (e) { if (panel._debug) console.warn('buildMoonMinuteMapAndFine failed', e); }
            }
            if (!hasSunFine()) {
              try { if (typeof panel.buildSunMinuteMapAndFine === 'function') await panel.buildSunMinuteMapAndFine(panel._referenceLocalMidnightMs); } catch (e) { if (panel._debug) console.warn('buildSunMinuteMapAndFine failed', e); }
            }
            if (hasMoonFine() && hasSunFine()) {
              try { window.drawMoonGraph?.(canvas, buildMoonPayload()); } catch (e) { /* ignore */ }
              return true;
            }
            await new Promise(res => setTimeout(res, 1000));
            attempt++;
          }

          // final fallback draw (defensive)
          try { window.drawMoonGraph?.(canvas, buildMoonPayload()); } catch (e) { /* ignore */ }
          return false;
        };

        // run but do not block init completion
        ensureFineArraysAndDraw().then(ok => { if (this._debug) console.info('initial draw readiness', ok ? 'ok' : 'fallback-draw'); });

        // start/replace periodic redraw (1s)
        if (window._moonGraphInterval) clearInterval(window._moonGraphInterval);
        window._moonGraphInterval = setInterval(() => {
          try { window.drawMoonGraph(document.getElementById('moonGraph'), buildMoonPayload()); } catch (e) { /* ignore */ }
        }, 1000);
      } catch (e) { /* ignore */ }
    }
        } catch (e) { /* ignore */ }

        return true;

      } catch (e) {
        console.error('moonPanel.init() failed', e);
        this._initCalled = false;
        throw e;
      }
    },

    // Fallback: rebuild minuteMap + lastDayData from per-day JSONs (yesterday + today)
    async _rebuildFromPerDay() {
      
    this._minuteMapBuilt = false;
        if (this._debug) console.info('moonPanel: _rebuildFromPerDay start - minuteMapBuilt=false');

      try {
        if (this._debug) {
     try {
  } catch (e) { /* ignore */ }
}

        const nowServer = this._getNowServer ? this._getNowServer() : new Date();
        const targetOffset = Number.isFinite(this._lastTargetOffset) ? this._lastTargetOffset : (-new Date().getTimezoneOffset());
        const local = new Date(nowServer.getTime() + targetOffset * 60000);
        const yyyy = String(local.getFullYear());
        const mm = String(local.getMonth() + 1).padStart(2,'0');
        const dd = String(local.getDate()).padStart(2,'0');
        const y = new Date(local.getTime() - 86400000);
        const yY = String(y.getFullYear());
        const yM = String(y.getMonth() + 1).padStart(2,'0');
        const yD = String(y.getDate()).padStart(2,'0');

        // Pfad anpassen falls nötig
        const base = '/livewetter/astronomie/mond/moonpos/2026/februar/';
        const urls = [
          `${base}out_${yY}-${yM}-${yD}.json`,
          `${base}out_${yyyy}-${mm}-${dd}.json`
        ];

        if (this._debug) {
          try {
            console.info('moonPanel: _rebuildFromPerDay start', {
              referenceLocalMidnightMs: this._referenceLocalMidnightMs,
              lastServerDate: this._lastServerDate && this._lastServerDate.toISOString(),
              urlsAttempted: urls
            });
          } catch (e) { /* ignore */ }
        }

        const files = [];

        for (const u of urls) {
          try {
            const r = await fetch(u, { cache: 'no-store' });
            if (!r.ok) { if (this._debug) console.warn('fetch failed', u, r.status); files.push(null); continue; }
            const j = await r.json();
            const arr = j.data || j.moonpos || j;
            files.push(Array.isArray(arr) ? arr : null);
          } catch (e) {
            if (this._debug) console.warn('fetch error', u, e);
            files.push(null);
          }
        }

        // ensure we start with a fresh minuteMap for this rebuild
        if (this.minuteMap && typeof this.minuteMap.clear === 'function') {
          this.minuteMap.clear();
        } else {
          this.minuteMap = new Map();
        }
        const raw48 = [];

        // Compute canonical reference local midnight in panel's target local time.
        // Use panel._lastServerDate (server absolute time) and apply panel target offset (minutes)
        // to derive the correct local calendar date, then compute local midnight ms.
        const lastServerDate = this._lastServerDate || new Date(this.serverNowUtcMs || Date.now());
        const offsetMin = Number.isFinite(this._lastTargetOffset) ? this._lastTargetOffset : -new Date().getTimezoneOffset();
        // convert server absolute ms to the panel's local ms by adding offset minutes
        const localMsForDate = lastServerDate.getTime() + (offsetMin * 60000);
        const localDate = new Date(localMsForDate);
        const canonicalReferenceLocalMidnightMs = Number.isFinite(this._referenceLocalMidnightMs)
          ? this._referenceLocalMidnightMs
          : (new Date(localDate.getFullYear(), localDate.getMonth(), localDate.getDate(), 0, 0, 0)).getTime();
        // persist canonical reference so all code paths use the same base (local ms)
        this._referenceLocalMidnightMs = canonicalReferenceLocalMidnightMs;

        const parseItem = it => {

          if (!it) return null;
          const elev = Number.isFinite(it.elevation) ? it.elevation : (Number.isFinite(it.elev) ? it.elev : undefined);
          const az = Number.isFinite(it.azimuth) ? it.azimuth : (Number.isFinite(it.az) ? it.az : undefined);
          if (it.time && elev != null && az != null) return { time: String(it.time).split('.')[0], elevation: elev, azimuth: az, _utcMs: Number.isFinite(it._utcMs)?it._utcMs:undefined };
          
          // Normalize incoming item timestamps to local ms and compute minuteKey relative to local midnight.
          if ((it.ts_utc || it.ts_local || it._utcMs) && elev != null && az != null) {
            try {
              // prefer explicit local timestamp if present
              let localMs = null;
              if (it.ts_local) {
                // ts_local includes timezone offset, new Date(...) yields absolute ms
                localMs = new Date(it.ts_local).getTime();
              } else if (it._utcMs) {
                // _utcMs is absolute UTC ms; convert to local ms by creating Date from it (same absolute ms)
                localMs = Number(it._utcMs);
              } else if (it.ts_utc) {
                // ts_utc is an ISO UTC string; new Date(...) yields absolute ms
                localMs = new Date(it.ts_utc).getTime();
              }

              // Determine referenceLocalMidnightMs for this item.
              // Prefer the canonical panel reference if it matches the item's calendar date,
              // otherwise compute a per-item local-midnight based on ts_local or localMs.
              let referenceLocalMidnightMs = canonicalReferenceLocalMidnightMs;

              // If we have an explicit ts_local (ISO with offset), derive the calendar date from it.
              if (!Number.isFinite(referenceLocalMidnightMs) || (it && it.ts_local)) {
                if (it && it.ts_local) {
                  // ts_local is like "YYYY-MM-DDTHH:MM:SS+01:00" — extract date part to get the intended local calendar day
                  try {
                    const datePart = String(it.ts_local).split('T')[0];
                    const [iy, im, id] = datePart.split('-').map(Number);
                    if (Number.isFinite(iy) && Number.isFinite(im) && Number.isFinite(id)) {
                      referenceLocalMidnightMs = (new Date(iy, im - 1, id, 0, 0, 0)).getTime();
                    }
                  } catch (e) { /* fallthrough */ }
                }
              }

              // If still not set (or ts_local not present), derive from localMs using panel target offset
              if (!Number.isFinite(referenceLocalMidnightMs) && Number.isFinite(localMs)) {
                const offsetMin = Number.isFinite(this._lastTargetOffset) ? this._lastTargetOffset : -new Date().getTimezoneOffset();
                const localDate = new Date(localMs + offsetMin * 60000);
                referenceLocalMidnightMs = (new Date(localDate.getFullYear(), localDate.getMonth(), localDate.getDate(), 0, 0, 0)).getTime();
              }

              // Fallback: if still not set, use canonicalReferenceLocalMidnightMs (if available)
              if (!Number.isFinite(referenceLocalMidnightMs)) referenceLocalMidnightMs = canonicalReferenceLocalMidnightMs;

              if (Number.isFinite(localMs) && Number.isFinite(referenceLocalMidnightMs)) {
                const minuteKeyRaw = Math.round((localMs - referenceLocalMidnightMs) / 60000);
                const minuteKey = wrapMinute(minuteKeyRaw);
                it.minuteKey = minuteKeyRaw;
                it._minuteIndex = minuteKey;

                if (window.__MM_DBG) {
                  if (!window.__MM_DBG_COUNT) window.__MM_DBG_COUNT = 0;
                  if (window.__MM_DBG_COUNT < 40) {
                    try {
                      console.log('MM-DBG', {
                        idx: window.__MM_DBG_COUNT,
                        minuteKeyRaw: typeof minuteKeyRaw !== 'undefined' ? minuteKeyRaw : null,
                        minuteKey: typeof minuteKey !== 'undefined' ? minuteKey : (it && it._minuteIndex),
                        localMs: typeof localMs !== 'undefined' ? new Date(localMs).toISOString() : null,
                        ts_local: it && it.ts_local,
                        _utcMs: it && it._utcMs,
                        refLocalMidIso: typeof referenceLocalMidnightMs !== 'undefined' ? new Date(referenceLocalMidnightMs).toISOString() : (this && this._referenceLocalMidnightMs ? new Date(this._referenceLocalMidnightMs).toISOString() : null)
                      });
                    } catch(e){}
                    window.__MM_DBG_COUNT++;
                  }
                }
                // NOTE: Do not write into panel.minuteMap here.
                // The minuteMap will be built once from the fully normalized finalRaw array below.
                // Keep minuteKeyRaw/_minuteIndex on the item for later normalization.
                // by buildMinuteMapFromRaw / interpolation helper below.
                // optional debug: remove after verification
                // console.debug('MM-DBG insert', { minuteKeyRaw, minuteKey, ts_local: it.ts_local, _utcMs: it._utcMs, refIso: new Date(referenceLocalMidnightMs).toISOString() });
              }

            } catch (e) {
              // non-fatal: leave item as-is
            }
          }

          return null;
        };

        for (const arr of files) if (Array.isArray(arr)) for (const it of arr) { const p = parseItem(it); if (p) raw48.push(p); }
        if (!raw48.length) {
          if (this._debug) console.warn('moonPanel: _rebuildFromPerDay found no raw entries');
          return false;
        }
        // persist the canonical reference so parseItem and other code paths use the same value
        this._referenceLocalMidnightMs = referenceLocalMidnightMs;

        // normalize and compute minuteKey
        const normalized = raw48.map(r => {
          let ms = Number.isFinite(r._utcMs) ? Number(r._utcMs) : NaN;
          if (!Number.isFinite(ms)) {
            const t = String(r.time || '').replace(/^-/, '');
            const parts = t.split(':').map(Number);
            const hh = parts[0] || 0; const mmn = parts[1] || 0;
            const neg = String(r.time || '').startsWith('-');
            const dayOffset = neg ? -1 : 0;
            ms = referenceLocalMidnightMs + dayOffset * 86400000 + hh * 3600000 + mmn * 60000;
          }
          const minuteKey = Math.floor((ms - referenceLocalMidnightMs) / 60000);
          return { time: r.time, elevation: r.elevation, azimuth: r.azimuth, _utcMs: ms, minuteKey };
        }).filter(x => Number.isFinite(x.elevation) && Number.isFinite(x.azimuth));

        if (!normalized.length) {
          if (this._debug) console.warn('moonPanel: normalized empty after filtering');
          return false;
        }

        // append next-day head for interpolation across midnight
        const head = normalized.filter(r => Number.isFinite(r.minuteKey) && r.minuteKey >= 0).slice(0,120);
        const appended = head.map(r => ({ time: r.time, elevation: r.elevation, azimuth: r.azimuth, _utcMs: Number.isFinite(r._utcMs) ? r._utcMs + 86400000 : undefined, minuteKey: Number.isFinite(r.minuteKey) ? r.minuteKey + 1440 : undefined }));
        const finalRaw = normalized.concat(appended);

        // replace moon minuteMap build with deterministic builder
await this.buildMoonMinuteMapAndFine(this._referenceLocalMidnightMs);

// lastDayData: keep existing finalRaw-derived array for debugging/legacy uses
this.lastDayData = (typeof finalRaw !== 'undefined' && Array.isArray(finalRaw)) ? finalRaw.filter(r => Number.isFinite(r.minuteKey) && r.minuteKey >= -1440 && r.minuteKey <= 1439).sort((a,b)=>a.minuteKey-b.minuteKey) : (this.lastDayData || []);

// log
if (this._debug) console.info('moonPanel: buildMoonMinuteMapAndFine completed', { moonMinuteMapSize: this.moonMinuteMap?.size, lastDayDataLen: this.lastDayData?.length });

        // recompute derived arrays (call helper if present)
        if (typeof this.recomputeDerivedFromMinuteMap === 'function') {
          try { this.recomputeDerivedFromMinuteMap(); } catch(e){ if (this._debug) console.warn('recompute helper failed', e); }
        } else {
          // inline recompute fallback
          const interp = (typeof window._moonInterpolation?.interpolateMinuteMapAt === 'function') ? window._moonInterpolation.interpolateMinuteMapAt : (m,i)=>m.get(Math.round(i))||{elev:NaN,az:NaN};
          const fineElevation = new Array(1440), fineAzimuth = new Array(1440);
          for (let i=0;i<1440;i++){ const v = interp(this.moonMinuteMap,i); fineElevation[i] = v && Number.isFinite(v.elev) ? v.elev : NaN; fineAzimuth[i] = v && Number.isFinite(v.az) ? v.az : NaN; }
          let maxElev = -Infinity, maxMinute = 0;
          for (let i=0;i<1440;i++){ const v = fineElevation[i]; if (Number.isFinite(v) && v > maxElev) { maxElev = v; maxMinute = i; } }
          this.lastFineElevationLocal = fineElevation;
          if (typeof this.onFineElevationUpdated === 'function') this.onFineElevationUpdated();
          this.lastFineAzimuthLocal = fineAzimuth;
          // compute kulmination (max elevation) and store minutes + formatted time
try {
  if (Array.isArray(this.lastFineElevationLocal) && this.lastFineElevationLocal.length === 1440) {
    let maxElev = -Infinity, maxMinute = null;
    for (let i = 0; i < 1440; i++) {
      const v = this.lastFineElevationLocal[i];
      if (Number.isFinite(v) && v > maxElev) { maxElev = v; maxMinute = i; }
    }

    if (maxMinute !== null && Number.isFinite(maxElev)) {
      const timeHours = maxMinute / 60;
      const hh = Math.floor(maxMinute / 60);
      const mm = maxMinute % 60;
      const timeStr = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
      this.lastKulmination = {
        minute: maxMinute,            // integer minute 0..1439
        time: timeHours,              // hours as float (e.g. 6.4833)
        timeStr: timeStr,             // human friendly "HH:MM"
        elev: maxElev                 // elevation in degrees
      };
    } else {
      this.lastKulmination = { minute: null, time: null, timeStr: null, elev: null };
    }
  } else {
    this.lastKulmination = { minute: null, time: null, timeStr: null, elev: null };
  }
  if (this._debug) console.info('moonPanel: lastKulmination computed', this.lastKulmination);
} catch (e) {
  if (this._debug) console.warn('compute kulmination failed', e);
  this.lastKulmination = { minute: null, time: null, timeStr: null, elev: null };
}
        }

        // redraw/update
    try {
      const moonPayload = {
        fineElevation: this.lastFineElevationLocal,
        sunFineElevation: this.lastSunFineElevationLocal || new Array(1440).fill(NaN),
        sunFine: this.lastSunFineElevationLocal || new Array(1440).fill(NaN),
        kulmination: this.lastKulmination,
        riseBefore: this.lastRiseBefore,
        setAfter: this.lastSetAfter,
        sunrise: Number.isFinite(this.lastSunrise) ? this.lastSunrise : null,
        sunset: Number.isFinite(this.lastSunset) ? this.lastSunset : null,
        sunPhaseTimeline: this.sunPhaseTimeline || null,
        currentSunPhase: this.currentSunPhase || null,
        showLivePoint: true,
        livePos: this.getLivePos?.() || window.moonLivePos,
        serverTimeLocal: this.serverNowLocalStr
      };
      window.drawMoonGraph?.(document.getElementById('moonGraph'), moonPayload);
    } catch(e){}

        try { this.updatePanel?.(this.getLivePos?.(), this.lastKulmination); } catch(e){}

        // after recomputeDerivedFromMinuteMap or inline recompute finished
     this._minuteMapBuilt = this._hasValidMinuteMap(this.minuteMap);
        if (this._debug) console.info('moonPanel: minuteMap assigned (guarded), valid=', this._minuteMapBuilt, 'size=', this.minuteMap?.size);


        if (this._debug) console.info('moonPanel: _rebuildFromPerDay finished');
        return true;
      } catch (e) {
        if (this._debug) console.warn('moonPanel: _rebuildFromPerDay failed', e);
        return false;
      }
    },

    // ---------------------------------------------------------
    // _startLiveTicker: updates live position periodically
    // ---------------------------------------------------------
    
   _startLiveTicker() { 
   if (this._liveTickerId) return; 
  // --- robuster tick() Kern (ersetze die Live‑Berechnung damit) ---// 
  const tick = () => {
    
  try {
    if (!this._lastServerDate) this._lastServerDate = new Date();
    if (!Number.isFinite(this._lastTargetOffset)) this._lastTargetOffset = -new Date().getTimezoneOffset();
    if (!Number.isFinite(this._lastServerPerf) && (typeof performance !== 'undefined' && typeof performance.now === 'function')) {
      this._lastServerPerf = performance.now();
    }

    const nowServer = this._getNowServer();
    const serverLocalStr = this._formatServerLocal(nowServer);
    const offsetMin = Number.isFinite(this._lastTargetOffset) ? this._lastTargetOffset : -new Date().getTimezoneOffset();

   // compute local minute float directly from nowServer (which is an absolute Date)
   const localMinutesNowFloat = nowServer.getHours() * 60 + nowServer.getMinutes() + (nowServer.getSeconds() / 60) + (nowServer.getMilliseconds() / 60000);
   // if you still need to apply target offset (rare if nowServer already reflects server+offset), do so explicitly
   const localMinuteFloat = (localMinutesNowFloat + 1440) % 1440;

    let liveElev = NaN, liveAz = NaN, source = 'none';

    // Prefer minuteMap (consistent with curve) when available; secondMap is fallback
    if (this._minuteMapBuilt && this.minuteMap) {
      try {
        const mInterp = interpolateMinuteMapAt(this.minuteMap, localMinuteFloat);
        if (mInterp && Number.isFinite(mInterp.elev)) {
          liveElev = mInterp.elev;
          liveAz = mInterp.az;
          source = 'minuteMap';
        }
      } catch (e) { /* ignore */ }
    }

     // If minuteMap not ready or interpolation failed, try secondMap / second-precision interpolation
    if ((!Number.isFinite(liveElev) || !Number.isFinite(liveAz))) {
      try {
        // try high-precision interpolation from minuteMap if helper exists
        if (typeof interpolateSecondPrecision === 'function' && this.minuteMap) {
          const secInterp = interpolateSecondPrecision(this.minuteMap, localMinuteFloat);
          if (secInterp && Number.isFinite(secInterp.elev)) {
            liveElev = secInterp.elev;
            liveAz = secInterp.az;
            source = 'interpolateSecondPrecision';
          }
        }
      } catch (e) { /* ignore */ }

      if ((!Number.isFinite(liveElev) || !Number.isFinite(liveAz)) && this.secondMap && this._lastServerDate) {
      
        const ref = Number.isFinite(this._referenceLocalMidnightMs)
          ? this._referenceLocalMidnightMs
          : (function(){
              const offsetMin = Number.isFinite(this._lastTargetOffset) ? this._lastTargetOffset : -new Date().getTimezoneOffset();
              const localDate = new Date(this._lastServerDate.getTime() + offsetMin * 60000);
              return Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate(), 0, 0, 0) - offsetMin * 60000;
            }).call(this);
            
// compute secRel (seconds since reference) and try wrapped lookups with ±86400 fallbacks
const secRel = Math.round((nowServer.getTime() - ref) / 1000);
const secWrapped = ((secRel % 86400) + 86400) % 86400;
const radius = Number.isFinite(this._secondMapSearchRadius) ? this._secondMapSearchRadius : 10;
let best = null;

for (let d = 0; d <= radius; d++) {
  // candidate seconds to try for this radius step
  const baseCandidates = (d === 0) ? [secWrapped] : [secWrapped - d, secWrapped + d];
  for (const baseSec of baseCandidates) {
    // try same-day key, then next-day and previous-day equivalents
    const candidates = [baseSec, baseSec + 86400, baseSec - 86400];
    for (const c of candidates) {
      const p = this.secondMap.get(c);
      if (p && Number.isFinite(p.elev)) {
        // compute distance to original secRel (unwrapped) to pick nearest
        const dist = Math.abs(c - secRel);
        if (!best || dist < Math.abs(best.sec - secRel)) {
          best = { elev: p.elev, az: p.az, sec: c, ms: p.ms };
        }
      }
    }
  }
  if (best) break;
}

if (best) {
  liveElev = best.elev;
  liveAz = best.az;
  source = 'secondMap';
}

        if (best) {
          liveElev = best.elev;
          liveAz = best.az;
          source = 'secondMap';
        }
      }
    }

    // 3) Azimuth wrap fix: ensure shortest path interpolation result
    if (Number.isFinite(liveAz)) {
      liveAz = ((liveAz % 360) + 360) % 360;
    }

    // set global live pos (time in local hours) — normalize time to [0,24)
    (function(){
      const rawTime = Number.isFinite(localMinuteFloat) ? (localMinuteFloat / 60) : NaN;
      const normTime = Number.isFinite(rawTime) ? (((rawTime % 24) + 24) % 24) : NaN;
      window.moonLivePos = {
        time: Number.isFinite(normTime) ? normTime : rawTime,
        elev: Number.isFinite(liveElev) ? liveElev : NaN,
        az: Number.isFinite(liveAz) ? liveAz : NaN,
        serverUtcMs: nowServer.getTime(),
        serverLocal: serverLocalStr,
        serverOffsetMin: offsetMin,
        _liveSource: source
      };
    })();

    // update UI
    if (typeof this.updatePanel === 'function') {
      try { this.updatePanel(this.getLivePos?.(), this.lastKulmination); } catch (e) {}
    }
  } catch (e) {
    if (this._debug) console.warn('moonPanel: live tick error', e);
  }
};   
      // guard: don't start live ticker until minuteMap is built
      if (!this._minuteMapBuilt) {
        if (this._debug) console.info('moonPanel: delaying liveTicker start until minuteMap built');
        const waiter = async () => {
          for (let i = 0; i < 60; i++) { // max ~30s wait
            if (this._minuteMapBuilt) break;
            await new Promise(r => setTimeout(r, 500));
          }
          if (this._minuteMapBuilt) {
            try { tick(); this._liveTickerId = setInterval(tick, 1000); }
            catch(e){ if (this._debug) console.warn('moonPanel: failed to start liveTicker after wait', e); }
          } else {
            if (this._debug) console.warn('moonPanel: minuteMap not ready after wait — starting liveTicker anyway');
            tick(); this._liveTickerId = setInterval(tick, 1000);
          }
        };
        waiter();
      } else {
        tick();
        this._liveTickerId = setInterval(tick, 1000);
      }
    },

    // ---------------------------------------------------------
    // getLivePos helper
    // ---------------------------------------------------------
    getLivePos() {
      return window.moonLivePos || { time: NaN, elev: NaN, az: NaN };
    },

    // ---------------------------------------------------------
    // updatePanel: render live values into DOM (server-localized)
    // Expects DOM elements with IDs used above.
    // ---------------------------------------------------------
    updatePanel(getLivePos, kulmination) {
      try {
        const live = (typeof getLivePos === 'function') ? (getLivePos() || window.moonLivePos) : (window.moonLivePos || this.getLivePos());
        const kp = (id) => document.getElementById(id);

        const serverLocal = (live && live.serverLocal) || this.serverNowLocalStr || this._formatServerLocal(this._getNowServer());
        const serverTimeEl = kp('moonPanel-serverTime');
        if (serverTimeEl) serverTimeEl.textContent = `Server (Europe/Zurich): ${serverLocal}`;

        const timeEl = kp('moonPanel-live-time');
        const elevEl = kp('moonPanel-live-elev');
        const azEl = kp('moonPanel-live-az');
        const dirEl = kp('moonPanel-live-dir');

        if (timeEl) {
          const t = (live && Number.isFinite(live.time)) ? live.time : NaN;
          timeEl.textContent = Number.isFinite(t) ? `Local (h): ${ (t).toFixed(3) }` : 'Local (h): –';
        }

        if (azEl || elevEl) {
          const e = (live && Number.isFinite(live.elev)) ? live.elev : NaN;
          const a = (live && Number.isFinite(live.az)) ? live.az : NaN;
          const dirText = Number.isFinite(a) ? this.azimuthToDirection(a) : '–';
          const elevStr = Number.isFinite(e) ? `${ e.toFixed(1) }°` : '–';
          const azStr = Number.isFinite(a) ? `${ a.toFixed(1) }°` : '–';
          const combined = `${elevStr} / ${azStr} (${dirText})`;

          if (azEl) {
            azEl.textContent = combined;
          } else if (elevEl) {
            elevEl.textContent = combined;
          }

          if (dirEl) {
            dirEl.textContent = Number.isFinite(a) ? `Dir: ${dirText}` : 'Dir: –';
          }
        }

        const kulmEl = kp('moonPanel-kulm');
        if (kulmEl) {
          if (kulmination && Number.isFinite(kulmination.time) && Number.isFinite(kulmination.elev)) {
            const hh = Math.floor(kulmination.time);
            const mm = Math.round((kulmination.time - hh) * 60);
            kulmEl.innerHTML = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')} Uhr / ${kulmination.elev.toFixed(1)}°`;
          } else {
            kulmEl.textContent = '–';
          }
        }

        function formatSunHourValue(value, serverUtcMs) {
          if (value == null || !Number.isFinite(Number(value))) return '–';
          const n = Number(value);
          if (n >= 0 && n < 24) {
            const baseMs = Number.isFinite(Number(serverUtcMs)) ? Number(serverUtcMs) : Date.now();
            const serverDate = new Date(baseMs);
            const hours = Math.floor(n);
            const minutes = Math.floor((n - hours) * 60);
            const seconds = Math.round(((n - hours) * 60 - minutes) * 60);
            const localDate = new Date(serverDate.getFullYear(), serverDate.getMonth(), serverDate.getDate(), hours, minutes, seconds);
            return localDate.toLocaleString('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' });
          }
          const ms = n < 1e12 ? n * 1000 : n;
          const d = new Date(ms);
          if (isNaN(d)) return '–';
          return d.toLocaleString('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' });
        }

        const sunEl = kp('moonPanel-sun');
        if (sunEl) {
          const srVal = this.lastSunrise;
          const ssVal = this.lastSunset;
          const serverMs = this.serverNowUtcMs ?? window.moonLivePos?.serverUtcMs ?? Date.now();
          const srStr = formatSunHourValue(srVal, serverMs);
          const ssStr = formatSunHourValue(ssVal, serverMs);
          sunEl.innerHTML = `Sunrise: ${srStr}  Sunset: ${ssStr}`;
        }

        const phaseEl = kp('moonPanel-phase');
        if (phaseEl) {
          const parts = [];
          if (this.isGoldenHour) parts.push('<span class="badge">Goldene Stunde</span>');
          if (this.isBlueHour) parts.push('<span class="badge">Blaue Stunde</span>');
          if (this.isCivilTwilight) parts.push('<span class="badge">Bürgerliche Dämmerung</span>');
          if (this.isNauticalTwilight) parts.push('<span class="badge">Nautische Dämmerung</span>');
          if (this.isAstronomicalTwilight) parts.push('<span class="badge">Astronomische Dämmerung</span>');
          if (this.isNight) parts.push('<span class="badge">Nacht</span>');
          if (!parts.length) parts.push(`<span class="small">Phase: ${this.currentSunPhase || '–'}</span>`);
          phaseEl.innerHTML = parts.join(' ');
        }

      } catch (e) {
        if (this._debug) console.warn('updatePanel failed', e);
      }
    }
  };

  // Optional runtime guard: prevent invalid minuteMap overwrites (installed once)
  (function installMinuteMapGuard() {
    try {
      const panel = window.moonPanel;
      if (!panel || panel._minuteMapGuardInstalled) return;
      panel._internalMinuteMap = panel.minuteMap;
      Object.defineProperty(panel, 'minuteMap', {
        configurable: true, enumerable: true,
        get() { return this._internalMinuteMap; },
        set(v) {
          const valid = (v instanceof Map) && Array.from(v.values()).some(x => x && Number.isFinite(x.elev));
          if (panel._minuteMapBuilt && !valid && !panel._forceRecompute) {
            if (panel._debug) console.warn('Guard: prevented invalid minuteMap overwrite');
            return;
          }
          this._internalMinuteMap = v;
          if (valid) panel._minuteMapBuilt = true;
          if (panel._debug) console.info('minuteMap assigned (guarded), valid=', valid, 'size=', v instanceof Map ? v.size : null);
        }
      });
      panel._minuteMapGuardInstalled = true;
    } catch (e) { /* ignore */ }
  })();

  // --- Auto init / rebuild helper (safe, idempotent) ---
(function autoInitMoonPanel() {
  try {
    if (!window.moonPanel) return;
    if (window._moonPanelAutoInitInstalled) return;
    window._moonPanelAutoInitInstalled = true;

    async function tryRebuildAndInit() {
      try {
        const panel = window.moonPanel;
        // If minuteMap not built or fine arrays missing, force rebuild + init
        const needRebuild = !panel._minuteMapBuilt || !(Array.isArray(panel.lastFineElevationLocal) && panel.lastFineElevationLocal.length === 1440);
        if (needRebuild) {
          if (panel._debug) console.info('moonPanel autoInit: rebuilding from per-day data');
          try {
            panel._forceRecompute = true;
            await panel._rebuildFromPerDay();
          } catch (e) {
            if (panel._debug) console.warn('moonPanel autoInit: _rebuildFromPerDay failed', e);
          } finally {
            panel._forceRecompute = false;
          }
        }
        // Ensure init() runs (init() is safe to call multiple times)
        try {
          if (typeof panel.init === 'function') {
            if (panel._debug) console.info('moonPanel autoInit: calling init()');
            await panel.init();
          }
        } catch (e) {
          if (panel._debug) console.warn('moonPanel autoInit: init() failed', e);
        }
      } catch (e) {
        // swallow errors to avoid breaking page load
        try { if (window.moonPanel && window.moonPanel._debug) console.warn('moonPanel autoInit top-level error', e); } catch(_) {}
      }
    }

    // Run after DOM ready and again shortly after as fallback (handles module load order)
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      // run microtask so other module init code can run first
      setTimeout(tryRebuildAndInit, 50);
    } else {
      document.addEventListener('DOMContentLoaded', () => setTimeout(tryRebuildAndInit, 50));
    }
    // additional delayed attempt in case resources load late
    setTimeout(tryRebuildAndInit, 1500);
  } catch (e) {
    /* ignore */
  }
})();

})();
