<p align="center">
  <img src="brands/icon.png" alt="Tides Plus" width="128" height="128">
</p>

<h1 align="center">Tides Plus (USA, NOAA)</h1>

Home Assistant custom integration for NOAA tide predictions.

Domain: `noaa_tides_plus`. Distributed via HACS.

See [`DESIGN.md`](DESIGN.md) for architecture and [`DEVELOPMENT.md`](DEVELOPMENT.md)
for the dev loop.

## Quick start (development)

```
docker compose up -d
docker compose logs -f homeassistant
# open http://localhost:8123
```

`ha_config/` holds a seed `configuration.yaml` that enables `debugpy` on
port 5678 and turns on debug logging for the integration. First boot
takes ~30 s to install HA and generate the config; subsequent boots are
fast.
