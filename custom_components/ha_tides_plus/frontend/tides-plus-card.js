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
const DATA_REFRESH_INTERVAL = 30 * 60 * 1000;

const STATION_COLORS = [
  "#1976d2",
  "#e65100",
  "#2e7d32",
  "#6a1b9a",
  "#00838f",
  "#c62828",
];

const NOW_STROKE = "rgba(198, 40, 40, 0.85)";
const SERIES_DASH_PATTERNS = [0, 6, 2, 8, 4, 10];
const VISUALLY_HIDDEN_STYLE =
  "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;" +
  "clip:rect(0,0,0,0);white-space:nowrap;border:0;";


const ASSET_VERSION = new URL(import.meta.url).searchParams.get("v");
const APEX_URL = new URL("/ha_tides_plus/apexcharts.min.js", window.location.origin);
if (ASSET_VERSION) APEX_URL.searchParams.set("v", ASSET_VERSION);

const NAV_BTN_STYLE =
  "background:transparent;border:1px solid var(--divider-color,rgba(0,0,0,0.12));" +
  "color:var(--primary-text-color,inherit);border-radius:8px;padding:0 12px;" +
  "cursor:pointer;font-size:13px;line-height:1;min-width:44px;min-height:44px;";
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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function darkenHex(hex, amount) {
  const m = String(hex || "").replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return hex;
  const parts = [m[1], m[2], m[3]].map((h) =>
    Math.max(0, Math.round(parseInt(h, 16) * (1 - amount))),
  );
  return "#" + parts.map((v) => v.toString(16).padStart(2, "0")).join("");
}

function lightenHex(hex, amount) {
  const match = String(hex || "").replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return hex;
  const parts = [match[1], match[2], match[3]].map((part) => {
    const value = parseInt(part, 16);
    return Math.min(255, Math.round(value + (255 - value) * amount));
  });
  return "#" + parts.map((value) => value.toString(16).padStart(2, "0")).join("");
}

