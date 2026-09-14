# Blueprints

Automation blueprints shipped with the integration. Install any of them
via the HA UI: **Settings → Automations & scenes → Blueprints → Import
blueprint** and paste the raw-file URL.

| Blueprint | Description | Import URL |
|---|---|---|
| Low-tide tidepool alert | Fires N minutes before an upcoming low tide when the low is at or below a threshold height AND the sun is above the horizon. | `https://raw.githubusercontent.com/mullender/ha-tides/main/blueprints/automation/ha_tides_plus/low_tide_tidepool_alert.yaml` |

## Adding your own

Drop new YAMLs under `blueprints/automation/ha_tides_plus/`. Follow the
[HA blueprint schema][1]. Users can then import via the raw GitHub URL
of your file.

[1]: https://www.home-assistant.io/docs/blueprint/schema/
