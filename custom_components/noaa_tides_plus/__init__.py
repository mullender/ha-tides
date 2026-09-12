"""NOAA Tides Plus integration."""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_UNIT_SYSTEM
from homeassistant.core import HomeAssistant
from homeassistant.util.unit_system import METRIC_SYSTEM

from .const import CONF_DATUM, CONF_STATION_ID, DEFAULT_DATUM
from .coordinator import NoaaTidesCoordinator

_LOGGER = logging.getLogger(__name__)

type NoaaTidesEntry = ConfigEntry[NoaaTidesCoordinator]


async def async_setup_entry(hass: HomeAssistant, entry: NoaaTidesEntry) -> bool:
    """Set up NOAA Tides Plus from a config entry."""
    station_id: str = entry.data[CONF_STATION_ID]
    units = entry.options.get(CONF_UNIT_SYSTEM) or (
        "metric" if hass.config.units is METRIC_SYSTEM else "english"
    )
    datum: str = entry.options.get(CONF_DATUM, DEFAULT_DATUM)

    coordinator = NoaaTidesCoordinator(
        hass, station_id=station_id, units=units, datum=datum
    )
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator
    return True


async def async_unload_entry(hass: HomeAssistant, entry: NoaaTidesEntry) -> bool:
    """Unload a config entry."""
    return True
