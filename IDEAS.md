# Post-MVP ideas

A running board of what could ship next. Below the horizontal rule sits
what is already shipped in `main` — see `git log` for detail. Items above
the rule are open.

## Open

### Config and setup

- **Options flow** — expose `datum` (MLLW / MLW / MSL / MHW / MHHW), the
  extremum-hold window for `tide_state`, and any card-side defaults.
  Nothing is user-configurable at runtime today.

### Chart card

- **Date picker** in the nav header (`buttons: picker`). The `‹` / Today /
  `›` step buttons are shipped; a calendar popup is still open.
- **Multi-station label collisions** — when two stations' H peaks land close
  in time, the permanent labels overlap. Needs a small collision-resolver.
- **Dark-theme pass** — both cards use station colours and neutral greys,
  but no explicit dark-theme check yet.
- **On-demand cache extend** — paging past ±7 days shows "no cached
  predictions". The WebSocket API could accept a `(begin, end)` range and
  have the coordinator fetch and merge on demand.

### Automations / blueprints

- **Slack-window notification** — fire N minutes before an H or L so users
  hit the still-water window (dive, launch, harbour transit).
- **Tide crossing threshold (reactive)** — trigger the moment
  `sensor.<>_tide_height` crosses a threshold rising or falling. Simple
  `numeric_state` trigger; useful for dock height, sea-gate closures.
- **Extreme-tide (near yearly max/min) alert** — needs an annual harmonic
  fetch and per-station stats cache. Flag when the next H/L is within N %
  of the annual extreme.

### Providers (v2)

- **Currents (slack / ebb / flood)** — needs the CO-OPS
  `currents_predictions` product and a separate current-station picker.
- **More EU providers** — SHOM (FR), UKHO (UK), and other national
  agencies. Follow [`docs/providers.md`](docs/providers.md) — a new
  provider is one Python file plus a registry line.
- **Prominence filter for RWS predictions** — Scheveningen and other
  agger-prone NL stations report every local extremum, including the
  small mid-cycle wobbles. A prominence threshold would let users hide
  the agger from the summary card and the `next_low_tide` sensor while
  keeping it in the chart.

### Distribution

- **Upstream rewrite** of core `noaa_tides` plus a BC shim (preserve the
  legacy `unique_id = "<station>_summary"` and text-state format).
- **HACS listing** once the integration stabilises.
- **home-assistant/brands PR** to register the brand icon at
  `brands.home-assistant.io`. Not needed for HA 2026.3+ (which reads the
  in-repo `brand/` directory), but older HA versions still hit the CDN.

### Reach

- **iOS Live Activity** via the HA Companion app — lock-screen current
  tide + countdown to next extremum.
- **Apple Watch complication** — piggybacks on the Live Activity.
- **Voice** — Assist / Alexa: *"when is the next high tide?"*.

## Testing

- **Tests** — no pytest suite yet. Wanted: PCHIP against known analytical
  curves, coordinator against saved JSON fixtures, config-flow paths
  including the geocode and station-picker branches, event scheduling with
  `freezegun`.

---

## Shipped

- **Provider abstraction** — `providers/` package with a `Provider`
  ABC, a small registry, and two shipped implementations (NOAA CO-OPS
  for the US, Rijkswaterstaat DDAPI 2.0 for NL). Adding a third source
  is one Python file plus a registry line — see
  [`docs/providers.md`](docs/providers.md) for the how-to. The config
  flow gains a provider-picker step when more than one is registered.
- **Rijkswaterstaat (NL)** — ~150 stations, coast + estuaries, filtered
  from the DDAPI 2.0 catalogue by the astronomic-tide marker. The 10-min
  WATHTE series is walked (with plateau collapse + parabolic peak
  refinement) to extract H/L knots. Handles NAP-referenced coastal
  stations and MSL-referenced offshore platforms.
- **Station picker** — free-text search: US ZIP (via zippopotam.us),
  place name (via Nominatim), native station ID, or empty for HA-home
  coords. Haversine-ranks the provider's catalogue and shows the
  nearest 20.
- **Per-station device** with 10 sensors: `previous_high_tide`,
  `previous_low_tide`, `next_high_tide`, `next_low_tide` (each a
  `timestamp`) plus paired `_height` (each a `distance` in metres, HA
  converts on display), `tide_height (estimated)` (PCHIP-interpolated,
  updates every 60 s), `tide_state` (enum: `rising` / `falling` / `high`
  / `low`).
- **Bus events** — `ha_tides_plus_high_tide` and `_low_tide` fired at each
  extremum with a payload including station ID, name, state, height, and
  ISO time.
- **±7-day cache** — coordinator fetches once per 12 h, keeps the last
  good series if a fetch fails.
- **extrema attribute** on the estimated-height sensor — full cached
  hi/lo knot list in the sensor's display unit, so blueprints and
  template automations can iterate every upcoming H/L rather than only
  the scalar "next" siblings.
- **Chart card** (`custom:tides-plus-card`) — ApexCharts area series with
  PCHIP curve, permanent H/L labels above/below the peaks, filled water
  fill to the plot floor (`plotOptions.area.fillTo: 'end'`), day / night
  shading across the visible window, day-boundary markers on multi-day
  spans, live crosshair legend, `‹ Today ›` nav in day or now anchor,
  no-cache fallback state.
- **Summary card** (`custom:tides-plus-summary-card`) — chronological
  table with H / L / now rows, direction icons, swing in the header,
  height-first ordering.
- **Auto-loaded frontend** — `hass.http.async_register_static_paths` +
  `add_extra_js_url` inject both cards + bundled ApexCharts without any
  HACS-frontend install. In-repo `brand/` icon per HA 2026.3+.
- **One bundled blueprint** — `tide_extreme_alert` — device selector +
  direction switch (below / above) infers the sensor to watch, iterates
  the `extrema` attribute for the first knot inside a configurable
  lookahead that matches threshold + optional sun-aware daylight, then
  fires a template-friendly notification with a default deep-link URL to
  the station device.
