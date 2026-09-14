# Brand assets

Design source for the Tides Plus brand icon. Rendered PNGs are
committed under `custom_components/ha_tides_plus/brand/`, where Home
Assistant 2026.3+ serves them via
`/api/brands/integration/ha_tides_plus/<image>` — see the
[brands proxy API blog post][1].

[1]: https://developers.home-assistant.io/blog/2026/02/24/brands-proxy-api/

| File | Purpose |
|---|---|
| `icon.svg` | Vector design reference. Browsers render fine; ImageMagick's SVG backend does not, so PNGs come from `render_icon.py`. |
| `render_icon.py` | Authoritative rasterizer. PIL-based. |
| `favicon.png` | 32×32 favicon for future GitHub Pages / docs site. |

## Rebuild

Requires Pillow, which the running HA container already has:

```
docker cp brands/render_icon.py ha_dev:/tmp/render_icon.py
docker exec ha_dev sh -c 'rm -rf /tmp/icons && python3 /tmp/render_icon.py /tmp/icons'
for f in icon.png icon@2x.png logo.png logo@2x.png; do
  docker cp "ha_dev:/tmp/icons/$f" "custom_components/ha_tides_plus/brand/$f"
done
docker cp ha_dev:/tmp/icons/favicon.png brands/favicon.png
```

## HA supported filenames

Home Assistant reads these names from
`custom_components/<domain>/brand/`:

- `icon.png` / `dark_icon.png`
- `logo.png` / `dark_logo.png`
- `icon@2x.png` / `dark_icon@2x.png`
- `logo@2x.png` / `dark_logo@2x.png`

Dark variants are optional. The current design (teal square, white
contents) works on both light and dark themes without a dedicated dark
asset.
