# Home Assistant automatic card import: investigation

Date: 2026-09-15

## Original question

> deep investigation into addressing the automatic-import failure of HA which causes the configuration error to be shown.

## Problem statement

A normal cached reload of a Home Assistant dashboard can show six
`Custom element doesn't exist` configuration errors for the Tides Plus
cards. A reload with the browser cache disabled loads the same cards.
The automatic import must register four custom elements before the
dashboard creates the cards.

## Confirmed facts

### 1. Home Assistant injects the card as an extra module

- The integration registers the static files and calls
  `add_extra_js_url()` in
  [`custom_components/ha_tides_plus/__init__.py`](../custom_components/ha_tides_plus/__init__.py#L58).
- Home Assistant 2026.10.0.dev202609120226 renders separate dynamic
  imports for its app bundle and the Tides Plus module. The generated
  page does not wait for the app import before it starts the card import.
- This was verified from the HTML returned by
  `http://localhost:8123/test-tides/0`.

### 2. The card registers before Home Assistant replaces the registry

- On a cached load, all four Tides Plus elements registered at 64 ms.
- Home Assistant replaced `window.customElements` at 106 ms.
- The old registry contained the four Tides Plus definitions. The new
  registry did not contain them.
- A second trace registered the elements at 26 ms and replaced the
  registry at 64 ms. It produced the same result.
- The card registration code is in
  [`tides-plus-card.js`](../custom_components/ha_tides_plus/frontend/tides-plus-card.js#L1269).

### 3. Home Assistant installs a scoped custom-element registry

- The installed Home Assistant frontend bundle is
  `home-assistant-frontend 20260912.0.dev0`.
- Its `app.5c8351542151c8fb.js` bundle assigns a new
  `CustomElementRegistry` to `window.customElements`.
- Its source map identifies the implementation as
  `@webcomponents/scoped-custom-element-registry/src/scoped-custom-element-registry.ts`.

### 4. The failure does not report a JavaScript exception

- Chrome reported no runtime exception and no rejected automatic import.
- `window.customCards` still contained both Tides Plus metadata entries.
- `customElements.get("tides-plus-card")` and
  `customElements.get("tides-plus-summary-card")` returned no value.
- This shows that the module completed registration against the old
  registry before Home Assistant replaced it.

### 5. Cache timing changes the result

- With the cache disabled, Home Assistant replaced the registry at
  58 ms. The card registered at 59 ms against the new registry.
- Both custom elements then remained available and the cards rendered.
- With the cache enabled, the card usually registered 15 to 40 ms before
  the replacement and then disappeared.

### 6. Cached module bytes are correct

- The cached card response and the repository file both had SHA-256
  `bb15dfa6b155706cfaee3d5867896d21d40de986f8af4fdf89fb3d923fae6af2`.
- The cached response had status 200 and content type
  `text/javascript`.
- A manual import with a new query value registered the elements after
  Home Assistant startup.

### 7. Re-registration repairs the failure

- The same four constructors can be registered in the replacement
  registry.
- New card instances are valid `HTMLElement` instances and create their
  shadow roots.
- Three cached reload tests watched for the registry replacement and
  registered the constructors again.
- All three tests rendered five chart cards and one summary card. None
  rendered a configuration-error card or reported a JavaScript error.
- After the guard was added to the card source, three normal cached
  reloads and one cache-bypassed reload produced the same successful
  result without a browser-side test hook.

### 8. Asset versioning is independent

- Commit `5f87399` adds
  `?v=<manifest-version>-<combined-content-hash>` to the card URL.
- The hash covers `tides-plus-card.js` and `apexcharts.min.js` in
  [`__init__.py`](../custom_components/ha_tides_plus/__init__.py#L48).
- The card passes the same value to ApexCharts in
  [`tides-plus-card.js`](../custom_components/ha_tides_plus/frontend/tides-plus-card.js#L44).
- Home Assistant stores both assets in its `file-cache` by URL.
- A versioned card can still lose the registry race when its cached
  response completes before the Home Assistant app bundle.

## Relevant architecture

1. Home Assistant renders its page shell.
2. The page starts the Home Assistant app import.
3. A separate inline script starts the Tides Plus import without waiting
   for the app import.
4. The Tides Plus module defines four custom elements.
5. The Home Assistant app installs the scoped-registry polyfill and
   replaces the global registry.
6. The dashboard asks the replacement registry for the Tides Plus tags.
7. Home Assistant displays configuration errors because the replacement
   registry does not contain them.

## Timeline

| Date | Event | Impact |
|---|---|---|
| 2026-09-12 | Installed development frontend was built | The tested bundle contains the scoped-registry polyfill. |
| 2026-09-15 | Normal and cache-disabled reloads were compared | Cache timing was linked to the failure. |
| 2026-09-15 | Registry identity was traced from page start | The registry replacement was confirmed. |
| 2026-09-15 | Re-registration was tested three times | The integration-level repair was confirmed. |
| 2026-09-15 | The source guard was tested with cached and cache-bypassed reloads | All configured cards rendered without configuration errors. |

## Things excluded

| Theory | Why it is excluded |
|---|---|
| The service worker generated a corrupt module | The cached response hash exactly matched the repository file. |
| The browser used an old card file | The cached response contained the current versioned source and matching hash. |
| The card has a parse or startup exception | The module registered all four elements and reported no exception before the registry replacement. |
| ApexCharts caused card registration to fail | Custom-element registration occurs before ApexCharts is loaded. |
| The version query alone fixes the error | The versioned module still failed when it won the startup race. |
| The fixed chart row count caused this configuration error | The row count causes visual overlap after registration. It cannot cause a missing custom element. |
