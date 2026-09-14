/**
 * Tides Plus dashboard cards.
 *
 * Two custom elements are registered:
 *
 *   custom:tides-plus-card           — the day-long chart (native SVG or ApexCharts)
 *   custom:tides-plus-summary-card   — tabular H/L breakdown for one or more stations
 *
 * Both read the same hi/lo series from the ha_tides_plus/hilo_series
 * WebSocket command (metres, UTC). Interpolation is Fritsch-Carlson PCHIP,
 * matching interpolation.py so peaks and troughs have zero slope.
 *
 * YAML:
 *
 *   type: custom:tides-plus-card
 *   stations: [8467150, 9445882]
 *   renderer: apex | native          # optional, default apex
 *   sun_entity: sun.sun              # optional
 *   unit: metric | imperial          # optional
 *
 *   type: custom:tides-plus-summary-card
 *   stations: [8467150, 9445882]
 *   unit: metric | imperial          # optional
 */

const CARD_TAG = "tides-plus-card";
const SUMMARY_TAG = "tides-plus-summary-card";

const M_TO_FT = 3.28084;

const STATION_COLORS = [
  "#1976d2",
  "#e65100",
  "#2e7d32",
  "#6a1b9a",
  "#00838f",
  "#c62828",
];

const NIGHT_FILL = "rgba(120, 144, 156, 0.18)";
const NOW_STROKE = "rgba(198, 40, 40, 0.85)";


const APEX_URL = "/ha_tides_plus/apexcharts.min.js";

const NAV_BTN_STYLE =
  "background:transparent;border:1px solid var(--divider-color,rgba(0,0,0,0.12));" +
  "color:var(--primary-text-color,inherit);border-radius:4px;padding:2px 8px;" +
  "cursor:pointer;font-size:13px;line-height:1;min-width:28px;";
const NAV_BTN_DISABLED =
  "opacity:.35;cursor:default;";


// ---------- PCHIP (mirrors interpolation.py) ----------

function pchipDerivatives(x, y) {
  const n = x.length;
  if (n < 2) return new Array(n).fill(0);
  const h = new Array(n - 1);
  const s = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = x[i + 1] - x[i];
    s[i] = (y[i + 1] - y[i]) / h[i];
  }
  const m = new Array(n).fill(0);
  for (let k = 1; k < n - 1; k++) {
    if (s[k - 1] * s[k] <= 0) {
      m[k] = 0;
    } else {
      const w1 = 2 * h[k] + h[k - 1];
      const w2 = h[k] + 2 * h[k - 1];
      m[k] = (w1 + w2) / (w1 / s[k - 1] + w2 / s[k]);
    }
  }
  m[0] = endpointSlope(h[0], n > 2 ? h[1] : h[0], s[0], n > 2 ? s[1] : s[0]);
  m[n - 1] = endpointSlope(
    h[n - 2],
    n > 2 ? h[n - 3] : h[n - 2],
    s[n - 2],
    n > 2 ? s[n - 3] : s[n - 2],
  );
  return m;
}

function endpointSlope(h0, h1, s0, s1) {
  const m = ((2 * h0 + h1) * s0 - h0 * s1) / (h0 + h1);
  if (m * s0 <= 0) return 0;
  if (s0 * s1 < 0 && Math.abs(m) > Math.abs(3 * s0)) return 3 * s0;
  return m;
}

function interpolateAt(x, y, m, t) {
  if (t < x[0] || t > x[x.length - 1]) return null;
  let lo = 0;
  let hi = x.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= t) lo = mid;
    else hi = mid;
  }
  const i = lo;
  const h = x[i + 1] - x[i];
  const s = (t - x[i]) / h;
  const h00 = (1 + 2 * s) * (1 - s) * (1 - s);
  const h10 = s * (1 - s) * (1 - s);
  const h01 = s * s * (3 - 2 * s);
  const h11 = s * s * (s - 1);
  return h00 * y[i] + h10 * h * m[i] + h01 * y[i + 1] + h11 * h * m[i + 1];
}


// ---------- shared helpers ----------

function preferredUnit(hass, override) {
  if (override === "metric" || override === "imperial") return override;
  const sys = hass && hass.config && hass.config.unit_system;
  if (sys && sys.length === "km") return "metric";
  return "imperial";
}