function themeValue(element, name, fallback) {
  const value = window.getComputedStyle(element).getPropertyValue(name).trim();
  return value || fallback;
}

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
    s.src = APEX_URL.href;
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
    this._errors = new Map();
    this._isLoading = false;
    this._lastRefresh = 0;
    this._loadGeneration = 0;
    this._hassRenderSignature = null;
    this._tickTimer = null;
    this._retryTimer = null;
    this._retryCount = 0;
    this._windowOffset = 0;   // ms shift from the "current" anchor
    this._keyboardCursorTime = null;
  }

  _baseDefaults() {
    return {
      sun_entity: "sun.sun",
      anchor: "day",
      hours_before: 0,
      hours_after: 24,
      buttons: "forward-backward",
    };
  }

  _stepMs() {
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
    if (direction === 0) this._windowOffset = 0;
    else this._windowOffset += direction * this._stepMs();
    this._onShift();
    this._render();
  }

  // Subclasses can override to tear down mid-render state before a shift.
  _onShift() {}

  _navHeader(ctx) {
    const label = this._windowLabel(ctx);
    const cfg = this._config;
    const showNav = cfg.buttons !== "none";
    const resetLabel = cfg.anchor === "now" ? "Now" : "Today";
    const atRest = this._windowOffset === 0;
    const stepLabel = cfg.anchor === "day" ? "day" : "window";
    const nav = showNav
      ? `<span style="display:inline-flex;align-items:center;gap:4px;margin-left:auto;">
           <button class="tp-nav" data-nav="reset" title="Back to ${resetLabel.toLowerCase()}"
                   aria-label="Back to ${resetLabel.toLowerCase()}"
                   ${atRest ? "disabled" : ""}
                   style="${NAV_BTN_STYLE}${atRest ? NAV_BTN_DISABLED : ""}">${resetLabel}</button>
           <button class="tp-nav" data-nav="prev" title="Previous ${stepLabel}"
                   aria-label="Previous ${stepLabel}"
                   style="${NAV_BTN_STYLE}">‹</button>
           <button class="tp-nav" data-nav="next" title="Next ${stepLabel}"
                   aria-label="Next ${stepLabel}"
                   style="${NAV_BTN_STYLE}">›</button>
         </span>`
      : "";
    return `<div class="tp-header" style="padding:8px 12px 4px 16px;font-size:13px;opacity:.9;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;">
      <span>${escapeHtml(label)}</span>
      ${nav}
    </div>`;
  }

  _windowLabel(ctx) {
    const hass = this._hass;
    const startD = new Date(ctx.tMin);
    const endD = new Date(ctx.tMax);
    const spanMs = ctx.tMax - ctx.tMin;
    const startIsMidnight = startD.getHours() === 0 && startD.getMinutes() === 0;
    if (startIsMidnight && Math.abs(spanMs % 86400000) < 1000) {
      const days = Math.round(spanMs / 86400000);
      if (days === 1) {
        return startD.toLocaleDateString(
          hass && hass.locale && hass.locale.language,
          { weekday: "long", month: "long", day: "numeric" },
        );
      }
      const endDisplay = new Date(ctx.tMax - 86400000);
      const fmt = { month: "short", day: "numeric" };
      return `${startD.toLocaleDateString(hass && hass.locale && hass.locale.language, fmt)} → ${endDisplay.toLocaleDateString(hass && hass.locale && hass.locale.language, fmt)}`;
    }
    const fmt = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
    return `${startD.toLocaleString(hass && hass.locale && hass.locale.language, fmt)} → ${endD.toLocaleString(hass && hass.locale && hass.locale.language, fmt)}`;
  }

  _attachNavHandlers() {
    // No-op: nav clicks are delegated on the shadowRoot in connectedCallback.
    // Kept as a stub so subclasses that call it after a re-render don't need
    // to change.
  }

  connectedCallback() {
    if (!this._tickTimer) {
      this._tickTimer = window.setInterval(() => {
        if (
          this._config?.stations?.length &&
          Date.now() - this._lastRefresh >= DATA_REFRESH_INTERVAL
        ) {
          this._loadAll();
        } else {
          this._render();
        }
      }, 60_000);
    }
    // Event delegation for nav buttons: attached to shadowRoot once so
    // re-renders can't stack duplicate handlers on the same DOM node.
    if (!this._navBound) {
      this._navBound = true;
      this.shadowRoot.addEventListener("click", (e) => {
        const btn = e.composedPath().find(
          (n) => n.nodeType === 1 && n.classList && n.classList.contains("tp-nav"),
        );
        if (!btn || btn.disabled) return;
        if (btn.dataset.action === "retry") {
          if (this._retryTimer) {
            window.clearTimeout(this._retryTimer);
            this._retryTimer = null;
          }
          this._retryCount = 0;
          this._loadAll();
          return;
        }
        const nav = btn.dataset.nav;
        if (nav === "prev") this._shift(-1);
        else if (nav === "next") this._shift(1);
        else if (nav === "reset") this._shift(0);
      });
      this.shadowRoot.addEventListener("keydown", (e) => {
        const chart = e.composedPath().find(
          (node) => node.nodeType === 1 && node.classList?.contains("tp-chart-interactive"),
        );
        if (!chart || !this._chartCtx) return;
        if (!["ArrowLeft", "ArrowRight", "Home", "Escape"].includes(e.key)) return;
        e.preventDefault();
        if (e.key === "Escape") {
          this._keyboardCursorTime = null;
          this._updateLegend(null);
          return;
        }
        const { tMin, tMax } = this._chartCtx;
        if (e.key === "Home") {
          this._keyboardCursorTime = Math.min(tMax, Math.max(tMin, Date.now()));
        } else {
          const step = (tMax - tMin) / 48;
          const start = this._keyboardCursorTime
            ?? Math.min(tMax, Math.max(tMin, Date.now()));
          this._keyboardCursorTime = Math.min(
            tMax,
            Math.max(tMin, start + (e.key === "ArrowLeft" ? -step : step)),
          );
        }
        this._updateLegend(this._keyboardCursorTime);
      });
    }
  }

  disconnectedCallback() {
    if (this._tickTimer) {
      window.clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    if (this._retryTimer) {
      window.clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
  }

  setConfig(config) {
    if (!config || !Array.isArray(config.stations)) {
      throw new Error("`stations:` is required.");
    }
    this._config = this._defaultConfig(config);
    this._series = new Map();
    this._errors = new Map();
    this._isLoading = false;
    this._lastRefresh = 0;
    this._retryCount = 0;
    this._loadGeneration += 1;
    this._render();
    if (this._hass && this._config.stations.length) this._loadAll();
  }

  set hass(hass) {
    const sunEntityId = this._config?.sun_entity || "sun.sun";
    const sun = hass?.states?.[sunEntityId];
    const renderSignature = JSON.stringify([
      hass?.config?.unit_system?.length,
      hass?.locale?.language,
      hass?.locale?.time_format,
      hass?.themes?.theme,
      hass?.themes?.darkMode,
      sun?.state,
      sun?.attributes?.next_rising,
      sun?.attributes?.next_setting,
    ]);
    const shouldRender = renderSignature !== this._hassRenderSignature;
    this._hass = hass;
    this._hassRenderSignature = renderSignature;
    if (
      this._config?.stations?.length &&
      !this._isLoading &&
      this._lastRefresh === 0
    ) {
      this._loadAll();
    }
    if (shouldRender) this._render();
  }

  async _loadAll() {
    if (!this._hass || !this._config?.stations?.length || this._isLoading) return;
    const generation = this._loadGeneration;
    this._isLoading = true;
    this._render();
    const results = await Promise.all(
      this._config.stations.map((id) => this._loadOne(id)),
    );
    if (generation !== this._loadGeneration) return;
    for (const result of results) {
      if (result.error) {
        this._errors.set(result.id, result.error);
      } else {
        this._series.set(result.id, result.data);
        this._errors.delete(result.id);
      }
    }
    this._lastRefresh = Date.now();
    this._isLoading = false;
    this._render();
    if (this._errors.size && this._retryCount < 3 && !this._retryTimer) {
      this._retryCount += 1;
      this._retryTimer = window.setTimeout(() => {
        this._retryTimer = null;
        this._loadAll();
      }, this._retryCount * 5_000);
    } else if (!this._errors.size) {
      this._retryCount = 0;
    }
  }

  async _loadOne(id) {
    try {
      const res = await this._hass.callWS({
        type: "ha_tides_plus/hilo_series",
        station_id: id,
      });
      return { id, data: res };
    } catch (err) {
      return { id, error: (err && err.message) || String(err) };
    }
  }

  _dataStateHtml() {
    const stations = this._config?.stations || [];
    if (!stations.length) {
      return shell(`
        <div style="padding:20px 16px;">
          <strong>No stations selected</strong>
          <div style="margin-top:4px;color:var(--secondary-text-color);">
            Edit this card and select at least one tide station.
          </div>
        </div>`);
    }
    const hasData = stations.some((id) => this._series.has(id));
    if (hasData) return null;
    if (this._isLoading || stations.some((id) => !this._errors.has(id))) {
      return shell(`<div style="padding:16px;">Loading tide data…</div>`);
    }
    return shell(`
      <div style="padding:20px 16px;" role="alert">
        <strong>Could not load tide data</strong>
        <div style="margin-top:4px;color:var(--secondary-text-color);">
          Check the integration connection, then try again.
        </div>
        <div style="margin-top:4px;font-size:12px;color:var(--secondary-text-color);">
          ${stations.map((id) => `${escapeHtml(id)}: ${escapeHtml(this._errors.get(id))}`).join("<br>")}
        </div>
        <button class="tp-nav" data-action="retry" style="margin-top:12px;${NAV_BTN_STYLE}">
          Try again
        </button>
      </div>`);
  }

  _dataWarningHtml() {
    if (!this._errors.size) return "";
    const failed = Array.from(this._errors.keys()).map(escapeHtml).join(", ");
    return `<div role="status" style="padding:8px 16px;background:var(--warning-color,#f57c00);color:var(--text-primary-color,#fff);font-size:12px;">
      Could not refresh ${failed}. Showing available data.
      <button class="tp-nav" data-action="retry" style="margin-left:8px;${NAV_BTN_STYLE}color:inherit;border-color:currentColor;min-height:32px;">Try again</button>
    </div>`;
  }

  _prepare() {
    const hass = this._hass;
    const stations = this._config.stations;
    const unit = preferredUnit(hass, this._config.unit);
    const anyLoaded = stations.some((id) => this._series.has(id));
    if (!anyLoaded) return null;

    const { tMin, tMax } = this._computeWindow();

    const perStation = [];
    let heightMin = Infinity;
    let heightMax = -Infinity;

    stations.forEach((id, idx) => {
      const s = this._series.get(id);
      if (!s || !s.knots || !s.knots.length) return;
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
      failedStations: stations.filter((id) => this._errors.has(id)),
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
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._destroyApex();
  }

  _defaultConfig(config) {
    return {
      ...this._baseDefaults(),
      ...config,
      stations: config.stations.map(String),
    };
  }

  setConfig(config) {
    this._destroyApex();
    this._windowOffset = 0;
    super.setConfig(config);
  }

  static getConfigElement() {
    return document.createElement("tides-plus-card-editor");
  }

  static async getStubConfig(hass) {
    try {
      const res = await hass.callWS({ type: "ha_tides_plus/list_stations" });
      if (res.stations && res.stations.length) {
        return { stations: [res.stations[0].station_id] };
      }
    } catch (_) {}
    return { stations: [] };
  }

  getCardSize() { return 7; }

  getGridOptions() {
    return {
      columns: "full",
      rows: "auto",
      min_columns: 6,
      min_rows: 3,
    };
  }

  getLayoutOptions() {
    return {
      grid_columns: "full",
      grid_rows: "auto",
      grid_min_columns: 2,
      grid_min_rows: 3,
    };
  }

  _onShift() {
    // Force full rebuild so the apex axis + annotations refresh.
    this._destroyApex();
  }

  _render() {
    if (!this._config) return;
    const stateHtml = this._dataStateHtml();
    if (stateHtml) {
      this.shadowRoot.innerHTML = stateHtml;
      this._renderer = null;
      this._destroyApex();
      return;
    }
    const ctx = this._prepare();
    if (!ctx) {
      this.shadowRoot.innerHTML = shell(`<div style="padding:16px;">No tide predictions are available.</div>`);
      this._renderer = null;
      this._destroyApex();
      return;
    }

    if (!ctx.hasSamplesInWindow) {
      const canReset = this._windowOffset !== 0;
      this.shadowRoot.innerHTML = shell(`
        ${this._dataWarningHtml()}
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

  _legendHtml(ctx) {
    const blocks = ctx.perStation
      .map(
        (s, index) => `
        <div class="station" data-station-index="${index}"
             style="padding:6px 16px;font-size:13px;line-height:1.5;">
          <div style="display:flex;align-items:center;margin-bottom:2px;">
            <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${s.color};margin-right:8px;flex:none;"></span>
            <strong>${escapeHtml(s.label)}</strong>
          </div>
          <div class="current" style="opacity:.9;margin-left:18px;font-size:12px;"></div>
        </div>`,
      )
      .join("");
    return `<div id="tides-legend" aria-live="polite" style="padding:2px 0 8px;">${blocks}</div>`;
  }

  _chartSummaryHtml(ctx) {
    const unit = unitLabel(ctx.unit);
    const stations = ctx.perStation.map((station) => {
      const events = station.dayKnots.map((knot) => {
        const kind = knot.type === "H" ? "high" : "low";
        const time = fmtTimeShort(new Date(knot.t), ctx.hass);
        return `${kind} ${knot.y.toFixed(1)} ${unit} at ${time}`;
      });
      return `${station.label}: ${events.join(", ") || "no tide events in this range"}.`;
    });
    return `<div id="tides-chart-summary" style="${VISUALLY_HIDDEN_STYLE}">
      ${escapeHtml(stations.join(" "))}
    </div>`;
  }

  _updateLegend(cursorTime) {
    const root = this.shadowRoot.getElementById("tides-legend");
    if (!root) return;
    const u = unitLabel((this._chartCtx || {}).unit || preferredUnit(this._hass, this._config.unit));
    const at = cursorTime != null ? cursorTime : Date.now();
    const hovering = cursorTime != null;
    for (const [index, st] of this._perStation.entries()) {
      const el = root.querySelector(`.station[data-station-index="${index}"] .current`);
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
          ? `<strong style="font-variant-numeric:tabular-nums;">${k.y.toFixed(1)} ${u}</strong>
             <span style="opacity:.7;margin-left:4px;">${fmtTimeShort(new Date(k.t), this._hass)}</span>
             ${eventIcon(k.type, null)}`
          : `<span style="opacity:.4;">—</span>`;
      el.innerHTML = `
        <strong style="font-variant-numeric:tabular-nums;">${y.toFixed(1)} ${u}</strong>
        <span style="opacity:.75;margin-left:4px;">${timeStamp}</span>
        <span style="margin-left:14px;opacity:.6;">prev</span> ${knotLabel(prev)}
        <span style="margin-left:14px;opacity:.6;">next</span> ${knotLabel(next)}`;
    }
  }

  // Apex renderer ---------------------------------------------------------

  async _renderApex(ctx) {
    if (!this.shadowRoot.getElementById("tides-apex-wrap")) {
      this.shadowRoot.innerHTML = shell(`
        <div id="tides-warning-slot">${this._dataWarningHtml()}</div>
        ${this._navHeader(ctx)}
        <div id="tides-apex-wrap" class="tp-chart-interactive" tabindex="0"
             role="img" aria-describedby="tides-chart-summary"
             aria-label="Tide chart. Use the left and right arrow keys to inspect the timeline."
             style="padding:0 8px;outline-offset:2px;">
          <div id="tides-apex-chart"></div>
        </div>
        <div id="tides-chart-summary-slot">${this._chartSummaryHtml(ctx)}</div>
        <div id="tides-apex-legend-slot"></div>
      `);
    }
    // Refresh header + legend on every render (they may have new data).
    const warningSlot = this.shadowRoot.getElementById("tides-warning-slot");
    if (warningSlot) warningSlot.innerHTML = this._dataWarningHtml();
    const summarySlot = this.shadowRoot.getElementById("tides-chart-summary-slot");
    if (summarySlot) summarySlot.innerHTML = this._chartSummaryHtml(ctx);
    const headerEl = this.shadowRoot.querySelector(".tp-header");
    if (headerEl) headerEl.outerHTML = this._navHeader(ctx, "ApexCharts");
    const slot = this.shadowRoot.getElementById("tides-apex-legend-slot");
    if (slot) slot.outerHTML = `<div id="tides-apex-legend-slot">${this._legendHtml(ctx)}</div>`;

    try {
      await ensureApexLoaded();
    } catch (err) {
      this.shadowRoot.innerHTML = shell(
        `<div style="padding:16px;" role="alert">Failed to load ApexCharts: ${escapeHtml(err.message)}</div>`,
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
    const chartWidth = this.shadowRoot.getElementById("tides-apex-wrap")
      ?.getBoundingClientRect().width || this.getBoundingClientRect().width || 600;
    const darkMode = Boolean(
      hass?.themes?.darkMode || window.matchMedia?.("(prefers-color-scheme: dark)").matches,
    );
    const primaryTextColor = themeValue(
      this,
      "--primary-text-color",
      darkMode ? "#e1e1e1" : "#212121",
    );
    const secondaryTextColor = themeValue(
      this,
      "--secondary-text-color",
      darkMode ? "#a3a3a3" : "#616161",
    );
    const dividerColor = themeValue(
      this,
      "--divider-color",
      darkMode ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.12)",
    );
    const cardBackground = themeValue(
      this,
      "--ha-card-background",
      themeValue(this, "--card-background-color", darkMode ? "#1c1c1c" : "#ffffff"),
    );

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
          fillColor: st.color, strokeColor: cardBackground, size: 5,
        });
      }
    });

    // Permanent labels next to each hi/lo knot: time + height. Positioned
    // above H's and below L's so they don't cross the curve.
    const pointAnnotations = [];
    const spanHours = (tMax - tMin) / 3600000;
    const dayBoundaries = [];
    if (spanHours > 24) {
      let boundary = localMidnight(new Date(tMin));
      if (boundary.getTime() < tMin) {
        boundary = new Date(boundary.getTime() + 86400000);
      }
      while (boundary.getTime() <= tMax) {
        dayBoundaries.push(boundary.getTime());
        boundary = new Date(boundary.getTime() + 86400000);
      }
    }
    const labelBudget = chartWidth < 480
      ? 0
      : Math.max(2, Math.floor((chartWidth - 60) / 110));
    const labelsPerStation = labelBudget
      ? Math.max(1, Math.floor(labelBudget / perStation.length))
      : 0;
    const nowGap = (tMax - tMin) * 90 / Math.max(chartWidth, 1);
    perStation.forEach((st, seriesIndex) => {
      if (!labelsPerStation) return;
      const candidates = st.dayKnots.filter(
        (k) =>
          k.type !== "H" || (
            (now < tMin || now > tMax || Math.abs(k.t - now) > nowGap) &&
            !dayBoundaries.some((boundary) => Math.abs(k.t - boundary) <= nowGap)
          ),
      );
      const stride = labelsPerStation
        ? Math.max(1, Math.ceil(candidates.length / labelsPerStation))
        : Infinity;
      for (const [index, k] of candidates.entries()) {
        if (index % stride !== 0) continue;
        const position = (k.t - tMin) / (tMax - tMin);
        pointAnnotations.push({
          x: k.t,
          y: k.y,
          seriesIndex,
          marker: { size: 0, fillColor: "transparent", strokeColor: "transparent" },
          label: {
            text: `${k.y.toFixed(1)} ${unitLabel(unit)} · ${fmtTimeShort(new Date(k.t), hass)}`,
            offsetX: position < 0.08 ? 38 : position > 0.92 ? -38 : 0,
            offsetY: k.type === "H" ? -8 : 22,
            borderWidth: 0,
            borderColor: "transparent",
            style: {
              background: "transparent",
              color: darkMode ? lightenHex(st.color, 0.35) : darkenHex(st.color, 0.4),
              fontSize: "10px",
              fontWeight: 700,
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
        fillColor: darkMode ? "rgba(96,125,139,0.28)" : "rgba(120,144,156,0.18)",
        opacity: 1,
        borderColor: "transparent",
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
    if (spanHours > 24) {
      const dayFmt = { weekday: "short", day: "numeric" };
      for (const boundary of dayBoundaries) {
        const d = new Date(boundary);
        const annotation = {
          x: boundary,
          strokeDashArray: 4,
          borderColor: dividerColor,
        };
        if (chartWidth >= 480) {
          annotation.label = {
            text: d.toLocaleDateString(hass && hass.locale && hass.locale.language, dayFmt),
            orientation: "horizontal",
            position: "top",
            offsetY: 0,
            borderColor: "transparent",
            style: {
              color: secondaryTextColor,
              background: "transparent",
              fontSize: "10px",
            },
          };
        }
        xAnnotations.push(annotation);
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
        foreColor: primaryTextColor,
        background: "transparent",
        events: {
          mouseLeave: function () {
            self._updateLegend(null);
          },
        },
      },
      theme: { mode: darkMode ? "dark" : "light" },
      series,
      dataLabels: { enabled: false },
      stroke: {
        curve: "straight",
        width: 2,
        dashArray: perStation.map(
          (_, index) => SERIES_DASH_PATTERNS[index % SERIES_DASH_PATTERNS.length],
        ),
      },
      // Solid water fill under the curve — reaches all the way down to the
      // axis so the shading reads as a filled body of water rather than a
      // fading gradient. Keeps the per-station colour for multi-station
      // distinguishability. Kept light so the label text on top stays
      // readable without needing an outline.
      fill: {
        type: "solid",
        opacity: 0.3,
      },
      // By default apex fills area series down to y=0; when the y-axis
      // extends below zero (heightMin < 0 after padding) this leaves a
      // white strip along the floor. "end" fills down to the plot floor.
      plotOptions: {
        area: { fillTo: "end" },
      },
      markers: { size: 0, discrete: discreteMarkers, hover: { size: 6 } },
      xaxis: {
        type: "datetime", min: tMin, max: tMax,
        labels: {
          datetimeUTC: false,
          hideOverlappingLabels: true,
          rotate: 0,
          format: (hass && hass.locale && hass.locale.time_format === "24") ? "H:mm" : "h TT",
        },
        tooltip: { enabled: false },
        axisTicks: { show: true },
        crosshairs: { show: true, stroke: { color: dividerColor, width: 1, dashArray: 3 } },
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
      grid: { borderColor: dividerColor },
      legend: { show: false },
      annotations: { xaxis: xAnnotations, points: pointAnnotations },
    };
  }
}


// ---------- Summary card ----------

class TidesPlusSummaryCard extends _TidesBase {
  _defaultConfig(config) {
    return {
      ...this._baseDefaults(),
      ...config,
      stations: config.stations.map(String),
    };
  }

  static getConfigElement() {
    return document.createElement("tides-plus-summary-card-editor");
  }

  static async getStubConfig(hass) {
    try {
      const res = await hass.callWS({ type: "ha_tides_plus/list_stations" });
      if (res.stations && res.stations.length) {
        return { stations: [res.stations[0].station_id] };
      }
    } catch (_) {}
    return { stations: [] };
  }

  getCardSize() {
    return 2 + 2 * Math.max(1, this._config?.stations?.length || 1);
  }

  getGridOptions() {
    return {
      columns: "full",
      rows: "auto",
      min_columns: 3,
      min_rows: 2,
    };
  }

  getLayoutOptions() {
    return {
      grid_columns: "full",
      grid_rows: "auto",
      grid_min_columns: 2,
      grid_min_rows: 2,
    };
  }

  _render() {
    if (!this._config) return;
    const stateHtml = this._dataStateHtml();
    if (stateHtml) {
      this.shadowRoot.innerHTML = stateHtml;
      return;
    }
    const ctx = this._prepare();
    if (!ctx) {
      this.shadowRoot.innerHTML = shell(`<div style="padding:16px;">No tide predictions are available.</div>`);
      return;
    }

    if (!ctx.hasSamplesInWindow) {
      const canReset = this._windowOffset !== 0;
      this.shadowRoot.innerHTML = shell(`
        ${this._dataWarningHtml()}
        ${this._navHeader(ctx)}
        <div style="padding:24px 16px;text-align:center;">
          <div style="color:var(--secondary-text-color);">No cached tide predictions for this range.</div>
          ${canReset ? `<button class="tp-nav" data-nav="reset" style="margin-top:12px;${NAV_BTN_STYLE}">Back to ${this._config.anchor === "now" ? "now" : "today"}</button>` : ""}
        </div>
      `);
      this._attachNavHandlers();
      return;
    }

    const u = unitLabel(ctx.unit);
    const hass = ctx.hass;

    const stationsHtml = ctx.perStation.map((s) => {
      const allY = s.dayKnots.map((k) => k.y);
      const swing = allY.length >= 2 ? Math.max(...allY) - Math.min(...allY) : null;
      const swingHtml = swing != null
        ? `<span style="font-size:12px;opacity:.7;margin-left:auto;font-variant-numeric:tabular-nums;">Swing <strong>${swing.toFixed(1)} ${u}</strong></span>`
        : "";
      return `
        <div style="padding:10px 16px 12px;border-top:1px solid var(--divider-color,rgba(0,0,0,0.12));min-width:0;">
          <div style="display:flex;align-items:center;margin-bottom:6px;">
            <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${s.color};margin-right:8px;flex:none;"></span>
            <span style="font-size:14px;"><strong>${escapeHtml(s.label)}</strong></span>
            ${swingHtml}
          </div>
          ${chronologicalTable(s, ctx, u, hass)}
        </div>`;
    }).join("");

    this.shadowRoot.innerHTML = shell(`
      ${this._dataWarningHtml()}
      ${this._navHeader(ctx)}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));">
        ${stationsHtml}
      </div>
    `);
    this._attachNavHandlers();
  }
}


// ---------- shared render helpers ----------

function shell(inner) {
  return `<ha-card>
    <style>
      .tp-nav:focus-visible, .tp-chart-interactive:focus-visible {
        outline: 2px solid var(--primary-color, #03a9f4);
        outline-offset: 2px;
      }
    </style>
    ${inner}
  </ha-card>`;
}

function eventIcon(kind, rising) {
  // Uses HA's global <ha-icon> element (registered by HA frontend) so we get
  // the same MDI set the rest of the UI uses. Colours match the tide-state
  // semantics: rising water = green up, falling water = orange down.
  const mdi =
    kind === "H" ? "mdi:wave-arrow-up"
    : kind === "L" ? "mdi:wave-arrow-down"
    : rising == null ? "mdi:swap-horizontal"
    : rising ? "mdi:trending-up"
    : "mdi:trending-down";
  const color =
    kind === "H" ? "var(--success-color,#0e8a5f)"
    : kind === "L" ? "var(--warning-color,#c2410c)"
    : rising == null ? "var(--secondary-text-color,#666)"
    : rising ? "var(--success-color,#0e8a5f)"
    : "var(--warning-color,#c2410c)";
  const label =
    kind === "H" ? "High tide"
    : kind === "L" ? "Low tide"
    : rising == null ? "Tide direction unavailable"
    : rising ? "Rising tide"
    : "Falling tide";
  return `<ha-icon icon="${mdi}" role="img" aria-label="${label}"
    style="--mdc-icon-size:18px;color:${color};vertical-align:middle;"></ha-icon>`;
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
      ? "background:var(--secondary-background-color,rgba(120,144,156,0.08));"
      : "";
    const timeLabel = e.kind === "NOW"
      ? `<span style="font-weight:600;">now</span>`
      : fmtTimeShort(new Date(e.t), hass);
    return `<tr style="${highlight}">
      <td style="padding:3px 8px 3px 0;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;"><strong>${e.y.toFixed(1)} ${unit}</strong></td>
      <td style="padding:3px 12px 3px 4px;font-variant-numeric:tabular-nums;color:var(--secondary-text-color,#666);text-align:left;white-space:nowrap;">${timeLabel}</td>
      <td style="padding:3px 0;text-align:left;line-height:0;">${eventIcon(e.kind, e.rising)}</td>
    </tr>`;
  }).join("");

  return `<table style="font-size:13px;border-collapse:collapse;">
    <caption style="${VISUALLY_HIDDEN_STYLE}">Tide events for ${escapeHtml(station.label)}</caption>
    <thead>
      <tr style="color:var(--secondary-text-color);font-size:11px;">
        <th scope="col" style="padding:3px 8px 3px 0;text-align:right;">Height</th>
        <th scope="col" style="padding:3px 12px 3px 4px;text-align:left;">Time</th>
        <th scope="col" style="padding:3px 0;text-align:left;">State</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}


// ---------- Card editors ----------

const EDITOR_STYLE = `
  :host { display: block; }
  .editor { padding: 16px; }
  .field { margin-bottom: 16px; }
  .field > label, .field-label {
    display: block; font-weight: 500; font-size: 13px;
    margin-bottom: 6px; color: var(--primary-text-color, #333);
  }
  .field > select, .field > input {
    width: 100%; padding: 8px; border-radius: 4px;
    min-height: 44px;
    border: 1px solid var(--divider-color, rgba(0,0,0,0.12));
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color, inherit);
    font-size: 14px; box-sizing: border-box;
  }
  .field > select:focus, .field > input:focus {
    outline: 2px solid var(--primary-color, #03a9f4);
    outline-offset: 2px;
    border-color: var(--primary-color, #03a9f4);
  }
  .station-list { display: flex; flex-direction: column; gap: 4px; }
  .station-item {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px; border-radius: 4px; cursor: pointer;
    min-height: 44px; box-sizing: border-box;
  }
  .station-item:hover {
    background: var(--secondary-background-color, rgba(0,0,0,0.04));
  }
  .station-item input[type="checkbox"] {
    width: 20px; height: 20px; margin: 0; cursor: pointer;
  }
  .station-name { font-size: 14px; }
  .station-id { font-size: 12px; opacity: .6; margin-left: 4px; }
  .no-stations {
    font-size: 13px; opacity: .6; padding: 8px 0;
  }
  .row { display: flex; gap: 12px; }
  .row > .field { flex: 1; }
  @media (max-width: 420px) {
    .row { display: block; }
  }
`;

class _EditorBase extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._stations = null;
  }

  setConfig(config) {
    this._config = {
      ...config,
      stations: Array.isArray(config.stations) ? config.stations.map(String) : [],
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._stations) this._loadStations();
  }

  async _loadStations() {
    try {
      const res = await this._hass.callWS({ type: "ha_tides_plus/list_stations" });
      this._stations = res.stations || [];
    } catch (_) {
      this._stations = [];
    }
    this._render();
  }

  _fireChanged() {
    const cfg = { ...this._config };
    // Strip keys that equal their defaults so the YAML stays clean.
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: cfg },
      bubbles: true,
      composed: true,
    }));
  }

  _stationPickerHtml() {
    const selected = (this._config.stations || []).map(String);
    if (!this._stations || !this._stations.length) {
      return `<div class="field">
        <div class="field-label">Stations</div>
        <div class="no-stations">No stations configured yet. Add one via Settings → Devices & Services → Tides Plus.</div>
      </div>`;
    }
    const items = this._stations.map((s) => {
      const stationId = String(s.station_id);
      const checked = selected.includes(stationId) ? "checked" : "";
      const label = s.station_name
        ? `${s.station_name}${s.station_state ? ", " + s.station_state : ""}`
        : s.title || s.station_id;
      return `<label class="station-item">
        <input type="checkbox" value="${escapeHtml(stationId)}" ${checked} data-field="stations">
        <span class="station-name">${escapeHtml(label)}</span>
        <span class="station-id">${escapeHtml(stationId)}</span>
      </label>`;
    }).join("");
    return `<div class="field">
      <div class="field-label" id="stations-label">Stations</div>
      <div class="station-list" role="group" aria-labelledby="stations-label">${items}</div>
    </div>`;
  }

  _unitPickerHtml() {
    const v = this._config.unit || "";
    return `<div class="field">
      <label for="unit-select">Unit</label>
      <select id="unit-select" data-field="unit">
        <option value=""${v === "" ? " selected" : ""}>System default</option>
        <option value="metric"${v === "metric" ? " selected" : ""}>Metric (m)</option>
        <option value="imperial"${v === "imperial" ? " selected" : ""}>Imperial (ft)</option>
      </select>
    </div>`;
  }

  _chartFieldsHtml({ includeSun = true } = {}) {
    const cfg = this._config;
    const anchor = cfg.anchor || "day";
    const buttons = cfg.buttons || "forward-backward";
    const configuredBefore = Number(cfg.hours_before ?? 0);
    const configuredAfter = Number(cfg.hours_after ?? 24);
    const hoursBefore = Number.isFinite(configuredBefore) ? configuredBefore : 0;
    const hoursAfter = Number.isFinite(configuredAfter) ? configuredAfter : 24;

    return `
      <div class="field">
        <label for="anchor-select">Anchor</label>
        <select id="anchor-select" data-field="anchor">
          <option value="day"${anchor === "day" ? " selected" : ""}>Day (midnight to midnight)</option>
          <option value="now"${anchor === "now" ? " selected" : ""}>Now (rolling window)</option>
        </select>
      </div>

      <div class="row">
        <div class="field">
          <label for="hours-before-input">Hours before</label>
          <input id="hours-before-input" type="number" data-field="hours_before" value="${hoursBefore}" min="0" max="168" step="1">
        </div>
        <div class="field">
          <label for="hours-after-input">Hours after</label>
          <input id="hours-after-input" type="number" data-field="hours_after" value="${hoursAfter}" min="1" max="168" step="1">
        </div>
      </div>

      <div class="field">
        <label for="buttons-select">Navigation buttons</label>
        <select id="buttons-select" data-field="buttons">
          <option value="forward-backward"${buttons === "forward-backward" ? " selected" : ""}>Forward / backward</option>
          <option value="none"${buttons === "none" ? " selected" : ""}>None</option>
        </select>
      </div>

      ${includeSun ? `<div class="field">
        <ha-entity-picker
          id="sun-entity-picker"
          label="Sun entity (for day/night shading)"
          data-field="sun_entity"
        ></ha-entity-picker>
      </div>` : ""}`;
  }

  _attachListeners() {
    const root = this.shadowRoot;
    root.querySelectorAll("select[data-field]").forEach((el) => {
      el.addEventListener("change", (e) => {
        const field = e.target.dataset.field;
        const val = e.target.value;
        if (val === "") {
          delete this._config[field];
        } else {
          this._config[field] = val;
        }
        this._fireChanged();
      });
    });
    root.querySelectorAll("input[type=number][data-field]").forEach((el) => {
      el.addEventListener("change", (e) => {
        const field = e.target.dataset.field;
        this._config[field] = Number(e.target.value);
        this._fireChanged();
      });
    });
    root.querySelectorAll("input[type=checkbox][data-field=stations]").forEach((el) => {
      el.addEventListener("change", () => {
        const checked = Array.from(
          root.querySelectorAll("input[type=checkbox][data-field=stations]:checked"),
        ).map((cb) => cb.value);
        this._config.stations = checked;
        this._fireChanged();
      });
    });

    const picker = root.getElementById("sun-entity-picker");
    if (picker) {
      picker.hass = this._hass;
      picker.value = this._config.sun_entity || "sun.sun";
      picker.includeDomains = ["sun"];
      picker.addEventListener("value-changed", (e) => {
        const val = e.detail.value;
        if (val) {
          this._config.sun_entity = val;
        } else {
          delete this._config.sun_entity;
        }
        this._fireChanged();
      });
    }
  }
}


