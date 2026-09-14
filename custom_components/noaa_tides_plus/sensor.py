"""Sensor entities for NOAA Tides Plus."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Literal

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.const import UnitOfLength
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import dt as dt_util

from .api import TideExtremum
from .const import (
    ATTRIBUTION,
    CONF_STATION_ID,
    CONF_STATION_NAME,
    CONF_STATION_STATE,
    DOMAIN,
)
from .coordinator import NoaaTidesCoordinator, NoaaTidesEntry
from .helpers import format_device_name
from .interpolation import compute_tide_state, interpolate_height

Kind = Literal["high", "low"]
When = Literal["next", "previous"]

_KIND_ICON = {"high": "mdi:wave-arrow-up", "low": "mdi:wave-arrow-down"}
_STATE_ICON = {
    "rising": "mdi:trending-up",
    "falling": "mdi:trending-down",
    "high": "mdi:wave-arrow-up",
    "low": "mdi:wave-arrow-down",
}
_LIVE_REFRESH = timedelta(minutes=1)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: NoaaTidesEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up sensors for a NOAA Tides Plus config entry."""
    coordinator = entry.runtime_data
    station_id: str = entry.data[CONF_STATION_ID]
    station_name: str | None = entry.data.get(CONF_STATION_NAME)
    station_state: str | None = entry.data.get(CONF_STATION_STATE)

    device_name = format_device_name(station_id, station_name, station_state)
    device_info = DeviceInfo(
        identifiers={(DOMAIN, station_id)},
        name=device_name,
        manufacturer="NOAA",
        model="Tide station",
        configuration_url=(
            f"https://tidesandcurrents.noaa.gov/stationhome.html?id={station_id}"
        ),
    )

    entities: list[SensorEntity] = []
    for when in ("previous", "next"):
        for kind in ("high", "low"):
            entities.append(
                TideExtremumTimeSensor(coordinator, kind, when, device_info, station_id)
            )
            entities.append(
                TideExtremumHeightSensor(coordinator, kind, when, device_info, station_id)
            )
    entities.append(TideHeightSensor(coordinator, device_info, station_id))
    entities.append(TideStateSensor(coordinator, device_info, station_id))

    async_add_entities(entities)


def _pick_extremum(
    data: list[TideExtremum] | None,
    kind: Kind,
    when: When,
    now: datetime,
) -> TideExtremum | None:
    """Return the nearest future ("next") or past ("previous") extremum of
    the given kind, or None if the knot window does not cover ``now``.
    """
    if not data:
        return None
    marker = "H" if kind == "high" else "L"
    if when == "next":
        return next((p for p in data if p.type == marker and p.time > now), None)
    return next(
        (p for p in reversed(data) if p.type == marker and p.time <= now), None
    )


class _NoaaTidesBase(CoordinatorEntity[NoaaTidesCoordinator], SensorEntity):
    """Common bits for NOAA Tides Plus sensors.

    Emits a state write every minute so ``native_value`` (which is
    evaluated against ``dt_util.utcnow()``) stays fresh between the
    coordinator's 12 h fetches.
    """

    _attr_has_entity_name = True
    _attr_attribution = ATTRIBUTION

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            async_track_time_interval(self.hass, self._tick, _LIVE_REFRESH)
        )

    @callback
    def _tick(self, _now: datetime) -> None:
        self.async_write_ha_state()


class TideExtremumTimeSensor(_NoaaTidesBase):
    """Timestamp of the previous or next high/low tide."""

    _attr_device_class = SensorDeviceClass.TIMESTAMP

    def __init__(
        self,
        coordinator: NoaaTidesCoordinator,
        kind: Kind,
        when: When,
        device_info: DeviceInfo,
        station_id: str,
    ) -> None:
        super().__init__(coordinator)
        self._kind: Kind = kind
        self._when: When = when
        self._attr_device_info = device_info
        self._attr_unique_id = f"{station_id}_{when}_{kind}_tide"
        self._attr_name = f"{when.capitalize()} {kind} tide"
        self._attr_icon = _KIND_ICON[kind]

    @property
    def native_value(self) -> datetime | None:
        p = _pick_extremum(
            self.coordinator.data, self._kind, self._when, dt_util.utcnow()
        )
        return p.time if p else None


class TideExtremumHeightSensor(_NoaaTidesBase):
    """Predicted water height at the previous or next high/low tide.

    Stored in metres; HA converts to the user's preferred length unit at
    display time via ``SensorDeviceClass.DISTANCE``.
    """

    _attr_device_class = SensorDeviceClass.DISTANCE
    _attr_native_unit_of_measurement = UnitOfLength.METERS
    _attr_suggested_display_precision = 2

    def __init__(
        self,
        coordinator: NoaaTidesCoordinator,
        kind: Kind,
        when: When,
        device_info: DeviceInfo,
        station_id: str,
    ) -> None:
        super().__init__(coordinator)
        self._kind: Kind = kind
        self._when: When = when
        self._attr_device_info = device_info
        self._attr_unique_id = f"{station_id}_{when}_{kind}_height"
        self._attr_name = f"{when.capitalize()} {kind} tide height"
        self._attr_icon = _KIND_ICON[kind]

    @property
    def native_value(self) -> float | None:
        p = _pick_extremum(
            self.coordinator.data, self._kind, self._when, dt_util.utcnow()
        )
        return p.height if p else None


class TideHeightSensor(_NoaaTidesBase):
    """PCHIP-interpolated current water height."""

    _attr_device_class = SensorDeviceClass.DISTANCE
    _attr_native_unit_of_measurement = UnitOfLength.METERS
    _attr_suggested_display_precision = 2
    _attr_icon = "mdi:sine-wave"
    _attr_name = "Tide height (estimated)"

    def __init__(
        self,
        coordinator: NoaaTidesCoordinator,
        device_info: DeviceInfo,
        station_id: str,
    ) -> None:
        super().__init__(coordinator)
        self._attr_device_info = device_info
        self._attr_unique_id = f"{station_id}_tide_height"

    @property
    def native_value(self) -> float | None:
        return interpolate_height(self.coordinator.data or [], dt_util.utcnow())


class TideStateSensor(_NoaaTidesBase):
    """Rising / falling, with a short hold at each peak and trough."""

    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = ["rising", "falling", "high", "low"]
    _attr_name = "Tide state"

    def __init__(
        self,
        coordinator: NoaaTidesCoordinator,
        device_info: DeviceInfo,
        station_id: str,
    ) -> None:
        super().__init__(coordinator)
        self._attr_device_info = device_info
        self._attr_unique_id = f"{station_id}_tide_state"

    @property
    def native_value(self) -> str | None:
        return compute_tide_state(self.coordinator.data or [], dt_util.utcnow())

    @property
    def icon(self) -> str | None:
        return _STATE_ICON.get(self.native_value or "", "mdi:sine-wave")
