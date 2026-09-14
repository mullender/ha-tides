/**
 * Tides Plus card — renders one or more NOAA tide stations as a day-long
 * tide curve with hi/lo knot markers, "NOW" indicator, and shaded night
 * regions from sun.sun.
 *
 * YAML example:
 *   type: custom:tides-plus-card
 *   stations:
 *     - 8467150
 *     - 9445882
 *   sun_entity: sun.sun     # optional, default sun.sun
 *   hours: 24               # optional, day-in-local-time when omitted
 */

const CARD_TAG = "tides-plus-card";

const M_TO_FT = 3.28084;
const KNOT_COLORS = [
  "var(--tides-plus-color-1, #1976d2)",
  "var(--tides-plus-color-2, #e65100)",
  "var(--tides-plus-color-3, #2e7d32)",
  "var(--tides-plus-color-4, #6a1b9a)",
];

class TidesPlusCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._series = new Map();          // stationId -> {station_id, knots, ...}
    this._loading = new Set();
    this._loaded = false;
  }

  setConfig(config) {
    if (!config || !config.stations || !config.stations.length) {
      throw new Error("`stations:` must list at least one NOAA station ID.");
    }
    this._config = {
      sun_entity: "sun.sun",
      ...config,
      stations: config.stations.map(String),
    };
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

  getCardSize() { return 4; }

  async _loadAll() {
    const jobs = this._config.stations.map((id) => this._loadOne(id));
    await Promise.all(jobs);
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
      this._series.set(id, { error: String(err && err.message || err), station_id: id });
    } finally {
      this._loading.delete(id);
    }
  }

  _render() {
    if (!this._config) return;
    const rows = this._config.stations
      .map((id, i) => {
        const s = this._series.get(id);
        if (!s) return `<div>Loading ${id}…</div>`;
        if (s.error) return `<div>Station ${id}: ${s.error}</div>`;
        const first = s.knots[0];
        const last = s.knots[s.knots.length - 1];
        const label = s.station_name
          ? `${s.station_name}${s.station_state ? ", " + s.station_state : ""} (${s.station_id})`
          : s.station_id;
        return `
          <div style="border-left: 4px solid ${KNOT_COLORS[i % KNOT_COLORS.length]}; padding-left: 8px; margin: 4px 0;">
            <div><strong>${label}</strong></div>
            <div>${s.knots.length} knots, ${first ? first.time : "—"} → ${last ? last.time : "—"}</div>
          </div>`;
      })
      .join("");
    this.shadowRoot.innerHTML = `
      <ha-card header="Tides Plus">
        <div style="padding: 12px; font-family: var(--primary-font-family, sans-serif);">
          ${rows}
          <div style="opacity:.5; margin-top:8px;">Chart rendering coming next.</div>
        </div>
      </ha-card>`;
  }
}

customElements.define(CARD_TAG, TidesPlusCard);

window.customCards = window.customCards || [];
if (!window.customCards.find((c) => c.type === CARD_TAG)) {
  window.customCards.push({
    type: CARD_TAG,
    name: "Tides Plus",
    description: "Tide curve with hi/lo markers, day/night shading, and NOW indicator.",
    preview: false,
  });
}
