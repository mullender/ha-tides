"""NOAA CO-OPS tide-prediction provider (USA)."""

from __future__ import annotations

from datetime import UTC, datetime
import logging

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

APPLICATION = "ha_tides_plus"
MDAPI_STATION_URL = (
    "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/{station_id}.json"
)
MDAPI_STATIONS_URL = (
    "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json"
)
DATAGETTER_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"

_DEFAULT_DATUM = "MLLW"


class NoaaProvider(Provider):
    """NOAA CO-OPS tide predictions for US tide stations.

    ``datum`` picks the vertical reference for heights returned by
    :meth:`get_hilo_predictions`. Defaults to MLLW (mean lower low water)
    which matches the legacy core ``noaa_tides`` integration.
    """

    id = "noaa"
    label = "USA (NOAA)"
    attribution = "Data provided by NOAA"
    manufacturer = "NOAA"

    def __init__(self, *, datum: str = _DEFAULT_DATUM) -> None:
        self._datum = datum

    def station_url(self, station_id: str) -> str | None:
        return f"https://tidesandcurrents.noaa.gov/stationhome.html?id={station_id}"

    def parse_direct_id(self, query: str) -> str | None:
        query = query.strip()
        if query.isdigit() and len(query) == 7:
            return query
        return None

    async def list_stations(self, session: ClientSession) -> list[Station]:
        """Fetch NOAA's full list of tide-prediction stations (~3500 entries)."""
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

    async def get_station(self, session: ClientSession, station_id: str) -> Station:
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
        # Reference stations expose ``tidal: true``; subordinates omit the
        # field and carry ``type: "S"`` with a ``reference_id`` back to the
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
        self,
        session: ClientSession,
        station_id: str,
        *,
        begin: datetime,
        hours: int,
    ) -> list[TideExtremum]:
        params = {
            "product": "predictions",
            "application": APPLICATION,
            "begin_date": begin.strftime("%Y%m%d %H:%M"),
            "range": str(hours),
            "datum": self._datum,
            "station": station_id,
            "time_zone": "gmt",
            "units": "metric",
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


__all__ = ["NoaaProvider"]
