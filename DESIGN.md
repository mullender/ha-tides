# NOAA Tides Plus — Design

Home Assistant custom integration for NOAA tide predictions. Replaces the
minimal legacy `noaa_tides` integration with numeric sensors, timestamp
sensors, events, and a rising/falling state derived from hi/lo data.

## 1. Goals

- Numeric tide-height sensor, updated once per minute, for graphs and templates.
- Timestamp sensors for the next high tide and next low tide, usable in
  standard `time` triggers.
- Ebb/flood state derived from hi/lo data without a second API call.
- Events fired on the bus at each high tide and low tide, for `event` triggers.
- Config flow. No YAML.
- Cover every NOAA CO-OPS tide-prediction station in the US.

## 2. Non-goals (v1)

- Slack water and true current direction. These need `currents_predictions`
  and a separate current-station list. Defer to v2.
- Non-US sources (SHOM, Rijkswaterstaat, UKHO). Defer.
- Historical observations. Predictions only.
- Sea-surface temperature, wind, and other CO-OPS products.

## 3. Data source

- Base URL: `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`
- Product: `predictions`
- Datum: `MLLW` (default; expose as an option)
- Interval: `hilo` by default. Option to switch to `6` (6-minute) for a
  higher-fidelity curve.
- No API key. Set `application=ha_tides_plus` per NOAA guidance.
- Station metadata:
  `https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions`

Assumption to verify: every station that supports `interval=hilo` also
supports `interval=6` and `interval=h`. Both intervals come from the same
harmonic constituents, so coverage should be identical. Confirm against
the station list before shipping.

## 4. Architecture

One `ConfigEntry` per station. One `DataUpdateCoordinator` per entry.

Coordinator refresh:

- Fetch `hilo` predictions for the next 7 days. Refresh every 12 h.
- If `interval=6` is enabled, fetch 6-minute predictions for the next 48 h.
  Refresh every 6 h.
- On failure, keep the last good dataset. Fail the entry only if the cache
  no longer covers `now()`.

Sensors read from the coordinator cache. Sensors do not call the API.

## 5. Interpolation

Given the hi/lo sequence `(t_i, h_i)`:

- Use PCHIP (Piecewise Cubic Hermite) between adjacent knots.
- Adjacent knots alternate between highs and lows, so each knot is a local
  extremum. Standard PCHIP sets the derivative at each such knot to 0 to
  preserve segment monotonicity. This gives the exact shape the user wants:
  smooth, monotone between extrema, zero slope at every peak.
- Implement in pure `numpy`. Do not add a `scipy` dependency for ~30 lines
  of math.

When `interval=6` is enabled, use the raw 6-minute series and interpolate
linearly between the two nearest samples for the current-height value.

## 6. Entity model (per config entry)

| Entity | Type | Purpose |
|---|---|---|
| `sensor.<name>_tide_height` | numeric (`m` or `ft`) | Interpolated current height. Updates every 60 s. |
| `sensor.<name>_tide_state` | enum: `rising`, `falling`, `high`, `low` | Direction, plus a hold window around each extremum. |
| `sensor.<name>_next_high_tide` | `device_class: timestamp` | ISO datetime of next high. |
| `sensor.<name>_next_low_tide` | `device_class: timestamp` | ISO datetime of next low. |
| `sensor.<name>_next_high_height` | numeric | Height of next high. |
| `sensor.<name>_next_low_height` | numeric | Height of next low. |

All entities share one `DeviceInfo` per station (station ID, name, coords).

## 7. Ebb / flood state machine

For each pair of adjacent knots `(t_a, h_a) -> (t_b, h_b)`:

- If `h_b > h_a`, state during the segment is `rising` (flooding).
- If `h_b < h_a`, state during the segment is `falling` (ebbing).

Around each extremum, hold `high` or `low` for `+/- W` minutes, where `W`
is a config option (default 10 min).

State updates are scheduled with `async_track_point_in_time` at each
transition. No polling loop.

## 8. Events

Fire on the HA event bus:

- `ha_tides_plus_high_tide` at each high-tide knot.
- `ha_tides_plus_low_tide` at each low-tide knot.

Payload:

```json
{
  "station_id": "8467150",
  "station_name": "Bridgeport, CT",
  "height": 3.12,
  "unit": "m",
  "next_high": "2026-09-12T04:15:00-04:00",
  "next_low": "2026-09-11T22:03:00-04:00"
}
```

Users can trigger on the event, or on the `next_*_tide` timestamp sensor.
Both work; events are lower-latency.

## 9. Config flow

Step 1 — station:

- Text input for station ID.
- Link to `https://tidesandcurrents.noaa.gov/tide_predictions.html`.
- Validate by fetching station metadata. Reject if the station does not
  support tide predictions.
- Show name and coordinates for confirmation.

Options flow:

- Units: `metric` / `imperial`. Default follows HA config.
- Interpolation source: `hilo` (default) or `6min`.
- Extremum hold window in minutes (default 10).
- Datum (default `MLLW`).

## 10. Testing

- Unit tests for PCHIP against known analytical curves. Assert derivative
  is 0 at each knot.
- Unit tests for the state-machine transitions with `freeze_time`.
- Unit tests for event scheduling.
- Coordinator tests with saved CO-OPS JSON fixtures. No live API calls in
  CI.
- End-to-end tests with `pytest-homeassistant-custom-component`.

## 11. Distribution

Recommendation: ship first as a HACS custom component under a new domain,
`ha_tides_plus`.

- Fast iteration. No HA core review cycle.
- The user installs via HACS → Custom repositories.
- Once the design is stable, propose an upstream rewrite of the existing
  `noaa_tides` domain, with a migration path from the legacy YAML sensor.

Trade-off: two domains coexist for a while. Users who move from the legacy
integration re-add their station in the new one. Acceptable given the
legacy integration has a single text sensor and few users.

Backwards compatibility with the legacy `noaa_tides` entities is
explicitly out of scope for v1. Both integrations can run side-by-side.
The compat shim (YAML import via `SOURCE_IMPORT`, preserved
`unique_id = "<station>_summary"`, preserved state-string format and
attribute names) is deferred to the eventual upstream PR against
`homeassistant/core`, where it is load-bearing for review acceptance.

## 12. Open questions

- Confirm `interval=6` coverage matches `interval=hilo` at all stations.
- Do subordinate stations return usable `interval=6` data, or only
  reference-station corrections? Test on 2-3 subordinate stations.
- Attribution wording required by NOAA. Reuse the legacy string
  `"Data provided by NOAA"`.
- Do we expose a `tide_curve` attribute (the next 48 h as a list of
  points) for card use, or leave graphing to the recorder? Attribute is
  handy but bloats the state machine. Leaning toward: no attribute; use
  a template sensor or a Lovelace card that samples the height sensor.
