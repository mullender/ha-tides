"""Config flow for NOAA Tides Plus."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import CONF_STATION_ID, DOMAIN


class NoaaTidesPlusConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for NOAA Tides Plus."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the initial step."""
        if user_input is not None:
            station_id = user_input[CONF_STATION_ID].strip()
            await self.async_set_unique_id(station_id)
            self._abort_if_unique_id_configured()
            return self.async_create_entry(
                title=f"NOAA Tides {station_id}",
                data={CONF_STATION_ID: station_id},
            )

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required(CONF_STATION_ID): str}),
        )
