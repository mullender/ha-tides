"""DataUpdateCoordinator for NOAA Tides Plus."""

from __future__ import annotations

from datetime import timedelta
import logging

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import ApiError, TideExtremum, get_hilo_predictions
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

REFRESH_INTERVAL = timedelta(hours=12)
FETCH_HOURS = 7 * 24


class NoaaTidesCoordinator(DataUpdateCoordinator[list[TideExtremum]]):
    """Fetch and cache hi/lo tide predictions for one station."""

    def __init__(
        self,
        hass: HomeAssistant,
        *,
        station_id: str,
        units: str,
        datum: str,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}:{station_id}",
            update_interval=REFRESH_INTERVAL,
        )
        self.station_id = station_id
        self.units = units
        self.datum = datum

    async def _async_update_data(self) -> list[TideExtremum]:
        session = async_get_clientsession(self.hass)
        try:
            data = await get_hilo_predictions(
                session,
                self.station_id,
                units=self.units,  # type: ignore[arg-type]
                datum=self.datum,
                hours=FETCH_HOURS,
            )
        except ApiError as err:
            raise UpdateFailed(str(err)) from err
        _LOGGER.debug(
            "Fetched %d hi/lo points for station %s (first=%s, last=%s)",
            len(data),
            self.station_id,
            data[0].time if data else None,
            data[-1].time if data else None,
        )
        return data
