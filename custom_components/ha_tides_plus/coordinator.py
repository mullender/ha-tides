"""DataUpdateCoordinator for Tides Plus."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN
from .providers import ApiError, Provider, TideExtremum

_LOGGER = logging.getLogger(__name__)

REFRESH_INTERVAL = timedelta(hours=12)
# ±7 days lets the chart card page back or forward a week entirely from
# cache. Providers accept multi-week windows well below their limits.
LOOKBACK_HOURS = 24 * 7
LOOKAHEAD_HOURS = 24 * 7
FETCH_HOURS = LOOKBACK_HOURS + LOOKAHEAD_HOURS


type NoaaTidesEntry = ConfigEntry[NoaaTidesCoordinator]


class NoaaTidesCoordinator(DataUpdateCoordinator[list[TideExtremum]]):
    """Fetch and cache hi/lo tide predictions for one station.

    All providers return heights in metres; display-unit conversion is
    delegated to Home Assistant via ``SensorDeviceClass.DISTANCE`` on
    the exposed entities.
    """

    def __init__(
        self,
        hass: HomeAssistant,
        *,
        provider: Provider,
        station_id: str,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}:{provider.id}:{station_id}",
            update_interval=REFRESH_INTERVAL,
        )
        self.provider = provider
        self.station_id = station_id

    async def _async_update_data(self) -> list[TideExtremum]:
        session = async_get_clientsession(self.hass)
        begin = datetime.now(UTC) - timedelta(hours=LOOKBACK_HOURS)
        try:
            data = await self.provider.get_hilo_predictions(
                session,
                self.station_id,
                begin=begin,
                hours=FETCH_HOURS,
            )
        except ApiError as err:
            raise UpdateFailed(str(err)) from err
        _LOGGER.debug(
            "Fetched %d hi/lo points for %s station %s (first=%s, last=%s)",
            len(data),
            self.provider.id,
            self.station_id,
            data[0].time if data else None,
            data[-1].time if data else None,
        )
        return data
