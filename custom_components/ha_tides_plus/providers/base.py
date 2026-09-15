"""Provider abstraction for tide-prediction data sources.

A provider hides the source-specific station catalogue and prediction
API behind a small interface. Everything downstream of the coordinator
(sensors, events, cards, WebSocket API, blueprints) is provider-agnostic
and reads the normalised ``TideExtremum`` list this module defines.

To add a new provider, subclass :class:`Provider`, implement the three
async methods, and register the class in ``providers/__init__.py``.
See ``docs/providers.md`` for the full how-to.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from typing import ClassVar, Literal

from aiohttp import ClientSession


class ApiError(Exception):
    """Raised when the upstream API cannot be reached or returns an error."""


class UnknownStation(ApiError):
    """Raised when the station ID is not present in the provider's catalog."""


class StationNotTidal(ApiError):
    """Raised when the station exists but does not publish tide predictions."""


@dataclass(frozen=True, slots=True)
class Station:
    """Static metadata for a tide station.

    All providers populate the same shape. ``region`` is the sub-national
    area (US state code, NL province, …) or ``None`` when the provider has
    no notion of one.
    """

    id: str
    name: str
    lat: float
    lng: float
    state: str | None
    tide_type: str | None = None


@dataclass(frozen=True, slots=True)
class TideExtremum:
    """One high or low tide prediction.

    Heights are always metres; times are always UTC-aware.
    """

    time: datetime
    height: float
    type: Literal["H", "L"]


class Provider(ABC):
    """Base class for a tide-prediction data source.

    Class attributes identify and label the provider. Instance methods
    fetch the station catalogue and predictions. All providers speak
    metres and UTC-aware datetimes on the wire this class defines.
    """

    id: ClassVar[str]
    label: ClassVar[str]
    attribution: ClassVar[str]
    manufacturer: ClassVar[str]

    @abstractmethod
    async def list_stations(self, session: ClientSession) -> list[Station]:
        """Return every tide-prediction station this provider knows about.

        Callers cache the result for one config-flow session; a single
        catalogue fetch may cost seconds and hundreds of kilobytes.
        """

    @abstractmethod
    async def get_station(self, session: ClientSession, station_id: str) -> Station:
        """Look up a single station by its provider-native ID.

        Raises :class:`UnknownStation` if the ID is not in the catalogue,
        :class:`StationNotTidal` if it exists but has no tide predictions,
        and :class:`ApiError` for network / parse failures.
        """

    @abstractmethod
    async def get_hilo_predictions(
        self,
        session: ClientSession,
        station_id: str,
        *,
        begin: datetime,
        hours: int,
    ) -> list[TideExtremum]:
        """Return the high / low tide knots covering ``[begin, begin+hours)``.

        Times are UTC-aware; heights are metres above the provider's
        native datum (MLLW for NOAA, NAP for RWS). The list is sorted
        by time.
        """

    def station_url(self, station_id: str) -> str | None:
        """Return a browser URL for the station's provider page, or ``None``.

        Used as ``DeviceInfo.configuration_url``.
        """
        return None

    def parse_direct_id(self, query: str) -> str | None:
        """If ``query`` is a bare, provider-native station ID, return it.

        Lets the config flow short-circuit the geocode + nearest-station
        picker when the user pastes a known ID. Return ``None`` if the
        query does not match this provider's ID shape.
        """
        return None
