# Brand assets

Design source and pre-rendered variants of the Tides Plus brand icon.

| File | Size | Purpose |
|---|---|---|
| `icon.svg` | vector | Design reference; browsers render fine, ImageMagick's SVG backend does not |
| `render_icon.py` | script | Authoritative rasterizer (draws with PIL; ImageMagick is unreliable on stroked paths) |
| `icon.png` | 256×256 | Home Assistant brand icon (submit to `home-assistant/brands`) |
| `icon@2x.png` | 512×512 | Home Assistant brand icon, 2× |
| `logo.png` | 256×256 | Home Assistant brand logo variant (same asset for now) |
| `logo@2x.png` | 512×512 | Home Assistant brand logo variant, 2× |
| `favicon.png` | 32×32 | Favicon for future GitHub Pages / docs site |

## Rebuild

Requires Pillow, which the running HA container already has:

```
docker cp brands/render_icon.py ha_dev:/tmp/render_icon.py
docker exec ha_dev sh -c 'rm -rf /tmp/icons && python3 /tmp/render_icon.py /tmp/icons'
docker cp ha_dev:/tmp/icons/. brands/
```

## Getting the icon into Home Assistant's UI

Home Assistant's integration list is served from
[`home-assistant/brands`](https://github.com/home-assistant/brands) via the
brands proxy API (`https://brands.home-assistant.io/_/<domain>/icon.png`).
Custom integrations do not ship icons in-repo.

To register these assets:

1. Fork `home-assistant/brands`.
2. Add the four PNGs under `custom_integrations/noaa_tides_plus/`:
   - `icon.png`, `icon@2x.png`, `logo.png`, `logo@2x.png`
3. Open a PR. Once merged, Home Assistant clients pick up the new icon
   automatically on their next brand-cache refresh.