class TidesPlusCardEditor extends _EditorBase {
  _render() {
    if (!this._stations) {
      this.shadowRoot.innerHTML = `<style>${EDITOR_STYLE}</style>
        <div class="editor">Loading stations…</div>`;
      return;
    }
    this.shadowRoot.innerHTML = `<style>${EDITOR_STYLE}</style>
      <div class="editor">
        ${this._stationPickerHtml()}
        ${this._chartFieldsHtml()}
        ${this._unitPickerHtml()}
      </div>`;
    this._attachListeners();
  }
}


class TidesPlusSummaryCardEditor extends _EditorBase {
  _render() {
    if (!this._stations) {
      this.shadowRoot.innerHTML = `<style>${EDITOR_STYLE}</style>
        <div class="editor">Loading stations…</div>`;
      return;
    }
    this.shadowRoot.innerHTML = `<style>${EDITOR_STYLE}</style>
      <div class="editor">
        ${this._stationPickerHtml()}
        ${this._chartFieldsHtml({ includeSun: false })}
        ${this._unitPickerHtml()}
      </div>`;
    this._attachListeners();
  }
}

const CHART_EDITOR_TAG = "tides-plus-card-editor";
const SUMMARY_EDITOR_TAG = "tides-plus-summary-card-editor";


// ---------- registration ----------

