"""Rijkswaterstaat (NL) tide-prediction provider.

Uses the DDAPI 2.0 endpoints (``ddapi20-waterwebservices.rijkswaterstaat.nl``)
that superseded ``waterwebservices.rijkswaterstaat.nl`` in 2025:

- ``POST /METADATASERVICES/OphalenCatalogus`` returns the station
  catalogue and the aquo-metadata axes (Grootheid, Compartiment,
  Hoedanigheid, …).
- ``POST /ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen`` returns a
  time series for one (location, aquo) pair over a date range. When we
  ask for ``WATHTE`` water height, the API returns three parallel series
  in one response — observed, weather-forecast, and astronomic — that
  we tell apart by their ``Parameter_Wat_Omschrijving`` string.

The astronomic series is a 10-minute-interval sinusoid; we walk it and
emit a ``TideExtremum`` at every sign change in the first derivative,
refining the peak time with a three-point parabolic fit.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import logging
from typing import Any, Literal

from aiohttp import ClientError, ClientSession

from .base import (
    ApiError,
    Provider,
    Station,
    StationNotTidal,
    TideExtremum,
    UnknownStation,
)

_LOGGER = logging.getLogger(__name__)

BASE_URL = "https://ddapi20-waterwebservices.rijkswaterstaat.nl"
CATALOG_URL = f"{BASE_URL}/METADATASERVICES/OphalenCatalogus"
WAARNEMINGEN_URL = f"{BASE_URL}/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen"

# Aquo cross-ref marker: locations that publish astronomic tide extrema
# are linked to "Getijextreemtype astronomisch in Oppervlaktewater".
_ASTRO_MARKER_MID = 2976

# Substrings we look for in ``Parameter_Wat_Omschrijving`` to pick the
# astronomic-tide series out of the three parallel WATHTE series RWS
# returns per location.
_ASTRO_DESC_TOKEN = "astronomisch"


class RwsProvider(Provider):
    """Rijkswaterstaat astronomic tide predictions (Netherlands).

    Heights are returned in metres above the station's native datum
    (Normaal Amsterdams Peil for coastal stations, Mean Sea Level for
    offshore platforms). Times are UTC.
    """

    id = "rws"
    label = "Netherlands (Rijkswaterstaat)"
    attribution = "Data provided by Rijkswaterstaat"
    manufacturer = "Rijkswaterstaat"

    def __init__(self) -> None:
        self._catalog: dict[str, Any] | None = None
        # ``list_stations`` result, keyed by lowercase station code.
        self._stations: dict[str, Station] | None = None

    def station_url(self, station_id: str) -> str | None:
        # RWS has no direct-URL station page — link to the general
        # waterinfo landing so users get context.
        return "https://waterinfo.rws.nl/"

    def parse_direct_id(self, query: str) -> str | None:
        # RWS codes are dot-separated slugs (e.g. ``scheveningen``,
        # ``vlissingen``, ``scheveningen.1ehaven.voorhaven``); accept any
        # bare word / dotted word as a candidate ID. The subsequent
        # ``get_station`` call validates against the catalogue.
        q = query.strip().lower()
        if q and " " not in q and not any(ch.isdigit() for ch in q.split(".")[0]):
            return q
        return None

    async def list_stations(self, session: ClientSession) -> list[Station]:
        if self._stations is None:
            catalog = await self._fetch_catalog(session)
            self._stations = _build_station_index(catalog)
        return list(self._stations.values())

    async def get_station(self, session: ClientSession, station_id: str) -> Station:
        stations = {s.id.lower(): s for s in await self.list_stations(session)}
        station = stations.get(station_id.lower())
        if station is None:
            raise UnknownStation(station_id)
        return station

    async def get_hilo_predictions(
        self,
        session: ClientSession,
        station_id: str,
        *,
        begin: datetime,
        hours: int,
    ) -> list[TideExtremum]:
        station = await self.get_station(session, station_id)
        end = begin + timedelta(hours=hours)

        # Try NAP-referenced first (coastal stations); on failure fall
        # back to MSL (offshore platforms). Both produce metres-above-datum
        # once we divide by 100.
        for hoedanigheid in ("NAP", "MSL"):
            series = await self._fetch_astronomic_series(
                session, station, hoedanigheid, begin, end
            )
            if series:
                return _extract_extrema(series)

        raise StationNotTidal(station_id)

    async def _fetch_catalog(self, session: ClientSession) -> dict[str, Any]:
        if self._catalog is not None:
            return self._catalog
        body = {
            "CatalogusFilter": {
                "Grootheden": True,
                "Parameters": True,
                "Compartimenten": True,
                "Hoedanigheden": True,
                "Eenheden": True,
                "MeetApparaten": True,
            }
        }
        try:
            async with session.post(CATALOG_URL, json=body) as resp:
                resp.raise_for_status()
                payload = await resp.json()
        except ClientError as err:
            raise ApiError(f"RWS catalogue: network error: {err}") from err

        if not payload.get("Succesvol", True):
            raise ApiError(
                f"RWS catalogue rejected: {payload.get('Foutmelding', '(no reason)')}"
            )
        self._catalog = payload
        return payload

    async def _fetch_astronomic_series(
        self,
        session: ClientSession,
        station: Station,
        hoedanigheid: Literal["NAP", "MSL"],
        begin: datetime,
        end: datetime,
    ) -> list[tuple[datetime, float]]:
        """Fetch water-height series and return only the astronomic entries.

        Returns an empty list if the location has no astronomic series at
        the requested reference plane (letting the caller retry with a
        different plane).
        """
        body = {
            "AquoPlusWaarnemingMetadata": {
                "AquoMetadata": {
                    "Compartiment": {"Code": "OW"},
                    "Grootheid": {"Code": "WATHTE"},
                    "Hoedanigheid": {"Code": hoedanigheid},
                }
            },
            "Locatie": {
                "X": station.lng,
                "Y": station.lat,
                "Code": station.id,
            },
            "Periode": {
                "Begindatumtijd": _rws_iso(begin),
                "Einddatumtijd": _rws_iso(end),
            },
        }
        try:
            async with session.post(WAARNEMINGEN_URL, json=body) as resp:
                if resp.status == 400:
                    # Wrong reference plane for this location — silent, so
                    # the caller can try the other one.
                    return []
                resp.raise_for_status()
                payload = await resp.json()
        except ClientError as err:
            raise ApiError(f"RWS predictions: network error: {err}") from err

        if not payload.get("Succesvol", True):
            raise ApiError(
                f"RWS predictions rejected: {payload.get('Foutmelding', '(no reason)')}"
            )

        for entry in payload.get("WaarnemingenLijst") or []:
            desc = (
                (entry.get("AquoMetadata") or {}).get("Parameter_Wat_Omschrijving") or ""
            ).lower()
            if _ASTRO_DESC_TOKEN not in desc:
                continue
            return _parse_metingen(entry.get("MetingenLijst") or [])
        return []


def _build_station_index(catalog: dict[str, Any]) -> dict[str, Station]:
    """Filter the catalogue to locations that publish astronomic tides."""
    locs_by_id = {l["Locatie_MessageID"]: l for l in catalog.get("LocatieLijst") or []}
    astro_loc_ids = {
        x["Locatie_MessageID"]
        for x in catalog.get("AquoMetadataLocatieLijst") or []
        if x.get("AquoMetaData_MessageID") == _ASTRO_MARKER_MID
    }
    stations: dict[str, Station] = {}
    for mid in astro_loc_ids:
        loc = locs_by_id.get(mid)
        if not loc:
            continue
        try:
            station = Station(
                id=str(loc["Code"]),
                name=loc.get("Naam") or str(loc["Code"]),
                lat=float(loc["Lat"]),
                lng=float(loc["Lon"]),
                state=None,
            )
        except (KeyError, TypeError, ValueError):
            continue
        stations[station.id.lower()] = station
    return stations


def _parse_metingen(metingen: list[dict[str, Any]]) -> list[tuple[datetime, float]]:
    """Return ``(time_utc, height_m)`` pairs from an RWS MetingenLijst."""
    series: list[tuple[datetime, float]] = []
    for m in metingen:
        raw = m.get("Meetwaarde", {}).get("Waarde_Numeriek")
        if raw is None:
            continue
        ts = m.get("Tijdstip")
        if not ts:
            continue
        try:
            t = datetime.fromisoformat(ts).astimezone(UTC)
        except ValueError:
            continue
        series.append((t, float(raw) / 100.0))
    return series


def _extract_extrema(series: list[tuple[datetime, float]]) -> list[TideExtremum]:
    """Emit ``TideExtremum`` at each local max / min in the height series.

    RWS quantises to whole centimetres, so plateaus of two or more equal
    samples are common at each peak. Collapsing plateaus to their centre
    sample first lets a strict-inequality compare identify every extremum
    without missing plateau-topped ones. The peak time is then refined by
    fitting a parabola through the three points bracketing each extremum.
    """
    collapsed = _collapse_plateaus(series)
    n = len(collapsed)
    if n < 3:
        return []
    result: list[TideExtremum] = []
    for i in range(1, n - 1):
        t_prev, h_prev = collapsed[i - 1]
        t_cur, h_cur = collapsed[i]
        t_next, h_next = collapsed[i + 1]
        if h_cur > h_prev and h_cur > h_next:
            kind: Literal["H", "L"] = "H"
        elif h_cur < h_prev and h_cur < h_next:
            kind = "L"
        else:
            continue
        peak_t, peak_h = _parabolic_vertex(
            (t_prev, h_prev), (t_cur, h_cur), (t_next, h_next)
        )
        result.append(TideExtremum(time=peak_t, height=round(peak_h, 3), type=kind))
    return result


def _collapse_plateaus(
    series: list[tuple[datetime, float]],
) -> list[tuple[datetime, float]]:
    """Collapse each run of equal-height samples to its centre sample.

    Preserves peak location on a flat quantised top or bottom.
    """
    out: list[tuple[datetime, float]] = []
    i = 0
    n = len(series)
    while i < n:
        j = i
        while j + 1 < n and series[j + 1][1] == series[i][1]:
            j += 1
        out.append(series[(i + j) // 2])
        i = j + 1
    return out


def _parabolic_vertex(
    a: tuple[datetime, float],
    b: tuple[datetime, float],
    c: tuple[datetime, float],
) -> tuple[datetime, float]:
    """Return the vertex ``(t*, h*)`` of the parabola through three points.

    Falls back to the middle sample when the three points are collinear
    (denominator zero — shouldn't happen on real tide data).
    """
    ta, ha = a
    tb, hb = b
    tc, hc = c
    xa = 0.0
    xb = (tb - ta).total_seconds()
    xc = (tc - ta).total_seconds()
    denom = (xa - xb) * (xa - xc) * (xb - xc)
    if denom == 0:
        return tb, hb
    # Numerator of x* = (b + a) / 2 for a parabola y = A x^2 + B x + C.
    a_coef = (xc * (hb - ha) + xb * (ha - hc) + xa * (hc - hb)) / denom
    b_coef = (
        xc * xc * (ha - hb) + xb * xb * (hc - ha) + xa * xa * (hb - hc)
    ) / denom
    if a_coef == 0:
        return tb, hb
    x_star = -b_coef / (2 * a_coef)
    if not (xa <= x_star <= xc):
        return tb, hb
    c_coef = (
        xb * xc * (xb - xc) * ha
        + xc * xa * (xc - xa) * hb
        + xa * xb * (xa - xb) * hc
    ) / denom
    h_star = a_coef * x_star * x_star + b_coef * x_star + c_coef
    return ta + timedelta(seconds=x_star), h_star


def _rws_iso(dt: datetime) -> str:
    """Format a UTC-aware datetime the way RWS wants it."""
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.000+00:00")


__all__ = ["RwsProvider"]
