/**
 * Tides Plus card — one-day tide chart for one or more NOAA stations.
 *
 * YAML:
 *   type: custom:tides-plus-card
 *   stations:
 *     - 8467150
 *     - 9445882
 *   renderer: native | apex   # optional, default native
 *   sun_entity: sun.sun       # optional, defaults to sun.sun
 *   unit: metric | imperial   # optional, defaults to hass length preference
 *
 * Data path: hi/lo knots come from the noaa_tides_plus/hilo_series WebSocket
 * command (metres, UTC). Interpolation is Fritsch-Carlson PCHIP, matching the
 * Python side, so peaks and troughs render with zero slope regardless of the
 * chosen renderer.
 */

const CARD_TAG = "tides-plus-card";

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
const AREA_OPACITY = 0.18;
const NOW_STROKE = "rgba(198, 40, 40, 0.85)";

const PADDING = { top: 16, right: 20, bottom: 30, left: 44 };
const VIEW = { w: 800, h: 240 };

const APEX_URL = "/noaa_tides_plus/apexcharts.min.js";


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


// ---------- helpers ----------

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

function fmtHour(d, hass) {
  try {
    return d.toLocaleTimeString(hass && hass.locale && hass.locale.language, {
      hour: "numeric",
      hour12: !(hass && hass.locale && hass.locale.time_format === "24"),
    });
  } catch (_) { return d.getHours() + ":00"; }
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

function niceStep(rough) {
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  let mult;
  if (norm < 1.5) mult = 1;
  else if (norm < 3) mult = 2;
  else if (norm < 7) mult = 5;
  else mult = 10;
  return mult * pow;
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


// ---------- element ----------

class TidesPlusCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._series = new Map();
    this._loading = new Set();
    this._loaded = false;
    this._tickTimer = null;
    this._perStation = [];
    this._chartCtx = null;
    this._apexChart = null;
    this._renderer = null;
  }

  connectedCallback() {
    this._tickTimer = window.setInterval(() => this._render(), 60_000);
  }

  disconnectedCallback() {
    if (this._tickTimer) {
      window.clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    this._destroyApex();
  }

  setConfig(config) {
    if (!config || !config.stations || !config.stations.length) {
      throw new Error("`stations:` must list at least one NOAA station ID.");
    }
    this._config = {
      sun_entity: "sun.sun",
      renderer: "native",
      ...config,
      stations: config.stations.map(String),
    };
    this._series = new Map();
    this._loaded = false;
    this._destroyApex();
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

  getCardSize() {
    return 4;
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
        type: "noaa_tides_plus/hilo_series",
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

  _prepare() {
    // Common data prep for both renderers.
    const hass = this._hass;
    const stations = this._config.stations;
    const unit = preferredUnit(hass, this._config.unit);
    const anyLoaded = stations.some(
      (id) => this._series.get(id) && !this._series.get(id).error,
    );
    if (!anyLoaded) return null;

    const midnight = localMidnight();
    const dayEnd = new Date(midnight.getTime() + 86400000);
    const tMin = midnight.getTime();
    const tMax = dayEnd.getTime();

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

      const dayKnots = s.knots
        .map((k, i) => ({
          t: new Date(k.time).getTime(),
          y: heights[i],
          type: k.type,
        }))
        .filter((k) => k.t >= tMin && k.t <= tMax);

      for (const [_t, y] of samples) {
        if (y < heightMin) heightMin = y;
        if (y > heightMax) heightMax = y;
      }
      for (const k of dayKnots) {
        if (k.y < heightMin) heightMin = k.y;
        if (k.y > heightMax) heightMax = k.y;
      }

      perStation.push({
        id, label, color, samples, knots: dayKnots, currentY,
        times, heights, derivs,
      });
    });

    if (!perStation.length) return null;

    if (!isFinite(heightMin)) heightMin = 0;
    if (!isFinite(heightMax)) heightMax = 1;
    if (heightMin === heightMax) heightMax = heightMin + 1;
    const pad = (heightMax - heightMin) * 0.12;
    heightMin -= pad;
    heightMax += pad;

    return {
      hass, unit, perStation, tMin, tMax, heightMin, heightMax,
      sunTimes: daySunTimes(hass, this._config.sun_entity),
      now: Date.now(),
    };
  }

  _render() {
    if (!this._config) return;
    const ctx = this._prepare();
    const rendererChanged = this._renderer !== this._config.renderer;

    if (!ctx) {
      this.shadowRoot.innerHTML = this._shell(
        `<div style="padding:16px;">Loading tide data…</div>`,
      );
      this._renderer = null;
      this._destroyApex();
      return;
    }

    if (rendererChanged && this._config.renderer !== "apex") {
      this._destroyApex();
    }

    this._renderer = this._config.renderer;
    this._perStation = ctx.perStation;
    this._chartCtx = null;

    if (this._config.renderer === "apex") {
      this._renderApex(ctx);
    } else {
      this._renderNative(ctx);
    }
  }

  _shell(inner) { return `<ha-card>${inner}</ha-card>`; }

  _headerHtml(ctx) {
    const dateStr = new Date().toLocaleDateString(
      ctx.hass && ctx.hass.locale && ctx.hass.locale.language,
      { weekday: "long", month: "long", day: "numeric" },
    );
    const rendererBadge = this._config.renderer === "apex" ? "ApexCharts" : "native SVG";
    return `<div style="padding: 8px 16px 4px; font-size: 13px; opacity: .85; display:flex; justify-content:space-between; align-items:center;">
      <span>${dateStr}</span>
      <span style="font-size:11px; opacity:.6;">${rendererBadge}</span>
    </div>`;
  }

  _legendHtml(ctx) {
    const legend = ctx.perStation
      .map((s) =>
        `<span style="display:inline-flex;align-items:center;margin-right:12px;">
           <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${s.color};margin-right:6px;"></span>
           ${s.label}${s.currentY != null ? " · " + s.currentY.toFixed(2) + " " + unitLabel(ctx.unit) : ""}
         </span>`,
      )
      .join("");
    return `<div style="padding: 4px 16px 12px; font-size: 12px;">${legend}</div>`;
  }


  // ---------- Native renderer ----------

  _renderNative(ctx) {
    const svg = this._buildSvg(ctx);
    this.shadowRoot.innerHTML = this._shell(`
      ${this._headerHtml(ctx)}
      <div style="padding: 0 8px; position: relative;" id="tides-chart-wrap">
        ${svg}
        <div id="tides-tooltip" style="
          position: absolute; pointer-events: none; display: none;
          background: var(--card-background-color, #fff);
          border: 1px solid rgba(0,0,0,0.15); border-radius: 6px;
          padding: 6px 8px; font-size: 12px; line-height: 1.35;
          box-shadow: 0 2px 6px rgba(0,0,0,0.12);
          white-space: nowrap; z-index: 2;
        "></div>
      </div>
      ${this._legendHtml(ctx)}
    `);
    this._attachInteractivity();
  }

  _buildSvg(ctx) {
    const { hass, unit, perStation, tMin, tMax, heightMin, heightMax, sunTimes, now } = ctx;
    const W = VIEW.w;
    const H = VIEW.h;
    const chartW = W - PADDING.left - PADDING.right;
    const chartH = H - PADDING.top - PADDING.bottom;
    const x0 = PADDING.left;
    const y0 = PADDING.top;

    this._chartCtx = { tMin, tMax, x0, y0, chartW, chartH, heightMin, heightMax, unit };

    const xOf = (t) => x0 + ((t - tMin) / (tMax - tMin)) * chartW;
    const yOf = (h) => y0 + (1 - (h - heightMin) / (heightMax - heightMin)) * chartH;

    let nightRects = "";
    if (sunTimes.sunrise) {
      const sx = xOf(sunTimes.sunrise.getTime());
      nightRects += `<rect x="${x0}" y="${y0}" width="${Math.max(0, sx - x0)}" height="${chartH}" fill="${NIGHT_FILL}" />`;
    }
    if (sunTimes.sunset) {
      const sx = xOf(sunTimes.sunset.getTime());
      nightRects += `<rect x="${sx}" y="${y0}" width="${Math.max(0, x0 + chartW - sx)}" height="${chartH}" fill="${NIGHT_FILL}" />`;
    }

    let grid = "";
    for (let hour = 0; hour <= 24; hour += 1) {
      const t = tMin + hour * 3600 * 1000;
      const x = xOf(t);
      const strong = hour % 3 === 0;
      grid += `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y0 + chartH}" stroke="rgba(0,0,0,${strong ? 0.15 : 0.06})" stroke-width="1" />`;
      if (strong && hour !== 24) {
        const label = fmtHour(new Date(tMin + hour * 3600 * 1000), hass);
        grid += `<text x="${x}" y="${y0 + chartH + 16}" font-size="11" text-anchor="middle" fill="var(--secondary-text-color, #666)">${label}</text>`;
      }
    }

    let yTicks = "";
    const step = niceStep((heightMax - heightMin) / 4);
    const first = Math.ceil(heightMin / step) * step;
    for (let h = first; h <= heightMax; h += step) {
      const y = yOf(h);
      yTicks += `<line x1="${x0}" y1="${y}" x2="${x0 + chartW}" y2="${y}" stroke="rgba(0,0,0,0.06)" stroke-width="1" />`;
      yTicks += `<text x="${x0 - 6}" y="${y + 3}" font-size="11" text-anchor="end" fill="var(--secondary-text-color, #666)">${h.toFixed(step < 1 ? 1 : 0)} ${unitLabel(unit)}</text>`;
    }

    let stationsSvg = "";
    for (const st of perStation) {
      if (!st.samples.length) continue;
      const pathD =
        "M " +
        st.samples.map(([t, y]) => `${xOf(t).toFixed(2)} ${yOf(y).toFixed(2)}`).join(" L ");
      const areaD =
        pathD +
        ` L ${xOf(st.samples[st.samples.length - 1][0]).toFixed(2)} ${(y0 + chartH).toFixed(2)}` +
        ` L ${xOf(st.samples[0][0]).toFixed(2)} ${(y0 + chartH).toFixed(2)} Z`;
      stationsSvg += `<path d="${areaD}" fill="${st.color}" fill-opacity="${AREA_OPACITY}" />`;
      stationsSvg += `<path d="${pathD}" fill="none" stroke="${st.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />`;
      for (const k of st.knots) {
        stationsSvg += `<circle cx="${xOf(k.t).toFixed(2)}" cy="${yOf(k.y).toFixed(2)}" r="3.5" fill="${st.color}" />`;
      }
      if (st.currentY != null) {
        const cx = xOf(now);
        const cy = yOf(st.currentY);
        stationsSvg += `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="4.5" fill="#fff" stroke="${st.color}" stroke-width="2" />`;
      }
    }

    let nowMark = "";
    if (now >= tMin && now <= tMax) {
      const nx = xOf(now);
      nowMark += `<line x1="${nx}" y1="${y0}" x2="${nx}" y2="${y0 + chartH}" stroke="${NOW_STROKE}" stroke-width="1.5" />`;
      nowMark += `<text x="${nx + 4}" y="${y0 + 12}" font-size="10" fill="${NOW_STROKE}" font-weight="600">NOW</text>`;
    }

    let cursorLayer = `<g id="tides-cursor" style="display:none; pointer-events:none;">`;
    cursorLayer += `<line id="tides-crosshair" x1="0" y1="${y0}" x2="0" y2="${y0 + chartH}" stroke="rgba(0,0,0,0.35)" stroke-width="1" stroke-dasharray="3 3" />`;
    for (const st of perStation) {
      cursorLayer += `<circle data-station="${st.id}" r="4.5" fill="${st.color}" stroke="#fff" stroke-width="1.5" cx="0" cy="0" />`;
    }
    cursorLayer += `</g>`;
    const hit = `<rect id="tides-hit" x="${x0}" y="${y0}" width="${chartW}" height="${chartH}" fill="transparent" style="cursor: crosshair;" />`;

    return `
      <svg id="tides-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" width="100%" height="240" role="img" aria-label="Tide chart">
        <rect x="${x0}" y="${y0}" width="${chartW}" height="${chartH}" fill="var(--card-background-color, #fff)" />
        ${nightRects}
        ${yTicks}
        ${grid}
        ${stationsSvg}
        ${nowMark}
        ${cursorLayer}
        ${hit}
        <rect x="${x0}" y="${y0}" width="${chartW}" height="${chartH}" fill="none" stroke="rgba(0,0,0,0.15)" stroke-width="1" pointer-events="none" />
      </svg>`;
  }

  _attachInteractivity() {
    const svg = this.shadowRoot.getElementById("tides-svg");
    const hit = this.shadowRoot.getElementById("tides-hit");
    if (!svg || !hit) return;
    hit.addEventListener("pointermove", (e) => this._updateCursor(e));
    hit.addEventListener("pointerleave", () => this._hideCursor());
  }

  _updateCursor(evt) {
    const ctx = this._chartCtx;
    if (!ctx) return;
    const svg = this.shadowRoot.getElementById("tides-svg");
    const cursor = this.shadowRoot.getElementById("tides-cursor");
    const crosshair = this.shadowRoot.getElementById("tides-crosshair");
    const tooltip = this.shadowRoot.getElementById("tides-tooltip");
    const wrap = this.shadowRoot.getElementById("tides-chart-wrap");
    if (!svg || !cursor || !crosshair || !tooltip || !wrap) return;

    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());
    const xSvg = Math.max(ctx.x0, Math.min(ctx.x0 + ctx.chartW, svgP.x));

    const t = ctx.tMin + ((xSvg - ctx.x0) / ctx.chartW) * (ctx.tMax - ctx.tMin);
    crosshair.setAttribute("x1", xSvg);
    crosshair.setAttribute("x2", xSvg);

    const dots = cursor.querySelectorAll("circle[data-station]");
    const lines = [`<div><strong>${fmtTimeShort(new Date(t), this._hass)}</strong></div>`];
    for (const dot of dots) {
      const stationId = dot.getAttribute("data-station");
      const st = this._perStation.find((s) => s.id === stationId);
      if (!st) { dot.setAttribute("cx", "-100"); continue; }
      const y = interpolateAt(st.times, st.heights, st.derivs, t);
      if (y == null) { dot.setAttribute("cx", "-100"); continue; }
      const ySvg = ctx.y0 + (1 - (y - ctx.heightMin) / (ctx.heightMax - ctx.heightMin)) * ctx.chartH;
      dot.setAttribute("cx", xSvg);
      dot.setAttribute("cy", ySvg);
      lines.push(
        `<div style="display:flex;align-items:center;gap:6px;">
           <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${st.color};"></span>
           <span>${st.label}: ${y.toFixed(2)} ${unitLabel(ctx.unit)}</span>
         </div>`,
      );
    }
    cursor.style.display = "";
    tooltip.innerHTML = lines.join("");
    tooltip.style.display = "";

    const wrapRect = wrap.getBoundingClientRect();
    const cssX = evt.clientX - wrapRect.left;
    tooltip.style.left = cssX + "px";
    tooltip.style.top = "8px";
    tooltip.style.transform = "translate(-50%, 0)";
  }

  _hideCursor() {
    const cursor = this.shadowRoot.getElementById("tides-cursor");
    const tooltip = this.shadowRoot.getElementById("tides-tooltip");
    if (cursor) cursor.style.display = "none";
    if (tooltip) tooltip.style.display = "none";
  }


  // ---------- ApexCharts renderer ----------

  async _renderApex(ctx) {
    // Build shell once so the chart's <div> stays stable across re-renders.
    if (!this.shadowRoot.getElementById("tides-apex-wrap")) {
      this.shadowRoot.innerHTML = this._shell(`
        ${this._headerHtml(ctx)}
        <div id="tides-apex-wrap" style="padding: 0 8px;">
          <div id="tides-apex-chart"></div>
        </div>
        <div id="tides-apex-legend"></div>
      `);
    } else {
      const header = this.shadowRoot.querySelector("ha-card > div");
      if (header) header.outerHTML = this._headerHtml(ctx);
    }
    const legendEl = this.shadowRoot.getElementById("tides-apex-legend");
    if (legendEl) legendEl.outerHTML =
      `<div id="tides-apex-legend">${this._legendHtml(ctx).replace(/^<div[^>]*>|<\/div>$/g, "")}</div>`;

    try {
      await ensureApexLoaded();
    } catch (err) {
      this.shadowRoot.innerHTML = this._shell(
        `<div style="padding:16px;">Failed to load ApexCharts: ${err.message}</div>`,
      );
      return;
    }

    const options = this._buildApexOptions(ctx);
    const el = this.shadowRoot.getElementById("tides-apex-chart");
    if (!el) return;

    if (this._apexChart) {
      try {
        this._apexChart.updateOptions(options, true, true);
        return;
      } catch (_) {
        this._destroyApex();
      }
    }
    this._apexChart = new window.ApexCharts(el, options);
    this._apexChart.render();
  }

  _destroyApex() {
    if (this._apexChart) {
      try { this._apexChart.destroy(); } catch (_) {}
      this._apexChart = null;
    }
  }

  _buildApexOptions(ctx) {
    const { unit, perStation, tMin, tMax, heightMin, heightMax, sunTimes, now, hass } = ctx;

    const series = perStation.map((st) => ({
      name: st.label,
      color: st.color,
      data: st.samples.map(([t, y]) => ({ x: t, y })),
    }));

    // Highlight the actual NOAA knots as bigger discrete markers.
    const discreteMarkers = [];
    perStation.forEach((st, seriesIndex) => {
      for (const k of st.knots) {
        // Find the sample index closest to this knot time.
        let idx = 0;
        let bestDelta = Infinity;
        for (let i = 0; i < st.samples.length; i++) {
          const d = Math.abs(st.samples[i][0] - k.t);
          if (d < bestDelta) { bestDelta = d; idx = i; } else if (st.samples[i][0] > k.t) break;
        }
        discreteMarkers.push({
          seriesIndex,
          dataPointIndex: idx,
          fillColor: st.color,
          strokeColor: "#fff",
          size: 5,
        });
      }
    });

    const xAnnotations = [];
    if (sunTimes.sunrise) {
      xAnnotations.push({
        x: tMin, x2: sunTimes.sunrise.getTime(),
        fillColor: NIGHT_FILL, opacity: 1, borderColor: "transparent",
      });
    }
    if (sunTimes.sunset) {
      xAnnotations.push({
        x: sunTimes.sunset.getTime(), x2: tMax,
        fillColor: NIGHT_FILL, opacity: 1, borderColor: "transparent",
      });
    }
    if (now >= tMin && now <= tMax) {
      xAnnotations.push({
        x: now,
        strokeDashArray: 0,
        borderColor: NOW_STROKE,
        label: {
          text: "NOW",
          orientation: "horizontal",
          borderColor: NOW_STROKE,
          style: {
            color: "#fff",
            background: NOW_STROKE,
            fontSize: "10px",
            fontWeight: 600,
          },
        },
      });
    }

    return {
      chart: {
        type: "area",
        height: 240,
        toolbar: { show: false },
        zoom: { enabled: true, type: "x" },
        animations: { enabled: false },
        fontFamily: "var(--primary-font-family, sans-serif)",
        background: "transparent",
      },
      theme: { mode: "light" },
      series,
      dataLabels: { enabled: false },
      stroke: { curve: "straight", width: 2 },
      fill: {
        type: "gradient",
        gradient: { opacityFrom: 0.35, opacityTo: 0.05, stops: [0, 100] },
      },
      markers: { size: 0, discrete: discreteMarkers, hover: { size: 6 } },
      xaxis: {
        type: "datetime",
        min: tMin, max: tMax,
        labels: {
          datetimeUTC: false,
          format: (hass && hass.locale && hass.locale.time_format === "24") ? "H:mm" : "h TT",
        },
        tooltip: { enabled: false },
        axisTicks: { show: true },
      },
      yaxis: {
        min: heightMin, max: heightMax,
        title: { text: unitLabel(unit) },
        labels: {
          formatter: (v) => `${v.toFixed(1)}`,
        },
      },
      tooltip: {
        shared: true,
        x: { format: "h:mm TT" },
        y: {
          formatter: (v) => (v == null ? "-" : `${v.toFixed(2)} ${unitLabel(unit)}`),
        },
      },
      grid: { borderColor: "rgba(0,0,0,0.08)" },
      legend: { show: false },
      annotations: { xaxis: xAnnotations },
    };
  }
}


customElements.define(CARD_TAG, TidesPlusCard);

window.customCards = window.customCards || [];
if (!window.customCards.find((c) => c.type === CARD_TAG)) {
  window.customCards.push({
    type: CARD_TAG,
    name: "Tides Plus",
    description: "Tide curve with hi/lo markers, day/night shading, and NOW indicator. Renderer: native or apex.",
    preview: false,
  });
}
