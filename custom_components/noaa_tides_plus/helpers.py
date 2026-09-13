"""Small helpers shared by more than one module."""

from __future__ import annotations


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
