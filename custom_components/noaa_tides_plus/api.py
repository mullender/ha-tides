"""NOAA CO-OPS API client."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import logging
from typing import Literal

from aiohttp import ClientError, ClientSession

_LOGGER = logging.getLogger(__name__)

APPLICATION = "noaa_tides_plus"
MDAPI_STATION_URL = (
    "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/{station_id}.json"
)
MDAPI_STATIONS_URL = (
    "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json"
)
DATAGETTER_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"


class ApiError(Exception):
    """Raised when the NOAA API cannot be reached or returns an error."""


class UnknownStation(ApiError):
    """Raised when the station ID is not present in the NOAA catalog."""


class StationNotTidal(ApiError):
    """Raised when the station exists but does not publish tide predictions."""


@dataclass(frozen=True, slots=True)
class Station:
    """Static metadata for a NOAA tide station."""

    id: str
    name: str
    lat: float
    lng: float
    state: str | None
    tide_type: str | None


@dataclass(frozen=True, slots=True)
class TideExtremum:
    """One high or low tide prediction."""

    time: datetime
    height: float
    type: Literal["H", "L"]


async def list_tide_stations(session: ClientSession) -> list[Station]:
    """Fetch NOAA's full list of tide-prediction stations (~3500 entries).

    Response is ~700 KB; callers should cache it for the duration of a
    config-flow session and not refetch per keystroke.
    """
    try:
        async with session.get(
            MDAPI_STATIONS_URL, params={"type": "tidepredictions"}
        ) as resp:
            resp.raise_for_status()
            payload = await resp.json()
    except ClientError as err:
        raise ApiError(f"network error: {err}") from err

    stations: list[Station] = []
    for s in payload.get("stations") or []:
        try:
            stations.append(
                Station(
                    id=str(s["id"]),
                    name=s.get("name") or str(s["id"]),
                    lat=float(s["lat"]),
                    lng=float(s["lng"]),
                    state=s.get("state") or None,
                    tide_type=s.get("tideType") or None,
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return stations


async def get_station(session: ClientSession, station_id: str) -> Station:
    """Look up a station in the NOAA metadata API.

    Raises UnknownStation on 404 and StationNotTidal if the station has no
    tide predictions. Raises ApiError on network or parse failures.
    """
    url = MDAPI_STATION_URL.format(station_id=station_id)
    params = {"expand": "details,products"}
    try:
        async with session.get(url, params=params) as resp:
            if resp.status == 404:
                raise UnknownStation(station_id)
            resp.raise_for_status()
            payload = await resp.json()
    except ClientError as err:
        raise ApiError(f"network error: {err}") from err

    stations = payload.get("stations") or []
    if not stations:
        raise UnknownStation(station_id)

    s = stations[0]
    # Reference stations expose ``tidal: true``; subordinates omit the field
    # entirely and carry ``type: "S"`` with a ``reference_id`` back to the
    # parent. Both kinds return tide predictions from the datagetter API.
    is_reference_tide = bool(s.get("tidal"))
    is_subordinate = s.get("type") == "S" and s.get("reference_id")
    if not (is_reference_tide or is_subordinate):
        raise StationNotTidal(station_id)

    return Station(
        id=str(s.get("id", station_id)),
        name=s.get("name") or station_id,
        lat=float(s.get("lat", 0.0)),
        lng=float(s.get("lng", 0.0)),
        state=s.get("state"),
        tide_type=s.get("tideType") or None,
    )


async def get_hilo_predictions(
    session: ClientSession,
    station_id: str,
    *,
    units: Literal["metric", "english"] = "metric",
    datum: str = "MLLW",
    hours: int = 168,
    begin: datetime | None = None,
) -> list[TideExtremum]:
    """Fetch high/low tide predictions covering ``hours`` from ``begin``.

    ``begin`` defaults to the current UTC time. Times in the returned
    ``TideExtremum`` are UTC-aware.
    """
    if begin is None:
        begin = datetime.now(UTC)
    params = {
        "product": "predictions",
        "application": APPLICATION,
        "begin_date": begin.strftime("%Y%m%d %H:%M"),
        "range": str(hours),
        "datum": datum,
        "station": station_id,
        "time_zone": "gmt",
        "units": units,
        "format": "json",
        "interval": "hilo",
    }
    try:
        async with session.get(DATAGETTER_URL, params=params) as resp:
            resp.raise_for_status()
            payload = await resp.json()
    except ClientError as err:
        raise ApiError(f"network error: {err}") from err

    if "error" in payload:
        raise ApiError(str(payload["error"].get("message", "unknown NOAA error")))

    preds = payload.get("predictions") or []
    if not preds:
        raise ApiError("NOAA returned no predictions")

    result: list[TideExtremum] = []
    for p in preds:
        result.append(
            TideExtremum(
                time=datetime.strptime(p["t"], "%Y-%m-%d %H:%M").replace(tzinfo=UTC),
                height=float(p["v"]),
                type=p["type"],
            )
        )
    return result