const unitLabel = (unit) => (unit === "metric" ? "m" : "ft");
const convertHeight = (m, unit) => (unit === "metric" ? m : m * M_TO_FT);

function localMidnight(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

function daySunTimes(hass, sunEntityId) {
  // Kept for legacy — returns today's sunrise/sunset. Newer callers use
  // sunNightRects() for arbitrary windows.
  const midnight = localMidnight();
  const tomorrow = new Date(midnight.getTime() + 86400000);
  const sun = hass && hass.states && hass.states[sunEntityId];
  if (!sun) return { sunrise: null, sunset: null };
  const rising = sun.attributes.next_rising ? new Date(sun.attributes.next_rising) : null;
  const setting = sun.attributes.next_setting ? new Date(sun.attributes.next_setting) : null;
  const project = (d) => {
    if (!d) return null;
    while (d >= tomorrow) d = new Date(d.getTime() - 86400000);
    while (d < midnight) d = new Date(d.getTime() + 86400000);
    return d;
  };
  return { sunrise: project(rising), sunset: project(setting) };
}

function sunNightRects(hass, sunEntityId, tMin, tMax) {
  // Returns [{start, end}] pairs covering the "night" (below-horizon)
  // portions of [tMin, tMax]. Uses sun.sun's next_rising/next_setting as
  // a reference and projects them forward/backward by whole days for
  // other visible days — sunrise drifts ~1 min/day so a ±7 d projection
  // is off by only a handful of minutes, invisible in the chart.
  const sun = hass && hass.states && hass.states[sunEntityId];
  if (!sun) return [];
  const rising0 = sun.attributes.next_rising ? new Date(sun.attributes.next_rising).getTime() : null;
  const setting0 = sun.attributes.next_setting ? new Date(sun.attributes.next_setting).getTime() : null;
  if (rising0 == null && setting0 == null) return [];

  const DAY = 86400000;

  // Build a sorted list of sunrise/sunset events that cover [tMin - 1d, tMax + 1d]
  // so bracketing rects at the edges close properly.
  const startEdge = tMin - DAY;
  const endEdge = tMax + DAY;
  const events = [];
  const seed = (t0, kind) => {
    if (t0 == null) return;
    // Anchor onto the first occurrence within (startEdge, startEdge + DAY]
    let t = t0;
    while (t > startEdge + DAY) t -= DAY;
    while (t <= startEdge) t += DAY;
    while (t <= endEdge) {
      events.push({ t, kind });
      t += DAY;
    }
  };
  seed(rising0, "rise");
  seed(setting0, "set");
  events.sort((a, b) => a.t - b.t);

  // Walk events and emit night rects: from a set → the following rise.
  const rects = [];
  // Determine initial state at tMin: are we before the first event's kind?
  // The first event's kind tells us what came before it.
  //   first event = rise  -> we were below horizon → night from tMin
  //   first event = set   -> we were above horizon → no leading night
  let openNight = null;
  if (events.length && events[0].kind === "rise") {
    openNight = tMin;
  }
  for (const e of events) {
    if (e.kind === "set") {
      openNight = e.t;
    } else if (e.kind === "rise") {
      if (openNight != null) {
        rects.push({ start: Math.max(openNight, tMin), end: Math.min(e.t, tMax) });
        openNight = null;
      }
    }
  }
  if (openNight != null) {
    rects.push({ start: Math.max(openNight, tMin), end: tMax });
  }
  return rects.filter((r) => r.end > r.start);
}

function fmtTimeShort(d, hass) {
  try {
    return d.toLocaleTimeString(hass && hass.locale && hass.locale.language, {
      hour: "numeric",
      minute: "2-digit",
      hour12: !(hass && hass.locale && hass.locale.time_format === "24"),
    });
  } catch (_) {
    return d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0");
  }
}


// ---------- ApexCharts lazy load ----------

let _apexPromise = null;
function ensureApexLoaded() {
  if (window.ApexCharts) return Promise.resolve();
  if (_apexPromise) return _apexPromise;
  _apexPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = APEX_URL;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load ApexCharts"));
    document.head.appendChild(s);
  });
  return _apexPromise;
}


// ---------- Shared data-fetching mixin ----------

