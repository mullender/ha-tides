"""NOAA Tides Plus integration."""

from __future__ import annotations

import logging

from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .const import CONF_DATUM, CONF_STATION_ID, DEFAULT_DATUM
from .coordinator import NoaaTidesCoordinator, NoaaTidesEntry

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.SENSOR]


async def async_setup_entry(hass: HomeAssistant, entry: NoaaTidesEntry) -> bool:
    """Set up NOAA Tides Plus from a config entry."""
    station_id: str = entry.data[CONF_STATION_ID]
    datum: str = entry.options.get(CONF_DATUM, DEFAULT_DATUM)

    coordinator = NoaaTidesCoordinator(hass, station_id=station_id, datum=datum)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: NoaaTidesEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
