"""Turn a free-text location query into a (lat, lng) pair.

Supported shapes:
  ""            -> caller uses HA's own home coordinates
  5-digit int   -> US ZIP code via api.zippopotam.us
  anything else -> OpenStreetMap Nominatim search

Both third-party services are free and require no API key. Nominatim is
rate-limited to ~1 req/s per IP with an attribution requirement; the
config flow only calls it interactively, so that stays well within
policy.
"""

from __future__ import annotations

from dataclasses import dataclass
import logging

from aiohttp import ClientError, ClientSession

_LOGGER = logging.getLogger(__name__)

ZIPPOPOTAM_URL = "https://api.zippopotam.us/us/{zip}"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "ha-tides/0.1 (github.com/mullender/ha-tides)"


class GeocodeError(Exception):
    """No usable coordinates could be resolved for the query."""


@dataclass(frozen=True, slots=True)
class Location:
    """Resolved query coordinates plus a human-readable label."""

    lat: float
    lng: float
    label: str


async def geocode(session: ClientSession, query: str) -> Location:
    """Resolve ``query`` to a Location, or raise GeocodeError."""
    q = query.strip()
    if not q:
        raise GeocodeError("empty query")

    if q.isdigit() and len(q) == 5:
        return await _geocode_us_zip(session, q)
    return await _geocode_nominatim(session, q)


async def _geocode_us_zip(session: ClientSession, zip_code: str) -> Location:
    try:
        async with session.get(
            ZIPPOPOTAM_URL.format(zip=zip_code), headers={"User-Agent": USER_AGENT}
        ) as resp:
            if resp.status == 404:
                raise GeocodeError(f"ZIP {zip_code!r} not found")
            resp.raise_for_status()
            payload = await resp.json()
    except ClientError as err:
        raise GeocodeError(f"network error: {err}") from err

    places = payload.get("places") or []
    if not places:
        raise GeocodeError(f"ZIP {zip_code!r} has no places")
    p = places[0]
    return Location(
        lat=float(p["latitude"]),
        lng=float(p["longitude"]),
        label=(
            f"{p.get('place name', zip_code)}, "
            f"{p.get('state abbreviation', p.get('state', ''))} {zip_code}"
        ),
    )


async def _geocode_nominatim(session: ClientSession, query: str) -> Location:
    params = {
        "q": query,
        "format": "json",
        "limit": "1",
        "addressdetails": "1",
    }
    try:
        async with session.get(
            NOMINATIM_URL, params=params, headers={"User-Agent": USER_AGENT}
        ) as resp:
            resp.raise_for_status()
            results = await resp.json()
    except ClientError as err:
        raise GeocodeError(f"network error: {err}") from err

    if not results:
        raise GeocodeError(f"no results for {query!r}")
    r = results[0]
    return Location(
        lat=float(r["lat"]),
        lng=float(r["lon"]),
        label=r.get("display_name", query),
    )
