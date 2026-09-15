"""Registry of tide-prediction providers.

Add a new provider by writing a module in this package that subclasses
:class:`Provider`, importing the class here, and appending it to
``_REGISTRY``. Everything else (config flow, coordinator, sensors,
events, cards, blueprints) picks it up automatically.
"""

from __future__ import annotations

from typing import Any

from .base import (
    ApiError,
    Provider,
    Station,
    StationNotTidal,
    TideExtremum,
    UnknownStation,
)
from .noaa import NoaaProvider

_REGISTRY: dict[str, type[Provider]] = {
    NoaaProvider.id: NoaaProvider,
}


def get_provider(provider_id: str, **kwargs: Any) -> Provider:
    """Instantiate the provider with the given ID.

    ``kwargs`` are forwarded to the provider's ``__init__``, letting a
    caller pass e.g. ``datum="MLW"`` for NOAA without hard-coding the
    subclass here.
    """
    try:
        cls = _REGISTRY[provider_id]
    except KeyError as err:
        raise KeyError(f"Unknown tide provider: {provider_id!r}") from err
    return cls(**kwargs)


def list_providers() -> list[tuple[str, str]]:
    """Return ``(id, label)`` pairs for every registered provider."""
    return [(cls.id, cls.label) for cls in _REGISTRY.values()]


__all__ = [
    "ApiError",
    "NoaaProvider",
    "Provider",
    "Station",
    "StationNotTidal",
    "TideExtremum",
    "UnknownStation",
    "get_provider",
    "list_providers",
]
