"""Config flow for Tides Plus."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CONF_PROVIDER,
    CONF_STATION_ID,
    CONF_STATION_LAT,
    CONF_STATION_LNG,
    CONF_STATION_NAME,
    CONF_STATION_STATE,
    DEFAULT_PROVIDER,
    DOMAIN,
)
from .geocode import GeocodeError, geocode
from .helpers import format_device_name, haversine_km
from .providers import (
    ApiError,
    Provider,
    Station,
    StationNotTidal,
    UnknownStation,
    get_provider,
)

_LOGGER = logging.getLogger(__name__)

CONF_QUERY = "query"
DEFAULT_TOP_N = 20


class NoaaTidesPlusConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Tides Plus."""

    VERSION = 1

    def __init__(self) -> None:
        self._provider: Provider = get_provider(DEFAULT_PROVIDER)
        self._candidates: list[tuple[Station, float]] = []
        self._search_label: str = ""

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Ask for a location or a direct station ID."""
        errors: dict[str, str] = {}

        if user_input is not None:
            query = user_input.get(CONF_QUERY, "").strip()
            direct_id = self._provider.parse_direct_id(query)
            if direct_id is not None:
                try:
                    return await self._create_from_station_id(direct_id)
                except _StepError as err:
                    errors = err.errors
            else:
                try:
                    await self._prepare_candidates(query)
                except _StepError as err:
                    errors = err.errors
                else:
                    return await self.async_step_pick_station()

        schema = vol.Schema({vol.Optional(CONF_QUERY, default=""): str})
        return self.async_show_form(
            step_id="user", data_schema=schema, errors=errors
        )

    async def async_step_pick_station(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Show the nearest tide stations and let the user pick."""
        errors: dict[str, str] = {}

        if user_input is not None:
            try:
                return await self._create_from_station_id(user_input[CONF_STATION_ID])
            except _StepError as err:
                errors = err.errors

        choices = {
            s.id: self._option_label(s, dist_km) for s, dist_km in self._candidates
        }
        schema = vol.Schema({vol.Required(CONF_STATION_ID): vol.In(choices)})
        return self.async_show_form(
            step_id="pick_station",
            data_schema=schema,
            errors=errors,
            description_placeholders={"query": self._search_label},
        )

    async def _prepare_candidates(self, query: str) -> None:
        """Resolve ``query`` to a lat/lng, then fill ``self._candidates``."""
        session = async_get_clientsession(self.hass)

        if not query:
            lat = self.hass.config.latitude
            lng = self.hass.config.longitude
            if lat is None or lng is None:
                raise _StepError({"base": "no_home_location"})
            self._search_label = self.hass.config.location_name or "your home"
        else:
            try:
                loc = await geocode(session, query)
            except GeocodeError:
                _LOGGER.debug("Geocode failed for %r", query, exc_info=True)
                raise _StepError({"base": "geocode_failed"}) from None
            lat, lng = loc.lat, loc.lng
            self._search_label = loc.label

        try:
            stations = await self._provider.list_stations(session)
        except ApiError:
            raise _StepError({"base": "cannot_connect"}) from None

        ranked = sorted(
            ((s, haversine_km(lat, lng, s.lat, s.lng)) for s in stations),
            key=lambda sd: sd[1],
        )
        self._candidates = ranked[:DEFAULT_TOP_N]

    async def _create_from_station_id(self, station_id: str) -> ConfigFlowResult:
        """Validate a station ID and either create the entry or raise _StepError."""
        session = async_get_clientsession(self.hass)
        try:
            station = await self._provider.get_station(session, station_id)
        except UnknownStation:
            raise _StepError({"base": "unknown_station"}) from None
        except StationNotTidal:
            raise _StepError({"base": "not_tidal"}) from None
        except ApiError:
            _LOGGER.exception(
                "%s API lookup failed for %s", self._provider.id, station_id
            )
            raise _StepError({"base": "cannot_connect"}) from None

        # Station IDs don't collide across providers (NOAA is 7-digit
        # numeric; RWS is short alphanumeric code), so no need to prefix.
        # Keeps unique_id stable for the pre-provider-abstraction NOAA
        # entries already in the field.
        await self.async_set_unique_id(station.id)
        self._abort_if_unique_id_configured()
        return self.async_create_entry(
            title=format_device_name(station.id, station.name, station.state),
            data={
                CONF_PROVIDER: self._provider.id,
                CONF_STATION_ID: station.id,
                CONF_STATION_NAME: station.name,
                CONF_STATION_STATE: station.state,
                CONF_STATION_LAT: station.lat,
                CONF_STATION_LNG: station.lng,
            },
        )

    @staticmethod
    def _option_label(station: Station, dist_km: float) -> str:
        base = (
            f"{station.name}, {station.state}"
            if station.state
            else station.name
        )
        return f"{base} — {dist_km:.1f} km (station: {station.id})"


class _StepError(Exception):
    """Internal signal: a step failed with a translatable error key."""

    def __init__(self, errors: dict[str, str]) -> None:
        super().__init__(errors.get("base", "step_failed"))
        self.errors = errors
