"""PCHIP interpolation and derived-state helpers for hi/lo tide series.

The knots we get from NOAA's ``interval=hilo`` product alternate between
highs and lows, so every interior knot is a local extremum. Standard
PCHIP (Fritsch-Carlson) sets the derivative at such a knot to 0 to
preserve segment monotonicity — exactly the "zero slope at each peak"
property we want for a tide curve.
"""

from __future__ import annotations

import bisect
from datetime import datetime, timedelta

from .api import TideExtremum


def _pchip_derivatives(x: list[float], y: list[float]) -> list[float]:
    """Fritsch-Carlson PCHIP derivatives at each knot."""
    n = len(x)
    if n < 2:
        return [0.0] * n

    h = [x[i + 1] - x[i] for i in range(n - 1)]
    s = [(y[i + 1] - y[i]) / h[i] for i in range(n - 1)]

    m = [0.0] * n
    for k in range(1, n - 1):
        if s[k - 1] * s[k] <= 0:
            m[k] = 0.0
        else:
            w1 = 2 * h[k] + h[k - 1]
            w2 = h[k] + 2 * h[k - 1]
            m[k] = (w1 + w2) / (w1 / s[k - 1] + w2 / s[k])

    m[0] = _endpoint_slope(h[0], h[1] if n > 2 else h[0], s[0], s[1] if n > 2 else s[0])
    m[-1] = _endpoint_slope(
        h[-1], h[-2] if n > 2 else h[-1], s[-1], s[-2] if n > 2 else s[-1]
    )
    return m


def _endpoint_slope(h0: float, h1: float, s0: float, s1: float) -> float:
    """Monotone one-sided PCHIP endpoint slope (Fritsch-Butland form)."""
    m = ((2 * h0 + h1) * s0 - h0 * s1) / (h0 + h1)
    if m * s0 <= 0:
        return 0.0
    if s0 * s1 < 0 and abs(m) > abs(3 * s0):
        return 3 * s0
    return m


def interpolate_height(
    knots: list[TideExtremum], at: datetime
) -> float | None:
    """PCHIP-interpolated water height at ``at``.

    Returns ``None`` when ``at`` is outside the knot range.
    """
    if len(knots) < 2:
        return None
    if at < knots[0].time or at > knots[-1].time:
        return None

    x = [k.time.timestamp() for k in knots]
    y = [k.height for k in knots]
    tx = at.timestamp()

    i = bisect.bisect_right(x, tx) - 1
    i = max(0, min(i, len(x) - 2))

    m = _pchip_derivatives(x, y)

    h = x[i + 1] - x[i]
    t = (tx - x[i]) / h
    h00 = (1 + 2 * t) * (1 - t) ** 2
    h10 = t * (1 - t) ** 2
    h01 = t * t * (3 - 2 * t)
    h11 = t * t * (t - 1)

    return h00 * y[i] + h10 * h * m[i] + h01 * y[i + 1] + h11 * h * m[i + 1]


def compute_tide_state(
    knots: list[TideExtremum],
    now: datetime,
    hold_window: timedelta = timedelta(minutes=10),
) -> str | None:
    """Return "rising", "falling", "high", or "low" for the given moment.

    ``high`` and ``low`` are reported when ``now`` sits within
    ``hold_window`` of the nearest knot of that type; otherwise the
    direction (``rising`` between L→H, ``falling`` between H→L) is
    reported.
    """
    if not knots:
        return None

    nearest = min(knots, key=lambda k: abs(k.time - now))
    if abs(nearest.time - now) <= hold_window:
        return "high" if nearest.type == "H" else "low"

    if now < knots[0].time:
        return "rising" if knots[0].type == "H" else "falling"
    if now > knots[-1].time:
        return "rising" if knots[-1].type == "L" else "falling"

    for i in range(len(knots) - 1):
        if knots[i].time <= now < knots[i + 1].time:
            return "rising" if knots[i + 1].type == "H" else "falling"
    return None