class _TidesBase extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._series = new Map();
    this._loading = new Set();
    this._loaded = false;
    this._tickTimer = null;
  }

  connectedCallback() {
    this._tickTimer = window.setInterval(() => this._render(), 60_000);
  }

  disconnectedCallback() {
    if (this._tickTimer) {
      window.clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  setConfig(config) {
    if (!config || !config.stations || !config.stations.length) {
      throw new Error("`stations:` must list at least one NOAA station ID.");
    }
    this._config = this._defaultConfig(config);
    this._series = new Map();
    this._loaded = false;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._loaded && this._config) {
      this._loaded = true;
      this._loadAll();
    }
    this._render();
  }

  async _loadAll() {
    await Promise.all(this._config.stations.map((id) => this._loadOne(id)));
    this._render();
  }

  async _loadOne(id) {
    if (this._loading.has(id)) return;
    this._loading.add(id);
    try {
      const res = await this._hass.callWS({
        type: "ha_tides_plus/hilo_series",
        station_id: id,
      });
      this._series.set(id, res);
    } catch (err) {
      this._series.set(id, {
        error: (err && err.message) || String(err),
        station_id: id,
      });
    } finally {
      this._loading.delete(id);
    }
  }

  _computeWindow() {
    // Default: today, 00:00 → 24:00 local.
    const midnight = localMidnight();
    return { tMin: midnight.getTime(), tMax: midnight.getTime() + 86400000 };
  }

  _prepare() {
    const hass = this._hass;
    const stations = this._config.stations;
    const unit = preferredUnit(hass, this._config.unit);
    const anyLoaded = stations.some(
      (id) => this._series.get(id) && !this._series.get(id).error,
    );
    if (!anyLoaded) return null;

    const { tMin, tMax } = this._computeWindow();

    const perStation = [];
    let heightMin = Infinity;
    let heightMax = -Infinity;

    stations.forEach((id, idx) => {
      const s = this._series.get(id);
      if (!s || s.error || !s.knots || !s.knots.length) return;
      const color = STATION_COLORS[idx % STATION_COLORS.length];
      const label = s.station_name
        ? `${s.station_name}${s.station_state ? ", " + s.station_state : ""}`
        : id;

      const times = s.knots.map((k) => new Date(k.time).getTime());
      const heights = s.knots.map((k) => convertHeight(k.height, unit));
      const derivs = pchipDerivatives(times, heights);

      const samples = [];
      const step = 5 * 60 * 1000;
      for (let t = tMin; t <= tMax; t += step) {
        const y = interpolateAt(times, heights, derivs, t);
        if (y != null) samples.push([t, y]);
      }
      const currentY = interpolateAt(times, heights, derivs, Date.now());

      const allKnots = s.knots.map((k, i) => ({
        t: new Date(k.time).getTime(),
        y: heights[i],
        type: k.type,
      }));
      const dayKnots = allKnots.filter((k) => k.t >= tMin && k.t <= tMax);

      for (const [_t, y] of samples) {
        if (y < heightMin) heightMin = y;
        if (y > heightMax) heightMax = y;
      }
      for (const k of dayKnots) {
        if (k.y < heightMin) heightMin = k.y;
        if (k.y > heightMax) heightMax = k.y;
      }

      perStation.push({
        id, label, color, samples,
        allKnots, dayKnots,
        currentY, times, heights, derivs,
      });
    });

    if (!perStation.length) return null;

    const hasSamplesInWindow = perStation.some((st) => st.samples.length > 0);

    if (!isFinite(heightMin)) heightMin = 0;
    if (!isFinite(heightMax)) heightMax = 1;
    if (heightMin === heightMax) heightMax = heightMin + 1;
    // Extra headroom for the H labels above and footroom for L labels below.
    const pad = (heightMax - heightMin) * 0.22;
    heightMin -= pad;
    heightMax += pad;

    return {
      hass, unit, perStation, tMin, tMax, heightMin, heightMax,
      hasSamplesInWindow,
      nightRects: sunNightRects(hass, this._config.sun_entity, tMin, tMax),
      now: Date.now(),
    };
  }
}


// ---------- Chart card ----------

