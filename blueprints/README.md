# Blueprints

Automation blueprints shipped with the integration. Install any of them
via the HA UI: **Settings → Automations & scenes → Blueprints → Import
blueprint** and paste the raw-file URL.

| Blueprint | Description | Import URL |
|---|---|---|
| Tide extreme alert (crosses threshold) | Runs once a day at your chosen time and notifies you if the next matching high or low within a lookahead window crosses a threshold. Pick a Tides Plus station and a direction (below → watches next_low_tide, above → watches next_high_tide); paired sensors are inferred. Optional sun-aware daylight filter checks the event's own timestamp. | `https://raw.githubusercontent.com/mullender/ha-tides/main/blueprints/automation/ha_tides_plus/tide_extreme_alert.yaml` |

## Adding your own

Drop new YAMLs under `blueprints/automation/ha_tides_plus/`. Follow the
[HA blueprint schema][1]. Users can then import via the raw GitHub URL
of your file.

[1]: https://www.home-assistant.io/docs/blueprint/schema/
