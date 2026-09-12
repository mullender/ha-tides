Post-MVP ideas

Setup ergonomics
- Default the station picker to the nearest NOAA station based on HA's configured latitude / longitude. Use the mdapi stations.json?type=tidepredictions list + a haversine ranking.
- Store the resolved station name, coordinates, and tideType in entry.data (or as a device attribute) so entity titles and dashboards stay meaningful even when offline.

Dashboards
- Ship a standard tides widget (custom Lovelace card): current height gauge, 48 h curve, next high/low with countdown. Bundled in the HACS repo under www/.

Automations
- Ship a blueprint for the most common patterns (e.g. "run when tide crosses X ft rising", "notify 30 min before next low tide") so users don't have to hand-roll templates.

Alerts
- Extreme-tide notifications: flag when the next high or low is within 10% of the yearly max/min. Requires fetching a wider window (annual harmonic predictions are cheap — one call, one JSON) and caching per-station stats.

Mobile
- iOS Live Activity via the HA Companion app: ongoing tide state on the lock screen with a live countdown to the next extremum.

Trailing "..." — a few natural neighbors you might have meant:
- Widget/complication on Apple Watch (piggybacks on Live Activity).
- Voice: Assist/Alexa response for "what time is the next high tide."
- Currents (slack/ebb/flood) as a v2 provider once the tide-only story is stable — was in the original DESIGN doc as out-of-scope for v1.
