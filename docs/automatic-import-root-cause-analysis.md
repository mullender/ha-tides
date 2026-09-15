# Home Assistant automatic card import: root-cause analysis

Date: 2026-09-15

## Executive summary

The failure is a verified startup race. Home Assistant imports its app
bundle and extra card modules in parallel. Tides Plus can register in the
original custom-element registry before the Home Assistant scoped-registry
polyfill replaces that registry. The dashboard then uses the new registry
and reports that the card elements do not exist.

Browser caching changes which import finishes first. It exposes the race,
but it does not corrupt the card file.

## Root cause: registry replacement after card registration

### Smoking gun

A browser trace recorded this order during a failing cached load:

1. Tides Plus registered all four tags at 64 ms.
2. Home Assistant replaced `window.customElements` at 106 ms.
3. The replacement registry did not contain the Tides Plus tags.
4. The dashboard produced `Custom element doesn't exist` errors.

The Home Assistant app bundle contains this effective operation:

```js
Object.defineProperty(window, "customElements", {
  value: new CustomElementRegistry(),
  configurable: true,
  writable: true,
});
```

This code comes from the scoped custom-element-registry polyfill.

## Causal chain

1. `add_extra_js_url()` adds a dynamic card import to the generated page.
2. Home Assistant also starts its main app import.
3. The two imports run in parallel.
4. A cached Tides Plus module finishes first and registers its elements.
5. The Home Assistant app loads the scoped-registry polyfill.
6. The polyfill replaces the global custom-element registry.
7. The dashboard checks the replacement registry.
8. The check fails and Home Assistant creates configuration-error cards.

## How the cause explains every fact

| Fact | Explanation |
|---|---|
| Cached reloads fail | The cached card finishes before the larger app bundle. |
| Cache-disabled reloads work | The card finishes after the app installs the final registry. |
| No exception appears | Registration succeeds against a valid registry. That registry is replaced later. |
| Card metadata remains | Replacing `window.customElements` does not replace `window.customCards`. |
| Manual late imports work | They register against the final registry. |
| Cached bytes match the source | File contents do not cause the failure. Completion order causes it. |
| Re-registration works | It puts the existing constructors into the registry that the dashboard uses. |
| A version query does not fix the race | A versioned response can still finish before the app bundle. |

## Verification status

| Claim | Status | Evidence |
|---|---|---|
| Home Assistant replaces the global registry | Verified | Registry identity trace and installed app bundle. |
| The card registers before replacement on failing loads | Verified | Two instrumented cached-load traces. |
| The card registers after replacement on working loads | Verified | Cache-disabled trace: replacement at 58 ms and registration at 59 ms. |
| Cached card bytes are malformed | Disproved | Cached and repository SHA-256 values match. |
| Re-registration repairs the dashboard | Verified | Three cached reloads rendered all six configured cards without errors. |
| Home Assistant should serialize extra imports upstream | Recommended, not verified upstream | It removes the race but requires a Home Assistant frontend change. |

## Implemented fix

### Integration fix

Keep one function that registers all four Tides Plus elements. Register
them when the module loads. While Home Assistant is still starting, watch
for a change to the `window.customElements` object. If it changes, call the
same registration function against the new registry and stop watching.

This approach has these properties:

- It preserves current behavior when the card loads after Home Assistant.
- It does not fetch or evaluate the module twice.
- It repairs the early cached-load case before the dashboard creates its
  cards.
- It worked in three cached reload tests against the installed frontend.

The source implementation also passed three normal cached reloads and
one cache-bypassed reload without a browser-side test hook.

The watch must be short-lived. Stop it after Home Assistant registers its
root element or after the registry replacement occurs.

### Keep asset versioning

Keep commit `5f87399`. Asset versioning and re-registration have separate
purposes:

- Re-registration fixes the custom-element registry race.
- Asset versioning makes each released card and ApexCharts bundle use a
  new service-worker cache key.

Removing versioning would make upgrades depend on Home Assistant's
stale-while-revalidate behavior. A user could receive the old module on
the first reload and need another reload or a manual cache clear. The
small versioning cost is justified.

### Upstream fix

Home Assistant should finish its app bootstrap and scoped-registry setup
before it imports extra modules. This removes the race for every custom
integration that uses `add_extra_js_url()`.

The integration guard is still useful until the affected Home Assistant
versions are no longer supported.
