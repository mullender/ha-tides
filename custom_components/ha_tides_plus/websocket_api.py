"""WebSocket commands the ``tides-plus-card`` Lovelace card uses to fetch
the cached hi/lo series without going through recorder history.

Exposes ``ha_tides_plus/hilo_series`` which returns the coordinator's
knot list for one station as JSON (metres, UTC ISO timestamps). The
card is responsible for unit conversion and PCHIP interpolation.
"""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import CONF_STATION_ID, CONF_STATION_NAME, CONF_STATION_STATE, DOMAIN
from .coordinator import NoaaTidesCoordinator

_LOGGER = logging.getLogger(__name__)

WS_TYPE_HILO = f"{DOMAIN}/hilo_series"
WS_TYPE_LIST = f"{DOMAIN}/list_stations"


@callback
def async_register(hass: HomeAssistant) -> None:
    """Register all WS commands for this integration."""
    websocket_api.async_register_command(hass, ws_hilo_series)
    websocket_api.async_register_command(hass, ws_list_stations)


@callback
@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_HILO,
        vol.Required(CONF_STATION_ID): str,
    }
)
def ws_hilo_series(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return the cached hi/lo knots for one station."""
    entry = _entry_for(hass, msg[CONF_STATION_ID])
    if entry is None:
        connection.send_error(
            msg["id"], "not_found", f"No configured station {msg[CONF_STATION_ID]}"
        )
        return
    coordinator: NoaaTidesCoordinator | None = getattr(entry, "runtime_data", None)
    if coordinator is None:
        connection.send_error(
            msg["id"],
            "not_ready",
            f"Station {msg[CONF_STATION_ID]} is still starting",
        )
        return
    knots = coordinator.data or []
    connection.send_result(
        msg["id"],
        {
            "station_id": entry.data[CONF_STATION_ID],
            "station_name": entry.data.get(CONF_STATION_NAME),
            "station_state": entry.data.get(CONF_STATION_STATE),
            "unit": "m",
            "knots": [
                {"time": k.time.isoformat(), "height": k.height, "type": k.type}
                for k in knots
            ],
        },
    )


@callback
@websocket_api.websocket_command({vol.Required("type"): WS_TYPE_LIST})
def ws_list_stations(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return every configured tide station.

    Lets the card's config editor build a picker without hard-coding
    station IDs.
    """
    stations = []
    for entry in hass.config_entries.async_entries(DOMAIN):
        stations.append(
            {
                "station_id": entry.data[CONF_STATION_ID],
                "station_name": entry.data.get(CONF_STATION_NAME),
                "station_state": entry.data.get(CONF_STATION_STATE),
                "title": entry.title,
            }
        )
    connection.send_result(msg["id"], {"stations": stations})


def _entry_for(hass: HomeAssistant, station_id: str):
    for entry in hass.config_entries.async_entries(DOMAIN):
        if entry.data.get(CONF_STATION_ID) == station_id:
            return entry
    return None
