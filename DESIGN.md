# Tides Plus — Design

Home Assistant custom integration for tide predictions from multiple
public data sources. Ships in the `ha_tides_plus` domain and includes
NOAA CO-OPS (USA) and Rijkswaterstaat (NL) out of the box, behind a
provider abstraction that any contributor can extend with one Python
file — see [`docs/providers.md`](docs/providers.md). The legacy core
`noaa_tides` integration is untouched; both can run side by side.

## 1. Goals

- Numeric current-height sensor, interpolated between the NOAA
  hi/lo predictions with zero slope at each peak.
- Timestamp sensors for the next and previous high / low tide, usable
  in standard `time` triggers.
- Rising / falling / high / low state, derived from the hi/lo series
  without a second API call.
- Bus events fired at every extremum, for `event` triggers.
- Config flow with a provider picker + station picker (ZIP, place
  name, or direct ID).
- Bundled dashboard cards (chart + summary) and automation blueprints.
- Cover every NOAA CO-OPS tide-prediction station in the US
  (reference + subordinate) and every Rijkswaterstaat station that
  publishes astronomic tides in NL (~150 coastal + estuary locations).
- Pluggable provider layer so more countries can be added by dropping
  one Python file into `providers/`.

## 2. Non-goals (v1)

- Slack water and true current direction — need `currents_predictions`
  and a separate current-station list. Deferred to v2.
- Additional non-US / non-NL providers (SHOM, UKHO, …). Not shipped
  yet, but the provider layer accepts new implementations without any
  changes to the core.
- Historical observations. Predictions only.
- Sea-surface temperature, wind, and other CO-OPS or RWS products.

## 3. Data sources

Two providers ship today, each contained in one module under
`custom_components/ha_tides_plus/providers/`.

### 3.1 NOAA CO-OPS (USA)

- Base URL: `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`
- Product: `predictions`
- Interval: `hilo` — one point per extremum, ~4 per day per station.
- Datum: `MLLW` (hard-coded default; options flow will expose it).
- Time zone: `gmt` — always UTC in and out; HA displays in the user zone.
- No API key. Every call sets `application=ha_tides_plus` per NOAA
  guidance.
- Station metadata:
  `https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/<id>.json?expand=details,products`
  (per-station) and
  `.../stations.json?type=tidepredictions` (whole catalogue, used by the
  nearest-station picker).

### 3.2 Rijkswaterstaat (NL)

