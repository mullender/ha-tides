# Tides Plus — Design

Home Assistant custom integration for NOAA CO-OPS tide predictions.
Ships in the `ha_tides_plus` domain. The legacy core `noaa_tides`
integration is untouched; both can run side by side.

## 1. Goals

- Numeric current-height sensor, interpolated between the NOAA
  hi/lo predictions with zero slope at each peak.
- Timestamp sensors for the next and previous high / low tide, usable
  in standard `time` triggers.
- Rising / falling / high / low state, derived from the hi/lo series
  without a second API call.
- Bus events fired at every extremum, for `event` triggers.
- Config flow with a station picker (ZIP, place name, or direct ID).
- Bundled dashboard cards (chart + summary) and automation blueprints.
- Cover every NOAA CO-OPS tide-prediction station in the US
  (reference + subordinate).

## 2. Non-goals (v1)

- Slack water and true current direction — need `currents_predictions`
  and a separate current-station list. Deferred to v2.
- Non-US providers (SHOM, Rijkswaterstaat, UKHO). Deferred; the
  card / summary / coordinator machinery is provider-agnostic in shape.
- Historical observations. Predictions only.
- Sea-surface temperature, wind, and other CO-OPS products.

## 3. Data source

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

## 4. Architecture

One `ConfigEntry` per station, one `DataUpdateCoordinator` per entry.

Coordinator refresh:

- Interval: 12 h.
- Window: `LOOKBACK_HOURS = 168` back + `LOOKAHEAD_HOURS = 168` forward
  (±7 days). NOAA accepts up to 31 days per fetch; 14 days is well under.
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
station_id)`, name `<id>: <station_name>, <state>`, coords, NOAA URL).

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

Events are scheduled with `async_track_point_in_time` on each coordinator
refresh and cancelled on unload. Users trigger on the event (lowest
latency) or on the `next_*_tide` timestamp sensors (survive an HA
restart).

## 9. Config flow

Step 1 — search:

- One text input. Interpreted as:
  - empty → `hass.config.latitude` / `longitude`.
  - 5 digits → US ZIP; resolved via `api.zippopotam.us`.
  - 7 digits → direct NOAA station ID (skips step 2).
  - anything else → geocoded via OpenStreetMap Nominatim.
- If not a direct ID, HA fetches the full ~3500-station catalogue and
  haversine-ranks against the resolved lat/lng.

Step 2 — pick station:

- Dropdown of the nearest 20 stations, labelled
  `"<Name>, <ST> — <km> km (station: <id>)"`.
- On submit, the station is validated via the mdapi (reference *or*
  subordinate stations both accepted) and the entry is created with
  station name, state, and coordinates persisted in `entry.data`.

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

Both share `_TidesBase` for hass wiring, data fetch, and nav.

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
