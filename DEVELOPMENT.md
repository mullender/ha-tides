# Development setup

How to build, run, and debug the `noaa_tides_plus` custom integration.

## 1. Prerequisites

- macOS 13+ or Linux.
- Python 3.13. Match the version that current Home Assistant Core ships
  with. Check the HA `pyproject.toml` if in doubt.
- Docker Desktop, OrbStack, or Colima.
- VS Code with the "Python" and "Dev Containers" extensions.
- `git` and a GitHub account.
- Optional: `uv` or `pipx` for a faster local Python setup.

## 2. Repository layout

```
ha_tides/
  custom_components/
    noaa_tides_plus/
      __init__.py
      manifest.json
      config_flow.py
      const.py
      coordinator.py
      sensor.py
      interpolation.py         # PCHIP + state machine
      strings.json
      translations/
        en.json
  tests/
    conftest.py
    fixtures/
      hilo_bridgeport_7d.json
    test_coordinator.py
    test_interpolation.py
    test_sensor.py
  .devcontainer/
    devcontainer.json
    Dockerfile
  .vscode/
    launch.json
    settings.json
  ha_config/                    # gitignored; per-dev HA config
  docker-compose.yml
  hacs.json
  pyproject.toml
  requirements_test.txt
  README.md
  DESIGN.md
  DEVELOPMENT.md
```

`ha_config/` holds the running HA config. Keep it out of git. Put a
`.gitignore` entry for it.

## 3. Fast path: HA in Docker with the component mounted

This is the primary loop. HA runs in a container. The custom component
lives on the host and is mounted read-write into the container. Code
changes take effect after an integration reload; no rebuild needed.

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

Open `http://localhost:8123`. Create the first user. Go to
Settings → Devices & Services → Add Integration → search "NOAA Tides
Plus".

Reload the integration after code changes:

- UI: Settings → Devices & Services → the entry → "..." → Reload.
- CLI (faster for iterative work):

```
docker exec ha_dev hass --script check_config -c /config
```

For changes to `manifest.json`, `config_flow.py`, or new entities,
restart the container:

```
docker compose restart homeassistant
```

## 4. Debugging with VS Code

Enable the `debugpy` integration in `ha_config/configuration.yaml`:

```yaml
debugpy:
  wait: false
  port: 5678
  host: 0.0.0.0
```

Restart HA once for the change to take effect.

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

Set breakpoints in `custom_components/noaa_tides_plus/*.py`. Attach the
debugger. Trigger the code path by reloading the integration or waiting
for the coordinator refresh. Set `wait: true` in the `debugpy` config if
you need to catch startup code.

`justMyCode: false` lets you step into HA core code, which is useful when
tracking down coordinator or config-flow behaviour.

## 5. Logging

`ha_config/configuration.yaml`:

```yaml
logger:
  default: warning
  logs:
    custom_components.noaa_tides_plus: debug
```

Tail:

```
docker compose logs -f homeassistant
```

For a shorter feedback loop, `grep` for the integration domain:

```
docker compose logs -f homeassistant | grep noaa_tides_plus
```

## 6. Devcontainer alternative (heavier)

Use this only if you need to step into HA core sources or modify HA core.

- Clone `https://github.com/home-assistant/core` next to `ha_tides`.
- Open `core/` in VS Code. Reopen in devcontainer.
- Bind-mount `ha_tides/custom_components/noaa_tides_plus` into
  `core/config/custom_components/noaa_tides_plus`.
- Start HA from the devcontainer task list: `Run Home Assistant Core`.

Trade-off: larger image, slower boot, but full source access.

## 7. Unit tests

`requirements_test.txt`:

```
pytest
pytest-asyncio
pytest-homeassistant-custom-component
freezegun
respx
numpy
```

Local venv (no Docker needed for tests):

```
python -m venv .venv
source .venv/bin/activate
pip install -r requirements_test.txt
pytest tests/ -v
```

Test guidelines:

- Never hit the live NOAA API in tests. Save JSON responses under
  `tests/fixtures/`. Use `respx` or the `aioclient_mock` fixture to
  intercept HTTP calls.
- Freeze time with `freezegun` for extremum-scheduling tests.
- Assert on the coordinator's public state, not on internal attributes.

## 8. Linting and formatting

Match HA core conventions:

```
pip install ruff mypy
ruff check custom_components/ tests/
ruff format custom_components/ tests/
mypy custom_components/noaa_tides_plus
```

Add a pre-commit hook if you want automatic runs on `git commit`.

## 9. HACS distribution

`hacs.json` at the repo root:

```json
{
  "name": "NOAA Tides Plus",
  "render_readme": true,
  "homeassistant": "2025.1.0",
  "content_in_root": false
}
```

`manifest.json` (`custom_components/noaa_tides_plus/manifest.json`):

```json
{
  "domain": "noaa_tides_plus",
  "name": "NOAA Tides Plus",
  "version": "0.1.0",
  "codeowners": ["@mullender"],
  "config_flow": true,
  "documentation": "https://github.com/mullender/ha_tides",
  "iot_class": "cloud_polling",
  "issue_tracker": "https://github.com/mullender/ha_tides/issues",
  "requirements": []
}
```

Publish:

- Push the repo to GitHub, public.
- Tag a release: `git tag v0.1.0 && git push --tags`.
- In HA: HACS → Integrations → three-dot menu → Custom repositories →
  paste the repo URL, category "Integration".
- Install → Restart HA → add via Settings → Devices & Services.

## 10. NOAA API notes

- Base URL: `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`
- No API key. Set `application=noaa_tides_plus` on every call — NOAA asks
  for this for traffic attribution.
- Rate limits are not published. One call per 12 h per station is well
  under any reasonable limit. Back off with exponential retry on HTTP 5xx.
- Sample hi/lo call for testing:

```
https://api.tidesandcurrents.noaa.gov/api/prod/datagetter
  ?product=predictions
  &application=noaa_tides_plus
  &begin_date=20260911
  &range=168
  &datum=MLLW
  &station=8467150
  &time_zone=lst_ldt
  &units=metric
  &format=json
  &interval=hilo
```

- Station metadata:

```
https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions
```

Attribution string: `"Data provided by NOAA"`. Set
`_attr_attribution` on each entity.

## 11. Common issues

| Symptom | Cause | Fix |
|---|---|---|
| Debugger will not attach | `debugpy` port not exposed | Confirm `5678` in `docker-compose.yml` ports and in `configuration.yaml`. |
| Config flow does not appear | Cached HA UI | Hard-refresh browser; clear service worker. |
| Reload does not pick up changes | Change touched `manifest.json` or config flow | Restart the container. |
| `station_id does not exist` on setup | Wrong ID or non-prediction station | Verify via the `stations.json` metadata URL. |
| Times off by hours in the UI | Wrong `TZ` env in Docker | Set `TZ` in `docker-compose.yml` to your local zone. |

## 12. Suggested first commits

1. Skeleton: `manifest.json`, `__init__.py`, empty `config_flow.py`,
   registration only.
2. Config flow with station validation against `stations.json`.
3. Coordinator with hi/lo fetch and 12 h refresh; log the parsed series.
4. `sensor.next_high_tide` and `sensor.next_low_tide` as timestamp
   sensors, plus their height siblings.
5. PCHIP interpolation module and `sensor.tide_height`.
6. State machine and `sensor.tide_state`.
7. Extremum events on the bus.
8. Options flow for units, interval, and hold window.
9. Test fixtures and unit tests.
10. README, HACS metadata, first tag.