const CARD_ELEMENTS = [
  [CHART_EDITOR_TAG, TidesPlusCardEditor],
  [SUMMARY_EDITOR_TAG, TidesPlusSummaryCardEditor],
  [CARD_TAG, TidesPlusCard],
  [SUMMARY_TAG, TidesPlusSummaryCard],
];

function registerCardElements() {
  for (const [tag, constructor] of CARD_ELEMENTS) {
    if (!customElements.get(tag)) customElements.define(tag, constructor);
  }
}

let registeredElementRegistry = window.customElements;
registerCardElements();

// HA can replace the global registry while its frontend starts. This can
// happen after an early cached extra module registers its elements. Watch
// only during startup and copy the definitions into the final registry.
if (!customElements.get("home-assistant")) {
  const registryWatchDeadline = performance.now() + 10_000;
  const registryWatch = window.setInterval(() => {
    if (window.customElements !== registeredElementRegistry) {
      registeredElementRegistry = window.customElements;
      registerCardElements();
    }
    if (
      customElements.get("home-assistant") ||
      performance.now() >= registryWatchDeadline
    ) {
      window.clearInterval(registryWatch);
    }
  }, 0);
}

window.customCards = window.customCards || [];
for (const [tag, name, desc] of [
  [CARD_TAG, "Tides Plus", "Tide curve with hi/lo markers, day/night shading, and NOW indicator."],
  [SUMMARY_TAG, "Tides Plus — Summary", "Tabular high/low tide breakdown for one or more stations."],
]) {
  if (!window.customCards.find((c) => c.type === tag)) {
    window.customCards.push({ type: tag, name, description: desc, preview: false });
  }
}