- Base URL: `https://ddapi20-waterwebservices.rijkswaterstaat.nl`
- Catalogue: `POST /METADATASERVICES/OphalenCatalogus` with all axes
  enabled returns 2499 locations and 3426 aquo-metadata entries.
  Filtered on the astronomic-tide marker (Aquo MID 2976, "Getijextreemtype
  astronomisch in Oppervlaktewater") for the station picker — yields
  ~150 stations.
- Predictions: `POST /ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen`
  with `Compartiment=OW`, `Grootheid=WATHTE`, `Hoedanigheid=NAP` (or
  `MSL` for offshore platforms) returns three parallel series per
  location — observed, weather-forecast, and astronomic. The provider
  picks the entry whose `Parameter_Wat_Omschrijving` contains
  `astronomisch`.
- H/L extraction: astronomic samples arrive at 10-minute intervals in
  centimetres above the reference plane. Equal-height runs (RWS
  quantises to whole cm) collapse to their centre sample; a
  neighbour-compare then finds every local extremum; peak times are
  refined with a three-point parabolic fit.
- No API key.

### 3.3 Adding a third provider

See [`docs/providers.md`](docs/providers.md) for the full how-to. In
short: subclass `Provider` in a new module under `providers/`,
implement three async methods (`list_stations`, `get_station`,
`get_hilo_predictions`) that return the shared `Station` /
`TideExtremum` shape, and add the class to `_REGISTRY` in
`providers/__init__.py`. Everything downstream picks it up.

## 4. Architecture

One `ConfigEntry` per station, one `DataUpdateCoordinator` per entry.
Each entry stores a `provider` id (default `noaa` for entries created
before the abstraction landed — migration is automatic).

Coordinator refresh:

- Interval: 12 h.
- Window: `LOOKBACK_HOURS = 168` back + `LOOKAHEAD_HOURS = 168` forward
  (±7 days). Comfortably within every provider's per-call limits.
- On failure, the last good series is kept. The entry fails only if the
  cache no longer covers `now()`.

Sensors and events read exclusively from the coordinator cache. The API
is only touched by the coordinator (refresh) and the config flow
(validation + station lookup).

The chart and summary cards read `coordinator.data` through a small
WebSocket command (`ha_tides_plus/hilo_series`, `ha_tides_plus/list_stations`)
so they do not have to walk the recorder history.

## 5. Interpolation

The hi/lo series `(t_i, h_i)` alternates highs and lows, so every
interior knot is a local extremum. Standard Fritsch-Carlson PCHIP sets
the derivative at such a knot to 0 to preserve segment monotonicity —
exactly the "flat at the peak" shape a tide chart needs.

- Python implementation lives in `interpolation.py` — pure `numpy`, no
  `scipy` dependency for ~30 lines of math.
- The same PCHIP is ported to JS inside `frontend/tides-plus-card.js`,
  so the client-side curve matches the sensor value byte for byte.

## 6. Entity model (per config entry)

Ten entities per station:

| Entity | Type | Purpose |
|---|---|---|
| `sensor.<name>_tide_height` | distance (m native, HA converts) | PCHIP-interpolated current height. Updates every 60 s. Carries an `extrema` attribute (full cached hi/lo list in the sensor's display unit) and a `unit` attribute. |
| `sensor.<name>_tide_state` | enum: `rising` / `falling` / `high` / `low` | Direction plus a 10 min hold around each extremum. |
| `sensor.<name>_next_high_tide` | timestamp | ISO datetime of the next H. |
| `sensor.<name>_next_low_tide` | timestamp | ISO datetime of the next L. |
| `sensor.<name>_next_high_tide_height` | distance | Height of the next H. |
| `sensor.<name>_next_low_tide_height` | distance | Height of the next L. |
| `sensor.<name>_previous_high_tide` | timestamp | ISO datetime of the most recent H. |
| `sensor.<name>_previous_low_tide` | timestamp | ISO datetime of the most recent L. |
| `sensor.<name>_previous_high_tide_height` | distance | Height of the most recent H. |
| `sensor.<name>_previous_low_tide_height` | distance | Height of the most recent L. |

All ten share one `DeviceInfo` per station (identifier `(DOMAIN,
station_id)`, name `<id>: <station_name>, <state>`, coords, provider
station URL, and the provider's `manufacturer` string). Attribution
on every entity comes from `provider.attribution`.

## 7. Ebb / flood state machine

For each pair of adjacent knots `(t_a, h_a) -> (t_b, h_b)`:

- If `h_b > h_a`, the state during the segment is `rising` (flooding).
- If `h_b < h_a`, the state during the segment is `falling` (ebbing).

Around each extremum, the state holds at `high` or `low` for `± W`
minutes; `W` is 10 min today (will be exposed by the options flow).

## 8. Events

Fired on the HA event bus at each extremum knot time:

- `ha_tides_plus_high_tide`
- `ha_tides_plus_low_tide`

Payload:

```json
{
  "station_id": "9445882",
  "station_name": "Eagle Harbor, Bainbridge Island",
  "station_state": "WA",
  "time": "2026-09-15T09:11:00+00:00",
  "height": 0.066,
  "unit": "m"
}
```

`station_state` is populated only when the provider fills it in
(NOAA does; RWS leaves it `null`).

Events are scheduled with `async_track_point_in_time` on each coordinator
refresh and cancelled on unload. Users trigger on the event (lowest
latency) or on the `next_*_tide` timestamp sensors (survive an HA
restart).

## 9. Config flow

Step 0 — provider (only shown when more than one provider is
registered):

- Dropdown of `(provider.id, provider.label)` pairs, defaulting to
  NOAA.

Step 1 — search:

- One text input. Interpreted as:
  - empty → `hass.config.latitude` / `longitude`.
  - `provider.parse_direct_id(query)` returns non-None → skip step 2.
    NOAA matches 7-digit numeric; RWS matches non-space, non-numeric
    dotted slugs.
  - 5 digits → US ZIP; resolved via `api.zippopotam.us` (geocode step).
  - anything else → geocoded via OpenStreetMap Nominatim.
- If not a direct ID, HA fetches the provider's full station
  catalogue and haversine-ranks against the resolved lat/lng.

Step 2 — pick station:

- Dropdown of the nearest 20 stations, labelled
  `"<Name>, <ST> — <km> km (station: <id>)"`. `<ST>` is `station.state`
  when the provider populates it (NOAA does; RWS leaves it `None`).
- On submit, the station is validated through `provider.get_station`,
  the entry unique-ID is the raw station ID, and station name, state,
  coordinates, and provider ID are persisted in `entry.data`.

Options flow: not shipped yet. Planned inputs: `datum`,
`hold_window_minutes`, `unit` override.

## 10. Cards

Two custom elements, both auto-injected via
`add_extra_js_url` / `async_register_static_paths`:

- `custom:tides-plus-card` — day-long tide chart, ApexCharts renderer.
  Config: `stations`, `anchor` (`day` | `now`), `hours_before`,
  `hours_after`, `buttons` (`forward-backward` | `none`), `sun_entity`,
  `unit`. Renders a PCHIP curve with day/night shading, discrete knot
  markers, permanent H/L labels, a live crosshair legend showing hovered
  height + prev/next H/L, and a `‹ Today ›` nav header.
- `custom:tides-plus-summary-card` — tabular chronological breakdown of
  today's H/L with a slotted-in "now" row, direction icons, and swing.

Both share `_TidesBase` for hass wiring, data fetch, and nav. Both
implement `getGridOptions()` and the legacy `getLayoutOptions()` so
Sections dashboards default to full-width, automatic-height placement.
Users can override these values with `grid_options` in YAML.

## 11. Blueprints

Bundled under `blueprints/automation/ha_tides_plus/`. Currently one:

- `tide_extreme_alert.yaml` — daily check at a user-chosen local time
  for the first upcoming H or L within a lookahead window that meets a
  threshold; optional sun-aware daylight filter; template-friendly
  title / message / notification data with a default deep-link URL to
  the station device.

Users install via Settings → Blueprints → Import blueprint with the
raw GitHub URL.

## 12. Testing

Not shipped yet. Planned suite:

- Unit tests for PCHIP against known analytical curves. Assert
  derivative is 0 at each knot.
- Unit tests for the state-machine transitions with `freezegun`.
- Unit tests for event scheduling.
- Coordinator tests with saved CO-OPS JSON fixtures. No live API calls
  in CI.
- End-to-end tests with `pytest-homeassistant-custom-component`.

## 13. Distribution

Shipped as a HACS custom component under `ha_tides_plus`. Install
instructions in `README.md`.

Future:

- HACS default-list submission once the API surface is stable.
- Upstream rewrite of `homeassistant/core`'s `noaa_tides` with a
  compat shim preserving the legacy `unique_id = "<station>_summary"`
  and text-state format.
