"""Fire ``ha_tides_plus_high_tide`` / ``_low_tide`` events on the bus
at each future extremum, so users can drive ``event`` triggers instead
of chasing timestamp-sensor state transitions.
"""

from __future__ import annotations

from datetime import datetime
import logging
from typing import Any, Callable

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_point_in_time
from homeassistant.util import dt as dt_util

from .const import CONF_STATION_NAME, CONF_STATION_STATE, DOMAIN
from .providers import TideExtremum

_LOGGER = logging.getLogger(__name__)

EVENT_HIGH_TIDE = f"{DOMAIN}_high_tide"
EVENT_LOW_TIDE = f"{DOMAIN}_low_tide"


class ExtremumEventScheduler:
    """Schedules one HA-bus event per future high/low tide knot.

    Rescheduled from scratch on every coordinator refresh, so late-arriving
    predictions and TZ shifts are always reflected in the pending queue.
    """

    def __init__(
        self, hass: HomeAssistant, station_id: str, station_data: dict[str, Any]
    ) -> None:
        self._hass = hass
        self._station_id = station_id
        self._station_data = station_data
        self._cancellers: list[Callable[[], None]] = []

    def schedule(self, knots: list[TideExtremum]) -> None:
        """Cancel any pending events and re-arm one for every future knot."""
        self.clear()
        now = dt_util.utcnow()
        scheduled = 0
        for knot in knots:
            if knot.time <= now:
                continue
            self._cancellers.append(
                async_track_point_in_time(
                    self._hass, self._fire_for(knot), knot.time
                )
            )
            scheduled += 1
        _LOGGER.debug(
            "Scheduled %d extremum events for station %s", scheduled, self._station_id
        )

    def clear(self) -> None:
        """Cancel all pending scheduled events."""
        for cancel in self._cancellers:
            cancel()
        self._cancellers.clear()

    def _fire_for(self, knot: TideExtremum) -> Callable[[datetime], None]:
        event_type = EVENT_HIGH_TIDE if knot.type == "H" else EVENT_LOW_TIDE
        payload = {
            "station_id": self._station_id,
            "station_name": self._station_data.get(CONF_STATION_NAME),
            "station_state": self._station_data.get(CONF_STATION_STATE),
            "time": knot.time.isoformat(),
            "height": knot.height,
            "unit": "m",
        }

        @callback
        def _fire(_now: datetime) -> None:
            self._hass.bus.async_fire(event_type, payload)

        return _fire