class TidesPlusCard extends _TidesBase {
  constructor() {
    super();
    this._perStation = [];
    this._chartCtx = null;
    this._apexChart = null;
    this._windowOffset = 0;   // ms shift from the "current" anchor
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._destroyApex();
  }

  _defaultConfig(config) {
    return {
      sun_entity: "sun.sun",
      anchor: "day",
      hours_before: 0,
      hours_after: 24,
      buttons: "forward-backward",
      ...config,
      stations: config.stations.map(String),
    };
  }

  setConfig(config) {
    this._destroyApex();
    this._windowOffset = 0;
    super.setConfig(config);
  }

  getCardSize() { return 4; }

  _stepMs() {
    // How far one prev/next click shifts the anchor.
    const cfg = this._config;
    if (cfg.anchor === "day") return 86400000;
    return (Number(cfg.hours_before || 0) + Number(cfg.hours_after || 0)) * 3600000
      || 86400000;
  }

  _computeWindow() {
    const cfg = this._config;
    let anchorMs;
    if (cfg.anchor === "now") {
      anchorMs = Date.now() + this._windowOffset;
    } else {
      const mid = localMidnight();
      anchorMs = mid.getTime() + this._windowOffset;
    }
    return {
      tMin: anchorMs - Number(cfg.hours_before || 0) * 3600000,
      tMax: anchorMs + Number(cfg.hours_after || 24) * 3600000,
    };
  }

  _shift(direction) {
    // direction: -1 = prev, +1 = next, 0 = reset
    if (direction === 0) {
      this._windowOffset = 0;
    } else {
      this._windowOffset += direction * this._stepMs();
    }
    this._destroyApex();
    this._render();
  }

  _render() {
    if (!this._config) return;
    const ctx = this._prepare();
    if (!ctx) {
      this.shadowRoot.innerHTML = shell(`<div style="padding:16px;">Loading tide data…</div>`);
      this._renderer = null;
      this._destroyApex();
      return;
    }

    if (!ctx.hasSamplesInWindow) {
      const canReset = this._windowOffset !== 0;
      this.shadowRoot.innerHTML = shell(`
        ${this._navHeader(ctx)}
        <div style="padding:24px 16px; text-align:center;">
          <div style="opacity:.7;">No cached tide predictions for this range.</div>
          <div style="opacity:.5; font-size:12px; margin-top:4px;">
            Coordinator caches ±7 days. Try navigating closer to today.
          </div>
          ${canReset ? `<button class="tp-nav" data-nav="reset" style="margin-top:12px;${NAV_BTN_STYLE}">Back to ${this._config.anchor === "now" ? "now" : "today"}</button>` : ""}
        </div>
      `);
      this._attachNavHandlers();
      this._destroyApex();
      return;
    }

    this._perStation = ctx.perStation;
    this._renderApex(ctx);
    this._attachNavHandlers();
  }

  _navHeader(ctx) {
    const label = this._windowLabel(ctx);
    const cfg = this._config;
    const showNav = cfg.buttons !== "none";
    const resetLabel = cfg.anchor === "now" ? "Now" : "Today";
    const atRest = this._windowOffset === 0;
    const stepLabel = cfg.anchor === "day" ? "day" : "window";

    const nav = showNav
      ? `<span style="display:inline-flex;align-items:center;gap:4px;">
           <button class="tp-nav" data-nav="reset" title="Back to ${resetLabel.toLowerCase()}"
                   ${atRest ? "disabled" : ""}
                   style="${NAV_BTN_STYLE}${atRest ? NAV_BTN_DISABLED : ""}">${resetLabel}</button>
           <button class="tp-nav" data-nav="prev" title="Previous ${stepLabel}"
                   style="${NAV_BTN_STYLE}">‹</button>
           <button class="tp-nav" data-nav="next" title="Next ${stepLabel}"
                   style="${NAV_BTN_STYLE}">›</button>
         </span>`
      : "";
    return `<div style="padding: 8px 12px 4px 16px; font-size: 13px; opacity: .9; display:flex; justify-content:space-between; align-items:center; gap: 8px;">
      <span>${label}</span>
      ${nav}
    </div>`;
  }

