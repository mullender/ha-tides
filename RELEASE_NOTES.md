# v0.2.0 — First tagged release

Home Assistant custom integration for tide predictions from multiple
public data sources.

## Highlights

- **Two shipped providers**, picked per station in the config flow:
  - **NOAA CO-OPS** — every US tide-prediction station (reference +
    subordinate, ~3500 stations).
  - **Rijkswaterstaat** — every NL station that publishes astronomic
    tides (~150 coastal + estuary locations, including Scheveningen
    with its "agger" wobbles).
- **Pluggable provider layer** — adding a new source is one Python
  file plus a registry line. See
  [`docs/providers.md`](docs/providers.md).
- **Ten sensors per station**:
  - `tide_height (estimated)` — PCHIP-interpolated current height,
    updates every 60 s, carries an `extrema` attribute with the full
    cached H/L knot list (blueprints and templates can iterate it).
  - `tide_state` — enum: `rising` / `falling` / `high` / `low`,
    with a 10 min hold at each peak/trough.
  - `next_high_tide`, `next_low_tide`, `previous_high_tide`,
    `previous_low_tide` — timestamp sensors.
  - `next_high_tide_height`, `next_low_tide_height`,
    `previous_high_tide_height`, `previous_low_tide_height` — distance
    sensors (metres native, HA auto-converts).
- **Bus events** at every knot: `ha_tides_plus_high_tide` and
  `ha_tides_plus_low_tide`.
- **Bundled Lovelace cards** with visual editors (auto-loaded, no
  extra HACS-frontend install):
  - `custom:tides-plus-card` — ApexCharts curve with day/night
    shading, responsive H/L labels, keyboard inspection, live crosshair
    legend, and `‹ Today ›` navigation.
  - `custom:tides-plus-summary-card` — chronological H/L table with a
    slotted-in "now" row.
  - Both cards ship a **visual editor** (pencil icon on the card) so
    the picker, anchor, hours, buttons, and unit can be set without
    writing YAML.
  - Both cards honour Home Assistant's **`grid_options`** so they can
    live side-by-side in Sections dashboards.
  - Both cards use automatic height, follow light and dark themes, show
    clear loading and error states, and refresh data every 30 minutes.
- **One starter automation blueprint** — `tide_extreme_alert.yaml`
  (device picker, direction switch, threshold, sun-aware daylight,
  template-friendly notification).
- **In-repo brand icon** — served through the HA 2026.3+ brands
  proxy without a `home-assistant/brands` PR.

## Install

Custom repository — HACS → three-dot menu → *Custom repositories*,
URL `https://github.com/mullender/ha-tides`, category *Integration*.
Restart HA, then **Settings → Devices & Services → Add Integration
→ Tides Plus**.

Full walkthrough in the [README](README.md).
