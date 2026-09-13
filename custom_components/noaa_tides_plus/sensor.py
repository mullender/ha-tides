"""Sensor entities for NOAA Tides Plus."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.const import UnitOfLength
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
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

Kind = Literal["high", "low"]


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

    async_add_entities(
        [
            NextTideTimeSensor(coordinator, "high", device_info, station_id),
            NextTideTimeSensor(coordinator, "low", device_info, station_id),
            NextTideHeightSensor(coordinator, "high", device_info, station_id),
            NextTideHeightSensor(coordinator, "low", device_info, station_id),
        ]
    )


def _next_extremum(
    data: list[TideExtremum] | None, kind: Kind
) -> TideExtremum | None:
    if not data:
        return None
    marker = "H" if kind == "high" else "L"
    now = dt_util.utcnow()
    return next((p for p in data if p.type == marker and p.time > now), None)


_KIND_ICON = {"high": "mdi:wave-arrow-up", "low": "mdi:wave-arrow-down"}


class _NoaaTidesSensor(CoordinatorEntity[NoaaTidesCoordinator], SensorEntity):
    """Common bits for NOAA Tides Plus sensors."""

    _attr_has_entity_name = True
    _attr_attribution = ATTRIBUTION

    def __init__(
        self,
        coordinator: NoaaTidesCoordinator,
        kind: Kind,
        device_info: DeviceInfo,
        station_id: str,
        suffix: str,
        name: str,
    ) -> None:
        super().__init__(coordinator)
        self._kind: Kind = kind
        self._attr_device_info = device_info
        self._attr_unique_id = f"{station_id}_next_{kind}_{suffix}"
        self._attr_name = name
        self._attr_icon = _KIND_ICON[kind]


class NextTideTimeSensor(_NoaaTidesSensor):
    """Timestamp of the next high or low tide."""

    _attr_device_class = SensorDeviceClass.TIMESTAMP

    def __init__(
        self,
        coordinator: NoaaTidesCoordinator,
        kind: Kind,
        device_info: DeviceInfo,
        station_id: str,
    ) -> None:
        super().__init__(
            coordinator,
            kind,
            device_info,
            station_id,
            suffix="tide",
            name=f"Next {kind} tide",
        )

    @property
    def native_value(self) -> datetime | None:
        p = _next_extremum(self.coordinator.data, self._kind)
        return p.time if p else None


class NextTideHeightSensor(_NoaaTidesSensor):
    """Predicted water height at the next high or low tide.

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
        device_info: DeviceInfo,
        station_id: str,
    ) -> None:
        super().__init__(
            coordinator,
            kind,
            device_info,
            station_id,
            suffix="height",
            name=f"Next {kind} tide height",
        )

    @property
    def native_value(self) -> float | None:
        p = _next_extremum(self.coordinator.data, self._kind)
        return p.height if p else None