  _windowLabel(ctx) {
    const hass = this._hass;
    const startD = new Date(ctx.tMin);
    const endD = new Date(ctx.tMax);
    const spanMs = ctx.tMax - ctx.tMin;
    const startIsMidnight = startD.getHours() === 0 && startD.getMinutes() === 0;
    // Whole-day at local midnight, span multiple of 24h → date-only label.
    if (startIsMidnight && Math.abs(spanMs % 86400000) < 1000) {
      const days = Math.round(spanMs / 86400000);
      if (days === 1) {
        return startD.toLocaleDateString(
          hass && hass.locale && hass.locale.language,
          { weekday: "long", month: "long", day: "numeric" },
        );
      }
      const endDisplay = new Date(ctx.tMax - 86400000);   // inclusive of last day
      const fmt = { month: "short", day: "numeric" };
      return `${startD.toLocaleDateString(hass && hass.locale && hass.locale.language, fmt)} → ${endDisplay.toLocaleDateString(hass && hass.locale && hass.locale.language, fmt)}`;
    }
    // Otherwise show full range with times.
    const fmt = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
    return `${startD.toLocaleString(hass && hass.locale && hass.locale.language, fmt)} → ${endD.toLocaleString(hass && hass.locale && hass.locale.language, fmt)}`;
  }

  _attachNavHandlers() {
    this.shadowRoot.querySelectorAll("button.tp-nav").forEach((btn) => {
      if (btn.disabled) return;
      btn.addEventListener("click", () => {
        const nav = btn.dataset.nav;
        if (nav === "prev") this._shift(-1);
        else if (nav === "next") this._shift(1);
        else if (nav === "reset") this._shift(0);
      });
    });
  }

  _legendHtml(ctx) {
    const blocks = ctx.perStation
      .map(
        (s) => `
        <div class="station" data-station="${s.id}"
             style="padding:6px 16px;font-size:13px;line-height:1.5;">
          <div style="display:flex;align-items:center;margin-bottom:2px;">
            <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${s.color};margin-right:8px;flex:none;"></span>
            <strong>${s.label}</strong>
          </div>
          <div class="current" style="opacity:.9;margin-left:18px;font-size:12px;"></div>
        </div>`,
      )
      .join("");
    return `<div id="tides-legend" style="padding: 2px 0 8px;">${blocks}</div>`;
  }

  _updateLegend(cursorTime) {
    const root = this.shadowRoot.getElementById("tides-legend");
    if (!root) return;
    const u = unitLabel((this._chartCtx || {}).unit || preferredUnit(this._hass, this._config.unit));
    const at = cursorTime != null ? cursorTime : Date.now();
    const hovering = cursorTime != null;
    for (const st of this._perStation) {
      const el = root.querySelector(`.station[data-station="${st.id}"] .current`);
      if (!el) continue;
      const y = interpolateAt(st.times, st.heights, st.derivs, at);
      if (y == null) { el.textContent = "· —"; continue; }

      // Find nearest prev / next H/L across the full knot window.
      let prev = null;
      let next = null;
      for (const k of st.allKnots) {
        if (k.t <= at) {
          if (!prev || k.t > prev.t) prev = k;
        } else if (!next || k.t < next.t) {
          next = k;
        }
      }
      const timeStamp = hovering
        ? `@ ${fmtTimeShort(new Date(at), this._hass)}`
        : "now";
      const knotLabel = (k) =>
        k
          ? `<span style="opacity:.7;">${fmtTimeShort(new Date(k.t), this._hass)}</span>
             <strong style="font-variant-numeric:tabular-nums;">${k.y.toFixed(1)} ${u}</strong>
             ${eventIcon(k.type, null)}`
          : `<span style="opacity:.4;">—</span>`;
      el.innerHTML = `
        <span style="opacity:.75;">${timeStamp}</span>
        <strong style="font-variant-numeric:tabular-nums;margin-left:4px;">${y.toFixed(1)} ${u}</strong>
        <span style="margin-left:14px;opacity:.6;">prev</span> ${knotLabel(prev)}
        <span style="margin-left:14px;opacity:.6;">next</span> ${knotLabel(next)}`;
    }
  }

  // Apex renderer ---------------------------------------------------------

