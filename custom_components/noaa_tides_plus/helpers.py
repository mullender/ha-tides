"""Small helpers shared by more than one module."""

from __future__ import annotations

import math

_EARTH_RADIUS_KM = 6371.0088


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in kilometres between two lat/lng pairs."""
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * _EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def format_device_name(
    station_id: str, name: str | None, state: str | None
) -> str:
    """Compose the device name shown in the HA UI.

    Format is ``"<id>: <name>, <state>"`` (with the ID first, so it can't be
    mistaken for a US zip code in the trailing parenthesis).
    """
    if name and state:
        return f"{station_id}: {name}, {state}"
    if name:
        return f"{station_id}: {name}"
    return station_id
