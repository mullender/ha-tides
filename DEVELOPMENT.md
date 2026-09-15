# Development setup

How to build, run, and debug the `ha_tides_plus` custom integration.

## 1. Prerequisites

- macOS 13+ or Linux.
- Docker Desktop, OrbStack, or Colima. (Colima is what this repo has
  been developed on; see the `docker context ls` hint in section 11 if
  you already have Docker Desktop configured.)
- Node.js 20+ (only needed if you drive Chrome through the `rodney`
  CLI or the Meta `browser` CLI for UI testing — see section 8).
- VS Code with the "Python" and "Dev Containers" extensions.
- `git` and a GitHub account.

Python is not needed on the host — the HA container ships Python 3.14
and Pillow, which is enough for running the code and re-rendering the
brand icon.

## 2. Repository layout

```
ha_tides/
  custom_components/
    ha_tides_plus/
      __init__.py               # async_setup + async_setup_entry, WS + card registration
      manifest.json
      config_flow.py            # provider picker + station picker (ZIP / place / direct-ID)
      const.py
      coordinator.py            # DataUpdateCoordinator, ±7-day cache, 12h refresh
      providers/                # tide-source implementations
        __init__.py             # registry: {"noaa": NoaaProvider, "rws": RwsProvider}
        base.py                 # Provider ABC + Station / TideExtremum dataclasses
        noaa.py                 # NOAA CO-OPS client
        rws.py                  # Rijkswaterstaat DDAPI 2.0 client
      geocode.py                # zippopotam.us + Nominatim
      helpers.py                # format_device_name, haversine_km
      interpolation.py          # PCHIP + tide_state derivation
      sensor.py                 # 10 sensors per station + extrema attribute
      events.py                 # ExtremumEventScheduler (bus events)
      websocket_api.py          # ha_tides_plus/hilo_series, /list_stations
      strings.json
      translations/en.json
      brand/                    # icon.png + @2x + logo + dark variants (HA 2026.3+)
      frontend/
        tides-plus-card.js      # chart + summary cards, PCHIP JS port
        apexcharts.min.js       # bundled charting library
  blueprints/automation/ha_tides_plus/
    tide_extreme_alert.yaml
  brands/                       # design source (SVG + PIL renderer)
  docs/
    providers.md                # how-to for adding a new provider
    screenshots/                # README screenshots
  ha_config/                    # gitignored; per-dev HA config + storage
  docker-compose.yml
  hacs.json
  README.md · DESIGN.md · DEVELOPMENT.md · IDEAS.md
```

`ha_config/` is gitignored; it holds the running HA config (auth,
lovelace, blueprints, storage). Seeded on first boot from
`configuration.yaml`.

## 3. Fast path: HA in Docker with the component mounted

Primary loop: HA runs in a container, the custom component and blueprint
directories are bind-mounted from the host, so most code changes take
effect on integration reload without a container restart.

`docker-compose.yml`:

```yaml
services:
  homeassistant:
    image: ghcr.io/home-assistant/home-assistant:dev
    container_name: ha_dev
    volumes:
      - ./ha_config:/config
      - ./custom_components:/config/custom_components
    ports:
      - "8123:8123"
      - "5678:5678"       # debugpy
    environment:
      - TZ=America/New_York
    restart: unless-stopped
```

First run:

```
mkdir -p ha_config
docker compose up -d
docker compose logs -f homeassistant
```

Open <http://localhost:8123>, complete first-user onboarding, then
**Settings → Devices & Services → Add Integration → *Tides Plus***.
Pick a provider (NOAA for US stations, Rijkswaterstaat for NL). Empty
query uses your HA-home coords; type a ZIP, place, or native station
ID to pick specifically.

## 4. Reload cadence

- **Sensor or coordinator code change** — Settings → Devices & Services
  → the entry → "..." → *Reload*. No container restart.
- **`manifest.json`, `config_flow.py`, or new entities** —
  `docker compose restart homeassistant`.
- **Frontend (`frontend/*.js`)** — hard-refresh the browser
  (Cmd/Ctrl-Shift-R). Chrome DevTools with *Disable cache* on the
  Network tab is a huge time saver; without it the SPA holds onto the
  cached module.
- **Blueprint YAML** — `Developer tools → Services → automation.reload`,
  or use the UI's blueprint import re-run.

## 5. Debugging with VS Code

`configuration.yaml` in `ha_config/` seeds `debugpy` on 5678 and debug
logging on the integration. Attach from VS Code:

`.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Attach to Home Assistant",
      "type": "python",
      "request": "attach",
      "port": 5678,
      "host": "localhost",
      "pathMappings": [
        {
          "localRoot": "${workspaceFolder}/custom_components",
          "remoteRoot": "/config/custom_components"
        }
      ],
      "justMyCode": false
    }
  ]
}
```

`justMyCode: false` lets you step into HA core. Set `wait: true` in the
`debugpy` config in `configuration.yaml` if you need to catch startup
code.

## 6. Logging

`ha_config/configuration.yaml`:

```yaml
logger:
  default: warning
  logs:
    custom_components.ha_tides_plus: debug
```

Tail: `docker compose logs -f homeassistant`. Filter:
`docker compose logs -f homeassistant | grep ha_tides_plus`.

## 7. Frontend / card development

The two custom elements (`tides-plus-card`, `tides-plus-summary-card`)
are hand-written vanilla JS — no build step. Edit
`custom_components/ha_tides_plus/frontend/tides-plus-card.js` and
hard-refresh the browser.

- ApexCharts is bundled at
  `custom_components/ha_tides_plus/frontend/apexcharts.min.js` and
  loaded on demand the first time a chart card renders. Updating the
  version means dropping in a new file from jsdelivr:

  ```
  curl -sL https://cdn.jsdelivr.net/npm/apexcharts@<version>/dist/apexcharts.min.js \
    -o custom_components/ha_tides_plus/frontend/apexcharts.min.js
  ```

- Card and summary auto-load via `add_extra_js_url` in `async_setup`.
  No HACS-frontend install is needed on the user side.

- The card element carries an `_updateLegend(cursorTime)` method that
  the ApexCharts `tooltip.custom` callback fires on every plot-area
  hover; the built-in apex tooltip is disabled so nothing covers the
  graph.

## 8. Driving the running HA from the CLI

Two CLIs used during dev to inspect the browser state without leaving
the terminal:

- `rodney` — connect to an existing Chrome session on
  `localhost:9222` and drive it. Useful for `rodney js '(fn)()'` to run
  JS in the frontend context (e.g. querying `hass.states`, calling
  `hass.callWS`, or clicking through a dashboard). Chrome must be
  launched with `--remote-debugging-port=9222` and Rodney called with
  `rodney connect localhost:9222` once per session.
- Meta `browser` CLI — heavier, works over CDP too. Rodney has been the
  more reliable of the two during development.

`docker exec ha_dev python3 -c '…'` is the fast way to run HA-context
Python — importing `homeassistant.util.yaml.loader.load_yaml` to
parse-check blueprint YAMLs, or importing the integration modules
directly and hitting the mdapi.

Provider modules avoid HA imports, so you can also smoke-test them
against the live upstream from a plain venv:

```
python3 -m venv /tmp/hatv && /tmp/hatv/bin/pip install aiohttp
/tmp/hatv/bin/python - <<'PY'
import asyncio, sys, importlib.util, types
from pathlib import Path
root = Path('custom_components/ha_tides_plus/providers')
pkg = types.ModuleType('providers'); pkg.__path__ = [str(root)]; sys.modules['providers'] = pkg
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec); sys.modules[name] = m
    spec.loader.exec_module(m); return m
sys.modules['providers.base'] = load('providers.base', root / 'base.py')
rws = load('providers.rws', root / 'rws.py')
import aiohttp
from datetime import datetime, timedelta, UTC
async def main():
    async with aiohttp.ClientSession() as s:
        p = rws.RwsProvider()
        knots = await p.get_hilo_predictions(s, 'scheveningen', begin=datetime.now(UTC), hours=48)
        for k in knots: print(k)
asyncio.run(main())
PY
```

The `sys.modules` prelude is only needed because
`ha_tides_plus/__init__.py` pulls in `homeassistant.*` on import — the
provider modules themselves import only `aiohttp` and stdlib.

## 9. Testing (not shipped yet)

Planned:

```
pytest
pytest-asyncio
pytest-homeassistant-custom-component
freezegun
respx
numpy
```

Guidelines when the suite lands:

- Never hit a live provider API in tests. Save JSON responses under
  `tests/fixtures/<provider>/`.
- Freeze time with `freezegun` for extremum-scheduling tests.
- Assert on the coordinator's public state and on the WebSocket API
  responses, not on internal attributes.

## 10. HACS metadata

`hacs.json` at repo root:

```json
{
  "name": "Tides Plus",
  "render_readme": true,
  "homeassistant": "2025.1.0",
  "content_in_root": false
}
```