  async _renderApex(ctx) {
    if (!this.shadowRoot.getElementById("tides-apex-wrap")) {
      this.shadowRoot.innerHTML = shell(`
        ${this._navHeader(ctx)}
        <div id="tides-apex-wrap" style="padding: 0 8px;">
          <div id="tides-apex-chart"></div>
        </div>
        <div id="tides-apex-legend-slot"></div>
      `);
    }
    // Refresh header + legend on every render (they may have new data).
    const headerEl = this.shadowRoot.querySelector("ha-card > div");
    if (headerEl) headerEl.outerHTML = this._navHeader(ctx, "ApexCharts");
    const slot = this.shadowRoot.getElementById("tides-apex-legend-slot");
    if (slot) slot.outerHTML = `<div id="tides-apex-legend-slot">${this._legendHtml(ctx)}</div>`;

    try {
      await ensureApexLoaded();
    } catch (err) {
      this.shadowRoot.innerHTML = shell(
        `<div style="padding:16px;">Failed to load ApexCharts: ${err.message}</div>`,
      );
      return;
    }

    const options = this._buildApexOptions(ctx);
    const el = this.shadowRoot.getElementById("tides-apex-chart");
    if (!el) return;

    if (this._apexChart) {
      try { this._apexChart.updateOptions(options, true, true); }
      catch (_) { this._destroyApex(); }
    }
    if (!this._apexChart) {
      this._apexChart = new window.ApexCharts(el, options);
      await this._apexChart.render();
    }

    this._updateLegend(null);
  }

  _destroyApex() {
    if (this._apexChart) {
      try { this._apexChart.destroy(); } catch (_) {}
      this._apexChart = null;
    }
  }

