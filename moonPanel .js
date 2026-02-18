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
          const utcDec = serverUtc.getUTCHours() + serverUtc.getUTCMinutes() / 60 + serverUtc.getUTCSeconds() / 3600;
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
        const yyyy = localCalendarDate.getUTCFullYear();
        const mm = localCalendarDate.getUTCMonth() + 1;
        const dd = localCalendarDate.getUTCDate();

        const yyyyStr = String(yyyy);
        const mmStr = String(mm).padStart(2, "0");
        const ddStr = String(dd).padStart(2, "0");

        // yesterday local (target timezone)
        const yesterdayLocal = new Date(localDate.getTime() - 86400000);
        const yY = yesterdayLocal.getUTCFullYear();
        const yM = yesterdayLocal.getUTCMonth() + 1;
        const yD = yesterdayLocal.getUTCDate();

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

        // reference LOCAL midnight ms (UTC epoch for local 00:00 of the chosen local date)
        const referenceLocalMidnightMs = Date.UTC(
          localCalendarDate.getUTCFullYear(),
          localCalendarDate.getUTCMonth(),
          localCalendarDate.getUTCDate(),
          0, 0, 0
        ) - (targetOffset * 60000);

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

        // Build sunFineElevation (local minute domain) and compute sunrise/sunset precisely
        const sunFineElevation = new Array(1440);
        const offsetMinForSun = Number.isFinite(this._lastTargetOffset) ? Number(this._lastTargetOffset) : -new Date().getTimezoneOffset();
        for (let i = 0; i < 1440; i++) {
          const localMinute = i;
          const utcMinute = (Math.round(localMinute - offsetMinForSun) + 1440) % 1440;
          const interp = interpolateMinuteMapAt(sunMinuteMap, utcMinute);
          sunFineElevation[i] = interp ? interp.elev : NaN;
        }
        // Defensive: fill NaN gaps in sunFineElevation by linear interpolation so phase detection sees night
        (function fillNaNs(arr){
          const finiteIdx = [];
          for (let i=0;i<arr.length;i++) if (Number.isFinite(arr[i])) finiteIdx.push(i);
          if (!finiteIdx.length) return;
          const first = finiteIdx[0], last = finiteIdx[finiteIdx.length-1];
          for (let i=0;i<first;i++) arr[i] = arr[first];
          for (let i=last+1;i<arr.length;i++) arr[i] = arr[last];
          for (let g=0; g<finiteIdx.length-1; g++) {
            const i0 = finiteIdx[g], i1 = finiteIdx[g+1];
            const v0 = arr[i0], v1 = arr[i1];
            const span = i1 - i0;
            if (span <= 1) continue;
            for (let k=1;k<span;k++) {
              const f = k / span;
              arr[i0 + k] = v0 + (v1 - v0) * f;
            }
          }
        })(sunFineElevation);

        // Compute sunrise and sunset as fractional hours from sunFineElevation
        let sunrise = null;
        let sunset = null;
        for (let i = 1; i < 1440; i++) {
          const prev = sunFineElevation[i - 1];
          const now = sunFineElevation[i];
          if (prev < 0 && now >= 0 && sunrise === null) {
            const f = (0 - prev) / (now - prev);
            sunrise = (i - 1 + f) / 60;
          }
          if (prev >= 0 && now < 0 && sunset === null) {
            const f = (prev - 0) / (prev - now);
            sunset = (i - 1 + f) / 60;
          }
          if (sunrise !== null && sunset !== null) break;
        }

        // ---------------------------------------------------------
        // Compute twilight phases and golden/blue hour
        // ---------------------------------------------------------
        function detectPhase(elevDeg) {
          if (elevDeg >= 6) return "day";
          if (elevDeg >= -4 && elevDeg < 6) return "golden";
          if (elevDeg >= -6 && elevDeg < -4) return "blue";
          if (elevDeg >= -6 && elevDeg < 0) return "civil";
          if (elevDeg >= -12 && elevDeg < -6) return "nautical";
          if (elevDeg >= -18 && elevDeg < -12) return "astronomical";
          return "night";
        }

        // Scan 1440 minutes and detect transitions
        let lastPhase = null;
        let phaseChanges = [];

        for (let i = 0; i < 1440; i++) {
          const elev = sunFineElevation[i];
          if (!Number.isFinite(elev)) continue;

          const phase = detectPhase(elev);
          if (phase !== lastPhase) {
            phaseChanges.push({ minute: i, phase });
            lastPhase = phase;
          }
        }

        // Convert minute → decimal hour
        function minuteToHour(m) { return m / 60; }

        // Build a structured phase timeline
        let phaseTimeline = [];
        for (let i = 0; i < phaseChanges.length; i++) {
          const cur = phaseChanges[i];
          const next = phaseChanges[i + 1];
          phaseTimeline.push({
            phase: cur.phase,
            start: minuteToHour(cur.minute),
            end: next ? minuteToHour(next.minute) : 24
          });
        }

        // Fallback: if phaseTimeline empty (e.g. missing sunMinuteMap), set coarse phase flags from sunrise/sunset
        if ((!phaseTimeline || phaseTimeline.length === 0) && (typeof sunrise === 'number' || typeof sunset === 'number')) {
          try {
            const nowServerForPhase = this._getNowServer();
            const utcMinutesNowFloat = nowServerForPhase.getUTCHours() * 60 + nowServerForPhase.getUTCMinutes() + (nowServerForPhase.getUTCSeconds() / 60) + (nowServerForPhase.getUTCMilliseconds() / 60000);
            const localMinuteFloat = (utcMinutesNowFloat + (Number.isFinite(this._lastTargetOffset) ? this._lastTargetOffset : -new Date().getTimezoneOffset()) + 1440) % 1440;
            const nowMin = Math.floor(localMinuteFloat);
            const toMin = h => Math.round((h % 24) * 60);
            const srMin = (typeof sunrise === 'number') ? toMin(sunrise) : null;
            const ssMin = (typeof sunset === 'number') ? toMin(sunset) : null;
            let curPhase = 'unknown';
            if (srMin !== null && ssMin !== null) {
              const within = (a,b,x) => { const diff = ((x - a + 1440) % 1440); const span = ((b - a + 1440) % 1440); return diff >= 0 && diff < span; };
              curPhase = within(srMin, ssMin, nowMin) ? 'day' : 'night';
            }
            const isGolden = (srMin !== null && Math.abs(((nowMin - srMin + 1440) % 1440)) <= 60) || (ssMin !== null && Math.abs(((nowMin - ssMin + 1440) % 1440)) <= 60);
            const isBlue = (srMin !== null && Math.abs(((nowMin - srMin + 1440) % 1440)) > 30 && Math.abs(((nowMin - srMin + 1440) % 1440)) <= 60) ||
                           (ssMin !== null && Math.abs(((nowMin - ssMin + 1440) % 1440)) > 30 && Math.abs(((nowMin - ssMin + 1440) % 1440)) <= 60);
            this.currentSunPhase = curPhase;
            this.isNight = curPhase === 'night';
            this.isGoldenHour = !!isGolden;
            this.isBlueHour = !!isBlue;
            this.isCivilTwilight = false;
            this.isNauticalTwilight = false;
            this.isAstronomicalTwilight = false;
            if (this._debug) console.info('moonPanel: applied fallback sun phase flags', { currentSunPhase: this.currentSunPhase, isGoldenHour: this.isGoldenHour });
          } catch (e) { if (this._debug) console.warn('fallback phase compute failed', e); }
        }
        // Store results
        this.sunPhaseTimeline = phaseTimeline;
        this.currentSunPhase = this.currentSunPhase || (phaseTimeline.length ? phaseTimeline.find(p => {
          const nowServerForPhase = this._getNowServer();
          const utcMinutesNowFloat = nowServerForPhase.getUTCHours() * 60 + nowServerForPhase.getUTCMinutes() + (nowServerForPhase.getUTCSeconds() / 60) + (nowServerForPhase.getUTCMilliseconds() / 60000);
          const localMinuteFloat = (utcMinutesNowFloat + (Number.isFinite(this._lastTargetOffset) ? this._lastTargetOffset : -new Date().getTimezoneOffset()) + 1440) % 1440;
          const nowMin = Math.floor(localMinuteFloat);
          const s = Math.round(p.start * 60), e = Math.round(p.end * 60);
          return nowMin >= s && nowMin < e;
        })?.phase : this.currentSunPhase);

        this.isNight = this.isNight || (this.currentSunPhase === 'night');
        this.isGoldenHour = this.isGoldenHour || (this.currentSunPhase === 'golden');
        this.isBlueHour = this.isBlueHour || (this.currentSunPhase === 'blue');
        this.isCivilTwilight = this.isCivilTwilight || (this.currentSunPhase === 'civil');
        this.isNauticalTwilight = this.isNauticalTwilight || (this.currentSunPhase === 'nautical');
        this.isAstronomicalTwilight = this.isAstronomicalTwilight || (this.currentSunPhase === 'astronomical');

        // SPEICHERN (konsistente Property-Namen)
        this.lastDayData = this.lastDayData || raw48h;
        // compute fineElevation/azimuth from minuteMap if not already computed
        if (!this.lastFineElevationLocal || !Array.isArray(this.lastFineElevationLocal) || this.lastFineElevationLocal.length !== 1440) {
          const fineElevation = new Array(1440).fill(NaN);
          const fineAzimuth = new Array(1440).fill(NaN);
          for (let i = 0; i < 1440; i++) {
            const v = interpolateMinuteMapAt(this.minuteMap, i);
            fineElevation[i] = v && Number.isFinite(v.elev) ? v.elev : NaN;
            fineAzimuth[i] = v && Number.isFinite(v.az) ? v.az : NaN;
          }
          this.lastFineElevationLocal = fineElevation;
          this.lastFineAzimuthLocal = fineAzimuth;
        }
        this.lastSunFineElevationLocal = sunFineElevation;
        // compute kulmination if not set
        if (!this.lastKulmination || !Number.isFinite(this.lastKulmination.elev) || this.lastKulmination.elev === -999) {
          let maxElev = -Infinity, maxMinute = 0;
          for (let i = 0; i < 1440; i++) {
            const v = this.lastFineElevationLocal[i];
            if (Number.isFinite(v) && v > maxElev) { maxElev = v; maxMinute = i; }
          }
          this.lastKulmination = { time: maxMinute / 60, elev: Number.isFinite(maxElev) ? maxElev : -999 };
        }
        this.lastRiseBefore = this.lastRiseBefore || null;
        this.lastSetAfter = this.lastSetAfter || null;
        this.lastSunrise = sunrise;
        this.lastSunset = sunset;
        this.lastSunriseRaw = sunrise;
        this.lastSunsetRaw = sunset;

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
              : Date.UTC(lastServerDate.getUTCFullYear(), lastServerDate.getUTCMonth(), lastServerDate.getUTCDate(), 0, 0, 0);
         
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

      const buildMoonPayload = (overrides = {}) => ({
        fineElevation: this.lastFineElevationLocal,
        sunFineElevation: this.lastSunFineElevationLocal,
        sunFine: this.lastSunFineElevationLocal,
        kulmination: this.lastKulmination,
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
      });

      // initial draw
      try { window.drawMoonGraph(document.getElementById('moonGraph'), buildMoonPayload()); } catch (e) { /* ignore */ }

      // start/replace periodic redraw (1s)
      if (window._moonGraphInterval) clearInterval(window._moonGraphInterval);
      window._moonGraphInterval = setInterval(() => {
        try {
          window.drawMoonGraph(document.getElementById('moonGraph'), buildMoonPayload());
        } catch (e) { /* ignore */ }
      }, 1000);
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
        const yyyy = String(local.getUTCFullYear());
        const mm = String(local.getUTCMonth() + 1).padStart(2,'0');
        const dd = String(local.getUTCDate()).padStart(2,'0');
        const y = new Date(local.getTime() - 86400000);
        const yY = String(y.getUTCFullYear());
        const yM = String(y.getUTCMonth() + 1).padStart(2,'0');
        const yD = String(y.getUTCDate()).padStart(2,'0');

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

        const raw48 = [];
        const parseItem = it => {
          if (!it) return null;
          const elev = Number.isFinite(it.elevation) ? it.elevation : (Number.isFinite(it.elev) ? it.elev : undefined);
          const az = Number.isFinite(it.azimuth) ? it.azimuth : (Number.isFinite(it.az) ? it.az : undefined);
          if (it.time && elev != null && az != null) return { time: String(it.time).split('.')[0], elevation: elev, azimuth: az, _utcMs: Number.isFinite(it._utcMs)?it._utcMs:undefined };
          if (it.ts_utc && elev != null && az != null) { const ms = (new Date(it.ts_utc)).getTime(); const d = new Date(ms); return { time: `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`, elevation: elev, azimuth: az, _utcMs: ms }; }
          if (it._utcMs && elev != null && az != null) { const d = new Date(it._utcMs); return { time: `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`, elevation: elev, azimuth: az, _utcMs: it._utcMs }; }
          return null;
        };

        for (const arr of files) if (Array.isArray(arr)) for (const it of arr) { const p = parseItem(it); if (p) raw48.push(p); }
        if (!raw48.length) {
          if (this._debug) console.warn('moonPanel: _rebuildFromPerDay found no raw entries');
          return false;
        }

        const lastServerDate = this._lastServerDate || new Date(this.serverNowUtcMs || Date.now());
        const referenceLocalMidnightMs = Date.UTC(lastServerDate.getUTCFullYear(), lastServerDate.getUTCMonth(), lastServerDate.getUTCDate(), 0,0,0) - (targetOffset * 60000);

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

        // build minuteMap (use helper if available)
        if (typeof window._moonInterpolation?.buildMinuteMapFromRaw === 'function') {
          this.minuteMap = window._moonInterpolation.buildMinuteMapFromRaw(finalRaw, referenceLocalMidnightMs);
          this.lastDayData = finalRaw.filter(r => Number.isFinite(r.minuteKey) && r.minuteKey >= -1440 && r.minuteKey <= 1439).sort((a,b)=>a.minuteKey-b.minuteKey);
        
// === Debug: Zusammenfassung der rebuild-Ergebnisse (nur wenn _debug true) ===
if (this._debug) {
  try {
    const arr = this.lastDayData || [];
    const sorted = arr.slice().sort((a,b)=> (Number(a._utcMs||0) - Number(b._utcMs||0)));
    console.info('moonPanel: rebuild summary', {
      lastDayDataLen: arr.length,
      earliestUtc: sorted[0] ? sorted[0]._utcMs : null,
      earliestLocal: sorted[0] ? new Date(sorted[0]._utcMs).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' }) : null,
      latestUtc: sorted[sorted.length-1] ? sorted[sorted.length-1]._utcMs : null,
      latestLocal: sorted[sorted.length-1] ? new Date(sorted[sorted.length-1]._utcMs).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' }) : null
    });
  } catch (e) {
    console.warn('moonPanel: rebuild summary logging failed', e);
  }
}
// === Ende Debug-Block ===

          if (this._debug) console.info('moonPanel: rebuild succeeded', { minuteMapSize: this.minuteMap?.size, lastDayDataLen: this.lastDayData?.length });
        } else {
          if (this._debug) console.error('moonPanel: buildMinuteMapFromRaw helper fehlt');
          return false;
        }

        // recompute derived arrays (call helper if present)
        if (typeof this.recomputeDerivedFromMinuteMap === 'function') {
          try { this.recomputeDerivedFromMinuteMap(); } catch(e){ if (this._debug) console.warn('recompute helper failed', e); }
        } else {
          // inline recompute fallback
          const interp = (typeof window._moonInterpolation?.interpolateMinuteMapAt === 'function') ? window._moonInterpolation.interpolateMinuteMapAt : (m,i)=>m.get(Math.round(i))||{elev:NaN,az:NaN};
          const fineElevation = new Array(1440), fineAzimuth = new Array(1440);
          for (let i=0;i<1440;i++){ const v = interp(this.minuteMap,i); fineElevation[i] = v && Number.isFinite(v.elev) ? v.elev : NaN; fineAzimuth[i] = v && Number.isFinite(v.az) ? v.az : NaN; }
          let maxElev = -Infinity, maxMinute = 0;
          for (let i=0;i<1440;i++){ const v = fineElevation[i]; if (Number.isFinite(v) && v > maxElev) { maxElev = v; maxMinute = i; } }
          this.lastFineElevationLocal = fineElevation;
          this.lastFineAzimuthLocal = fineAzimuth;
          this.lastKulmination = { time: maxMinute/60, elev: Number.isFinite(maxElev) ? maxElev : -999 };
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

    // compute local minute float (fractional minutes)
    const utcMinutesNowFloat = nowServer.getUTCHours() * 60 + nowServer.getUTCMinutes() + (nowServer.getUTCSeconds() / 60) + (nowServer.getUTCMilliseconds() / 60000);
    const localMinuteFloat = (utcMinutesNowFloat + offsetMin + 1440) % 1440;

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
        const ref = Number.isFinite(this._referenceLocalMidnightMs) ? this._referenceLocalMidnightMs : Date.UTC(this._lastServerDate.getUTCFullYear(), this._lastServerDate.getUTCMonth(), this._lastServerDate.getUTCDate(), 0, 0, 0);
        const secRel = Math.round((nowServer.getTime() - ref) / 1000);
        const radius = Number.isFinite(this._secondMapSearchRadius) ? this._secondMapSearchRadius : 10;
        let best = null;
        for (let d = 0; d <= radius; d++) {
          const candidates = d === 0 ? [secRel] : [secRel - d, secRel + d];
          for (const s of candidates) {
            const p = this.secondMap.get(s);
            if (p && Number.isFinite(p.elev)) {
              if (!best || Math.abs(s - secRel) < Math.abs(best.sec - secRel)) {
                best = { elev: p.elev, az: p.az, sec: s, ms: p.ms };
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
      }
    }

    // 3) Azimuth wrap fix: ensure shortest path interpolation result
    if (Number.isFinite(liveAz)) {
      liveAz = ((liveAz % 360) + 360) % 360;
    }

    // set global live pos (time in local hours)
    window.moonLivePos = {
      time: localMinuteFloat / 60,
      elev: Number.isFinite(liveElev) ? liveElev : NaN,
      az: Number.isFinite(liveAz) ? liveAz : NaN,
      serverUtcMs: nowServer.getTime(),
      serverLocal: serverLocalStr,
      serverOffsetMin: offsetMin,
      _liveSource: source
    };

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
