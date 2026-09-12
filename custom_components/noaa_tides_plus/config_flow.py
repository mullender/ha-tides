"""Config flow for NOAA Tides Plus."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import ApiError, StationNotTidal, UnknownStation, get_station
from .const import CONF_STATION_ID, DOMAIN

_LOGGER = logging.getLogger(__name__)


class NoaaTidesPlusConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for NOAA Tides Plus."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the initial step."""
        errors: dict[str, str] = {}

        if user_input is not None:
            station_id = user_input[CONF_STATION_ID].strip()
            session = async_get_clientsession(self.hass)
            try:
                station = await get_station(session, station_id)
            except UnknownStation:
                errors["base"] = "unknown_station"
            except StationNotTidal:
                errors["base"] = "not_tidal"
            except ApiError:
                _LOGGER.exception("NOAA API lookup failed for %s", station_id)
                errors["base"] = "cannot_connect"
            else:
                await self.async_set_unique_id(station.id)
                self._abort_if_unique_id_configured()
                title = f"{station.name} ({station.id})"
                if station.state:
                    title = f"{station.name}, {station.state} ({station.id})"
                return self.async_create_entry(
                    title=title,
                    data={CONF_STATION_ID: station.id},
                )

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required(CONF_STATION_ID): str}),
            errors=errors,
        )