  _buildApexOptions(ctx) {
    const { unit, perStation, tMin, tMax, heightMin, heightMax, nightRects: nightRectData, now, hass } = ctx;

    this._chartCtx = { tMin, tMax, unit, heightMin, heightMax };

    const series = perStation.map((st) => ({
      name: st.label,
      color: st.color,
      data: st.samples.map(([t, y]) => ({ x: t, y })),
    }));

    const discreteMarkers = [];
    perStation.forEach((st, seriesIndex) => {
      for (const k of st.dayKnots) {
        let idx = 0;
        let bestDelta = Infinity;
        for (let i = 0; i < st.samples.length; i++) {
          const d = Math.abs(st.samples[i][0] - k.t);
          if (d < bestDelta) { bestDelta = d; idx = i; } else if (st.samples[i][0] > k.t) break;
        }
        discreteMarkers.push({
          seriesIndex, dataPointIndex: idx,
          fillColor: st.color, strokeColor: "#fff", size: 5,
        });
      }
    });

    // Permanent labels next to each hi/lo knot: time + height. Positioned
    // above H's and below L's so they don't cross the curve.
    const pointAnnotations = [];
    perStation.forEach((st) => {
      for (const k of st.dayKnots) {
        pointAnnotations.push({
          x: k.t,
          y: k.y,
          seriesIndex: 0,
          marker: { size: 0, fillColor: "transparent", strokeColor: "transparent" },
          label: {
            text: `${fmtTimeShort(new Date(k.t), hass)} · ${k.y.toFixed(1)} ${unitLabel(unit)}`,
            offsetY: k.type === "H" ? -8 : 22,
            borderWidth: 0,
            borderColor: "transparent",
            style: {
              background: "transparent",
              color: st.color,
              fontSize: "10px",
              fontWeight: 600,
              padding: { top: 0, bottom: 0, left: 2, right: 2 },
            },
          },
        });
      }
    });

    const xAnnotations = [];
    for (const r of nightRectData || []) {
      xAnnotations.push({
        x: r.start, x2: r.end,
        fillColor: NIGHT_FILL, opacity: 1, borderColor: "transparent",
      });
    }
    if (now >= tMin && now <= tMax) {
      xAnnotations.push({
        x: now,
        strokeDashArray: 0,
        borderColor: NOW_STROKE,
        label: {
          text: "NOW", orientation: "horizontal", borderColor: NOW_STROKE,
          style: { color: "#fff", background: NOW_STROKE, fontSize: "10px", fontWeight: 600 },
        },
      });
    }

    // Day-boundary markers when the visible window spans more than one day.
    const spanHours = (tMax - tMin) / 3600000;
    if (spanHours > 24) {
      const dayFmt = { weekday: "short", day: "numeric" };
      let d = localMidnight(new Date(tMin));
      if (d.getTime() < tMin) d = new Date(d.getTime() + 86400000);
      while (d.getTime() <= tMax) {
        xAnnotations.push({
          x: d.getTime(),
          strokeDashArray: 4,
          borderColor: "rgba(0,0,0,0.25)",
          label: {
            text: d.toLocaleDateString(hass && hass.locale && hass.locale.language, dayFmt),
            orientation: "horizontal",
            position: "top",
            offsetY: 0,
            borderColor: "transparent",
            style: {
              color: "var(--secondary-text-color, #666)",
              background: "transparent",
              fontSize: "10px",
            },
          },
        });
        d = new Date(d.getTime() + 86400000);
      }
    }

    const self = this;

    return {
      chart: {
        type: "area", height: 240,
        toolbar: { show: false },
        zoom: { enabled: true, type: "x" },
        animations: { enabled: false },
        fontFamily: "var(--primary-font-family, sans-serif)",
        background: "transparent",
        events: {
          mouseLeave: function () {
            self._updateLegend(null);
          },
        },
      },
      theme: { mode: "light" },
      series,
      dataLabels: { enabled: false },
      stroke: { curve: "straight", width: 2 },
      // Solid-ish water fill under the curve. Keeps the station colour so
      // multi-station charts stay distinguishable, but a stronger opacity
      // (single stop) gives the "sea level filling in" look rather than the
      // washed-out gradient the earlier default produced.
      fill: {
        type: "gradient",
        gradient: { opacityFrom: 0.65, opacityTo: 0.35, stops: [0, 100] },
      },
      markers: { size: 0, discrete: discreteMarkers, hover: { size: 6 } },
      xaxis: {
        type: "datetime", min: tMin, max: tMax,
        labels: {
          datetimeUTC: false,
          format: (hass && hass.locale && hass.locale.time_format === "24") ? "H:mm" : "h TT",
        },
        tooltip: { enabled: false },
        axisTicks: { show: true },
        crosshairs: { show: true, stroke: { color: "rgba(0,0,0,0.35)", width: 1, dashArray: 3 } },
      },
      yaxis: {
        min: heightMin, max: heightMax,
        title: { text: unitLabel(unit) },
        labels: { formatter: (v) => `${v.toFixed(1)}` },
      },
      // We piggyback on apex's shared tooltip machinery to get a callback
      // per hover position, but render an empty tooltip so nothing covers
      // the graph. The real feedback goes into our legend below the chart.
      tooltip: {
        enabled: true,
        shared: true,
        intersect: false,
        followCursor: false,
        custom: function ({ dataPointIndex, w }) {
          try {
            const xs = w && w.globals && w.globals.seriesX && w.globals.seriesX[0];
            if (xs && dataPointIndex != null && dataPointIndex >= 0 && xs[dataPointIndex] != null) {
              self._updateLegend(xs[dataPointIndex]);
            }
          } catch (_) {}
          return "";
        },
      },
      grid: { borderColor: "rgba(0,0,0,0.08)" },
      legend: { show: false },
      annotations: { xaxis: xAnnotations, points: pointAnnotations },
    };
  }
}


// ---------- Summary card ----------

class TidesPlusSummaryCard extends _TidesBase {
  _defaultConfig(config) {
    return {
      ...config,
      stations: config.stations.map(String),
    };
  }

  getCardSize() { return 2; }

  _render() {
    if (!this._config) return;
    const ctx = this._prepare();
    if (!ctx) {
      this.shadowRoot.innerHTML = shell(`<div style="padding:16px;">Loading tide data…</div>`);
      return;
    }

    const u = unitLabel(ctx.unit);
    const hass = ctx.hass;
    const dateStr = new Date().toLocaleDateString(
      hass && hass.locale && hass.locale.language,
      { weekday: "long", month: "long", day: "numeric" },
    );

    const stationsHtml = ctx.perStation.map((s) => {
      const allY = s.dayKnots.map((k) => k.y);
      const swing = allY.length >= 2 ? Math.max(...allY) - Math.min(...allY) : null;
      const swingHtml = swing != null
        ? `<span style="font-size:12px;opacity:.7;margin-left:auto;font-variant-numeric:tabular-nums;">Swing <strong>${swing.toFixed(1)} ${u}</strong></span>`
        : "";
      return `
        <div style="padding: 10px 16px 12px; border-top: 1px solid rgba(0,0,0,0.06);">
          <div style="display:flex;align-items:center;margin-bottom:6px;">
            <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${s.color};margin-right:8px;flex:none;"></span>
            <span style="font-size:14px;"><strong>${s.label}</strong></span>
            ${swingHtml}
          </div>
          ${chronologicalTable(s, ctx, u, hass)}
        </div>`;
    }).join("");

    this.shadowRoot.innerHTML = shell(`
      <div style="padding: 8px 16px 4px; font-size: 13px; opacity: .85;">${dateStr}</div>
      ${stationsHtml}
    `);
  }
}


