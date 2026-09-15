# How to add a tide-prediction provider

Tides Plus ships with two providers today — NOAA (USA) and
Rijkswaterstaat (NL). Adding a third takes one new Python file and a
one-line change to the registry. This page walks through the shape of
a provider, the data contract every provider must honour, and the two
existing providers as worked examples.

## What a provider is

A provider is a small class that hides one upstream tide-prediction
API behind three async methods. Everything downstream of the
coordinator (sensors, events, cards, WebSocket API, blueprints) is
provider-agnostic — it consumes the normalised
`TideExtremum(time, height, type)` list the provider returns and does
not care where it came from.

The abstraction lives in
[`custom_components/ha_tides_plus/providers/base.py`](../custom_components/ha_tides_plus/providers/base.py).

## The data contract

| Type | Field | Rule |
|---|---|---|
| `Station.id` | provider-native station identifier | Stable across sessions; used as the config-entry unique ID and part of the entity unique IDs. |
| `Station.name` | human-readable name | Shown in the device name and the config-flow picker. |
| `Station.lat`, `Station.lng` | WGS84 degrees | Used for nearest-station ranking in the config flow. |
| `Station.state` | US state code / NL province / … | Optional. `None` when the provider has no notion of a sub-national region. |
| `TideExtremum.time` | `datetime` | **UTC-aware**. |
| `TideExtremum.height` | `float` | **Metres above the provider's native datum**. HA converts to the user's preferred length unit at display time. |
| `TideExtremum.type` | `"H"` or `"L"` | High or low tide. |

The list returned from `get_hilo_predictions` is sorted by time and
covers the requested window. It's fine if the provider trims requests
that are longer than its upstream allows — the coordinator handles a
short window by not scheduling events past the last knot.

## The interface

Full ABC in [`providers/base.py`](../custom_components/ha_tides_plus/providers/base.py):

```python
class Provider(ABC):
    id: ClassVar[str]                 # "noaa", "rws", "shom", …
    label: ClassVar[str]              # "USA (NOAA)"
    attribution: ClassVar[str]        # shown on every entity
    manufacturer: ClassVar[str]       # shown in the HA device page

    @abstractmethod
    async def list_stations(self, session) -> list[Station]: ...

    @abstractmethod
    async def get_station(self, session, station_id: str) -> Station: ...

    @abstractmethod
    async def get_hilo_predictions(
        self, session, station_id: str, *,
        begin: datetime, hours: int,
    ) -> list[TideExtremum]: ...

    def station_url(self, station_id: str) -> str | None:
        """Browser URL for the station page. Used as ``DeviceInfo.configuration_url``."""
        return None

    def parse_direct_id(self, query: str) -> str | None:
        """If ``query`` is a bare, provider-native station ID, return it.
        Lets the config flow short-circuit the geocode + picker."""
        return None
```

Raise from `providers.base`:

- `UnknownStation` — the ID is not in your catalogue.
- `StationNotTidal` — the ID exists but has no tide predictions.
- `ApiError` — network / parse / upstream error.

## Worked example 1 — NOAA (USA)

[`providers/noaa.py`](../custom_components/ha_tides_plus/providers/noaa.py)
is a straight port of the pre-abstraction `api.py`.

- **Catalogue**: `GET /mdapi/prod/webapi/stations.json?type=tidepredictions`
  returns ~3500 stations. `list_stations` maps each entry to a `Station`.
- **Metadata**: `GET /mdapi/prod/webapi/stations/<id>.json?expand=details,products`
  validates one ID; reference stations set `tidal: true` and subordinate
  stations set `type: "S"` + `reference_id`. Both are accepted.
- **Predictions**: `GET /api/prod/datagetter` with `product=predictions`,
  `interval=hilo`, `units=metric`, `time_zone=gmt`, `datum=MLLW` returns
  one point per H/L knot over a ±7-day window. No parsing needed —
  the API already emits H/L knots.
- **Direct-ID shortcut**: NOAA IDs are 7-digit numeric strings.
  `parse_direct_id` matches on that shape.
- **Datum**: exposed via `NoaaProvider(datum="MLW")` so a future
  options flow can override the default without changing the class.

## Worked example 2 — Rijkswaterstaat (NL)

[`providers/rws.py`](../custom_components/ha_tides_plus/providers/rws.py)
is more work because RWS returns a raw 10-min time series rather than
pre-computed knots.

- **Catalogue**: `POST /METADATASERVICES/OphalenCatalogus` with the
  full aquo filter returns 2499 locations and 3426 aquo-metadata
  entries. Locations that publish astronomic tides are those linked to
  `AquoMetadata_MessageID = 2976` ("Getijextreemtype astronomisch in
  Oppervlaktewater"). That filter yields ~150 stations, all along the
  Dutch coast and estuaries. Scheveningen is one of them.
- **Predictions**: `POST /ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen`
  with the location's `Code`, WGS84 coords, and an aquo filter of
  `C=OW, G=WATHTE, H=NAP` returns three parallel series in one
  response — observed, weather-forecast, and astronomic — that we
  tell apart by scanning `Parameter_Wat_Omschrijving` for `astronomisch`.
- **H/L extraction**: the astronomic series arrives in centimetres
  above NAP (or MSL for offshore platforms) at 10-minute intervals.
  `_collapse_plateaus` merges equal-height runs (RWS quantises to
  whole cm, so plateaus of two or more samples are common at the top
  and bottom of every knot); a strict-inequality neighbour compare
  then identifies every local extremum. Peak times are refined with a
  three-point parabolic fit through the samples bracketing each knot.
- **NAP vs MSL**: coastal stations reference NAP; offshore platforms
  reference MSL. The provider tries NAP first and falls back to MSL if
  the first attempt returns no astronomic series.
- **Direct-ID shortcut**: RWS codes are lowercase dotted slugs
  (`scheveningen`, `scheveningen.1ehaven.voorhaven`). `parse_direct_id`
  accepts any non-space, non-numeric-first-segment string.

## Adding a new provider — checklist

1. Create `custom_components/ha_tides_plus/providers/<yourprovider>.py`.
2. Subclass `Provider` and implement the three abstract methods.
3. Set `id`, `label`, `attribution`, and `manufacturer` at class level.
4. If your provider has direct-ID input, override `parse_direct_id`.
5. Add per-station browser URLs by overriding `station_url` (optional).
6. Register your class in
   [`providers/__init__.py`](../custom_components/ha_tides_plus/providers/__init__.py)
   by appending it to `_REGISTRY`.
7. Restart HA. The config flow's provider-picker step now shows your
   entry automatically; no code changes elsewhere.

## Testing

The provider modules avoid Home Assistant imports so you can smoke-test
them from a plain Python venv:

```python
import asyncio
import aiohttp
from custom_components.ha_tides_plus.providers.rws import RwsProvider

async def main():
    async with aiohttp.ClientSession() as s:
        p = RwsProvider()
        stations = await p.list_stations(s)
        print(f"{len(stations)} stations")
        knots = await p.get_hilo_predictions(
            s, "scheveningen",
            begin=datetime.now(UTC),
            hours=48,
        )
        for k in knots:
            print(k)

asyncio.run(main())
```

For end-to-end tests against saved fixtures see the notes in
[`DEVELOPMENT.md`](../DEVELOPMENT.md).