`manifest.json` inside `custom_components/ha_tides_plus/` declares
`domain`, `version`, `codeowners`, `config_flow: true`,
`iot_class: cloud_polling`, and no external requirements.

Publish path:

1. Tag a release: `git tag v0.x.0 && git push --tags`.
2. HA users install via HACS → *Custom repositories* → paste
   `https://github.com/mullender/ha-tides`, category *Integration*.

## 11. Provider API notes

### 11.1 NOAA CO-OPS (USA)

- Base URL:
  `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`
- No API key. Every call must set `application=ha_tides_plus` per NOAA
  attribution guidance.
- Rate limits are unpublished. One call per 12 h per station is well
  under any reasonable limit.
- Reference stations set `tidal: true`; subordinate stations don't set
  that field but carry `type: "S"` and a `reference_id`. Both types
  return usable predictions.
- Time zone: we always request `time_zone=gmt` and parse to UTC-aware
  datetimes; HA converts to the user's zone on display.

Sample:

```
https://api.tidesandcurrents.noaa.gov/api/prod/datagetter
  ?product=predictions
  &application=ha_tides_plus
  &begin_date=20260911
  &range=168
  &datum=MLLW
  &station=8467150
  &time_zone=gmt
  &units=metric
  &format=json
  &interval=hilo
```

Attribution string: `"Data provided by NOAA"`, exposed via the
`NoaaProvider.attribution` class attribute.

### 11.2 Rijkswaterstaat (NL)

- Base URL: `https://ddapi20-waterwebservices.rijkswaterstaat.nl`
  (the ddapi20 subdomain — the older `waterwebservices.` host now
  redirects to a migration page).
- OpenAPI spec: `/webservices-api-docs`.
- No API key. All calls are POST with a JSON body.
- Catalogue (`POST /METADATASERVICES/OphalenCatalogus`, body
  `{"CatalogusFilter":{"Grootheden":true,"Parameters":true,"Compartimenten":true,"Hoedanigheden":true,"Eenheden":true,"MeetApparaten":true}}`)
  returns 2499 locations and 3426 aquo-metadata entries.
- Predictions (`POST /ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen`)
  returns three parallel time series for a WATHTE query — observed,
  weather-forecast, and astronomic. The provider picks the entry whose
  `Parameter_Wat_Omschrijving` contains `astronomisch`.
- Reference plane: NAP for coastal stations, MSL for offshore. The
  provider tries NAP first, falls back to MSL on empty result.
- Time zone: request/response uses ISO 8601 with tz offsets; the
  provider parses to UTC-aware.
- Cross-reference source that helped: <https://github.com/physje/waterinfo>.

Sample body (Scheveningen astronomic tide, next 24 h):

```json
POST /ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen
{
  "AquoPlusWaarnemingMetadata": {
    "AquoMetadata": {
      "Compartiment": {"Code": "OW"},
      "Grootheid":    {"Code": "WATHTE"},
      "Hoedanigheid": {"Code": "NAP"}
    }
  },
  "Locatie": {"X": 4.263563, "Y": 52.099035, "Code": "scheveningen"},
  "Periode": {
    "Begindatumtijd": "2026-09-14T00:00:00.000+00:00",
    "Einddatumtijd":  "2026-09-15T00:00:00.000+00:00"
  }
}
```

Attribution string: `"Data provided by Rijkswaterstaat"`, exposed via
`RwsProvider.attribution`.

## 12. Common issues

| Symptom | Cause | Fix |
|---|---|---|
| Debugger will not attach | `debugpy` port not exposed | Confirm `5678` in `docker-compose.yml` ports and in `configuration.yaml`. |
| Config flow does not appear | Cached HA UI | Hard-refresh browser; clear service worker. |
| Reload does not pick up changes | Change touched `manifest.json` or config flow | Restart the container. |
| Card renders as "Configuration error" | Stale JS in browser cache OR `customElements.define` collided with a hot-reloaded module | Enable *Disable cache* in DevTools → Network; the code already guards `define` with a `customElements.get()` check. |
| Chart hover does not update the legend | ApexCharts `chart.events.mouseMove` fires only with a valid `dataPointIndex` — we use `tooltip.custom` instead and return an empty tooltip. If broken, verify the config still has that block. |
| `station_id does not exist` on setup | Wrong ID or non-prediction station | Verify via the `stations.json` metadata URL. |
| Docker socket errors after Docker Desktop uninstall | Stale `~/.docker/config.json` credential store | `export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock` (Colima) or remove the `credsStore` key from `config.json`. |