// ---------- shared render helpers ----------

function shell(inner) {
  return `<ha-card>${inner}</ha-card>`;
}

function eventIcon(kind, rising) {
  // Uses HA's global <ha-icon> element (registered by HA frontend) so we get
  // the same MDI set the rest of the UI uses. Colours match the tide-state
  // semantics: rising water = green up, falling water = orange down.
  const mdi =
    kind === "H" ? "mdi:wave-arrow-up"
    : kind === "L" ? "mdi:wave-arrow-down"
    : rising ? "mdi:trending-up"
    : "mdi:trending-down";
  const color =
    kind === "H" ? "#0e8a5f"
    : kind === "L" ? "#c2410c"
    : rising ? "#0e8a5f"
    : "#c2410c";
  return `<ha-icon icon="${mdi}" style="--mdc-icon-size:18px;color:${color};vertical-align:middle;"></ha-icon>`;
}

function currentDirection(perStationEntry) {
  const st = perStationEntry;
  const t0 = Date.now();
  const dt = 60 * 1000;
  const yBefore = interpolateAt(st.times, st.heights, st.derivs, t0 - dt);
  const yAfter = interpolateAt(st.times, st.heights, st.derivs, t0 + dt);
  if (yBefore == null || yAfter == null) return null;
  return yAfter >= yBefore;
}

function chronologicalTable(station, ctx, unit, hass) {
  // All of today's H/L events plus a "now" pseudo-event slotted into the
  // sequence by timestamp.
  const events = station.dayKnots
    .map((k) => ({ t: k.t, y: k.y, kind: k.type }));
  const now = Date.now();
  if (station.currentY != null && now >= ctx.tMin && now <= ctx.tMax) {
    events.push({
      t: now,
      y: station.currentY,
      kind: "NOW",
      rising: currentDirection(station),
    });
  }
  events.sort((a, b) => a.t - b.t);

  const rows = events.map((e) => {
    const highlight = e.kind === "NOW"
      ? "background: rgba(120, 144, 156, 0.08);"
      : "";
    const timeLabel = e.kind === "NOW"
      ? `<span style="font-weight:600;">now</span>`
      : fmtTimeShort(new Date(e.t), hass);
    return `<tr style="${highlight}">
      <td style="padding:3px 12px 3px 0;font-variant-numeric:tabular-nums;color:var(--secondary-text-color,#666);text-align:left;white-space:nowrap;">${timeLabel}</td>
      <td style="padding:3px 8px;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;">${e.y.toFixed(1)} ${unit}</td>
      <td style="padding:3px 0 3px 4px;text-align:left;line-height:0;">${eventIcon(e.kind, e.rising)}</td>
    </tr>`;
  }).join("");

  return `<table style="font-size:13px;border-collapse:collapse;">
    <tbody>${rows}</tbody>
  </table>`;
}


// ---------- registration ----------

customElements.define(CARD_TAG, TidesPlusCard);
customElements.define(SUMMARY_TAG, TidesPlusSummaryCard);

window.customCards = window.customCards || [];
for (const [tag, name, desc] of [
  [CARD_TAG, "Tides Plus", "Tide curve with hi/lo markers, day/night shading, and NOW indicator."],
  [SUMMARY_TAG, "Tides Plus — Summary", "Tabular high/low tide breakdown for one or more stations."],
]) {
  if (!window.customCards.find((c) => c.type === tag)) {
    window.customCards.push({ type: tag, name, description: desc, preview: false });
  }
}
