"""Tides Plus integration."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv, device_registry as dr
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType

from .const import (
    CONF_DATUM,
    CONF_PROVIDER,
    CONF_STATION_ID,
    CONF_STATION_LAT,
    CONF_STATION_LNG,
    CONF_STATION_NAME,
    CONF_STATION_STATE,
    DEFAULT_DATUM,
    DEFAULT_PROVIDER,
    DOMAIN,
)
from .coordinator import NoaaTidesCoordinator, NoaaTidesEntry
from .events import ExtremumEventScheduler
from .helpers import format_device_name
from .providers import ApiError, Provider, get_provider
from .websocket_api import async_register as async_register_ws

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.SENSOR]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

_FRONTEND_URL = "/ha_tides_plus/tides-plus-card.js"
_APEX_URL = "/ha_tides_plus/apexcharts.min.js"
_FRONTEND_DIR = Path(__file__).parent / "frontend"


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """One-time domain setup: WebSocket commands and the Lovelace card asset."""
    _LOGGER.info("ha_tides_plus async_setup: registering WS + card asset")
    async_register_ws(hass)

    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(
                _FRONTEND_URL, str(_FRONTEND_DIR / "tides-plus-card.js"), False
            ),
            StaticPathConfig(
                _APEX_URL, str(_FRONTEND_DIR / "apexcharts.min.js"), True
            ),
        ]
    )
    add_extra_js_url(hass, _FRONTEND_URL)
    _LOGGER.info("ha_tides_plus card served at %s", _FRONTEND_URL)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: NoaaTidesEntry) -> bool:
    """Set up Tides Plus from a config entry."""
    # Entries created before the provider abstraction (v0.1) carry no
    # ``provider`` key; treat them as NOAA and persist that so future
    # reads are straight lookups.
    if CONF_PROVIDER not in entry.data:
        hass.config_entries.async_update_entry(
            entry,
            data={**entry.data, CONF_PROVIDER: DEFAULT_PROVIDER},
        )

    station_id: str = entry.data[CONF_STATION_ID]
    provider = _build_provider(entry)

    if CONF_STATION_NAME not in entry.data:
        await _enrich_entry_with_station_metadata(hass, entry, provider, station_id)

    _sync_entry_title(hass, entry, station_id)
    _sync_device_name(hass, entry, station_id)

    coordinator = NoaaTidesCoordinator(hass, provider=provider, station_id=station_id)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator

    scheduler = ExtremumEventScheduler(hass, station_id, dict(entry.data))
    scheduler.schedule(coordinator.data or [])
    entry.async_on_unload(scheduler.clear)
    entry.async_on_unload(
        coordinator.async_add_listener(
            lambda: scheduler.schedule(coordinator.data or [])
        )
    )

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: NoaaTidesEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


def _build_provider(entry: NoaaTidesEntry) -> Provider:
    """Instantiate the provider named on this entry, with per-provider options."""
    provider_id: str = entry.data.get(CONF_PROVIDER, DEFAULT_PROVIDER)
    kwargs: dict[str, object] = {}
    if provider_id == "noaa":
        kwargs["datum"] = entry.options.get(CONF_DATUM, DEFAULT_DATUM)
    return get_provider(provider_id, **kwargs)


def _sync_entry_title(
    hass: HomeAssistant, entry: NoaaTidesEntry, station_id: str
) -> None:
    """Refresh the config entry title to match the current format."""
    new_title = format_device_name(
        station_id,
        entry.data.get(CONF_STATION_NAME),
        entry.data.get(CONF_STATION_STATE),
    )
    if entry.title != new_title:
        hass.config_entries.async_update_entry(entry, title=new_title)


def _sync_device_name(
    hass: HomeAssistant, entry: NoaaTidesEntry, station_id: str
) -> None:
    """Rename an existing device to reflect (possibly-backfilled) metadata.

    ``async_add_entities`` alone does not force a rename on an existing
    device — HA only updates the stored name for a freshly created one.
    Skips devices the user has manually renamed (``name_by_user`` set).
    """
    registry = dr.async_get(hass)
    device = registry.async_get_device_by_identifier(
        (DOMAIN, station_id), config_entry_id=entry.entry_id
    )
    if device is None or device.name_by_user is not None:
        return
    new_name = format_device_name(
        station_id,
        entry.data.get(CONF_STATION_NAME),
        entry.data.get(CONF_STATION_STATE),
    )
    if device.name != new_name:
        registry.async_update_device(device.id, name=new_name)


async def _enrich_entry_with_station_metadata(
    hass: HomeAssistant,
    entry: NoaaTidesEntry,
    provider: Provider,
    station_id: str,
) -> None:
    """Backfill station name / state / coords for entries created before the
    config flow stored them. A failure here is not fatal — we just log and
    let the next setup retry.
    """
    try:
        station = await provider.get_station(async_get_clientsession(hass), station_id)
    except ApiError as err:
        _LOGGER.debug("Skipping station-metadata backfill for %s: %s", station_id, err)
        return
    hass.config_entries.async_update_entry(
        entry,
        data={
            **entry.data,
            CONF_STATION_NAME: station.name,
            CONF_STATION_STATE: station.state,
            CONF_STATION_LAT: station.lat,
            CONF_STATION_LNG: station.lng,
        },
    )
