"""
RangeSmoother — turns a jittery data min/max into a calm, stable Y-axis range.

Why: re-ranging a pyqtgraph axis is expensive (tick/label regeneration, a
second curve update) and visually noisy.  The original chart did it on every
packet.  This class decides *when* the visible range really has to change:

* **expand immediately** — data that leaves the range is never clipped;
* **shrink lazily** — only after the data has stayed well inside the range for
  ``shrink_delay`` seconds, and then only down to the largest target seen in
  that period (so a wobble around a snap boundary can't flip-flop);
* **snap** to ``{1, 2, 5} × 10ⁿ`` multiples so tick labels stay stable;
* optional ``floor`` (range never smaller than this), ``y_min`` (lower clamp).

Pure Python and clock-injected (``now`` is passed in), so it is deterministic
to test and is shared by the Qt chart and the web server.
"""

from __future__ import annotations

import math


def nice_step(x: float) -> float:
    """Smallest value of ``{1, 2, 5, 10} × 10ⁿ`` that is ``>= x``."""
    if not math.isfinite(x) or x <= 0:
        return 1.0
    base = 10.0 ** math.floor(math.log10(x))
    for m in (1.0, 2.0, 5.0, 10.0):
        if m * base >= x * (1.0 - 1e-12):
            return m * base
    return 10.0 * base


def _clean(v: float) -> float:
    return round(v, 10) + 0.0   # tidy float noise; "+ 0.0" turns -0.0 into 0.0


class RangeSmoother:
    def __init__(
        self,
        *,
        y_min: float | None = None,
        floor: tuple[float, float] | None = None,
        margin: float = 0.10,
        min_span: float = 1.0,
        shrink_delay: float = 2.0,
        eval_hz: float = 4.0,
        divisions: int = 8,
    ) -> None:
        self.y_min = y_min
        self.floor = floor
        self.margin = margin
        self.min_span = min_span
        self.shrink_delay = shrink_delay
        self._eval_period = 1.0 / eval_hz
        self.divisions = divisions
        self.reset()

    # ------------------------------------------------------------------
    def reset(self) -> None:
        self._cur: tuple[float, float] | None = None
        self._acc: tuple[float, float] | None = None
        self._hold_until = 0.0
        self._last_eval = 0.0

    @property
    def current(self) -> tuple[float, float] | None:
        return self._cur

    # ------------------------------------------------------------------
    def target(self, lo: float, hi: float) -> tuple[float, float]:
        """The snapped range that would be chosen for data spanning *lo..hi*."""
        if hi - lo < self.min_span:
            c = (lo + hi) / 2.0
            lo, hi = c - self.min_span / 2.0, c + self.min_span / 2.0
        pad = self.margin * (hi - lo)
        t_lo, t_hi = lo - pad, hi + pad
        if self.floor is not None:
            t_lo = min(t_lo, self.floor[0])
            t_hi = max(t_hi, self.floor[1])
        step = nice_step((t_hi - t_lo) / self.divisions)
        t_lo = math.floor(t_lo / step + 1e-9) * step
        t_hi = math.ceil(t_hi / step - 1e-9) * step
        if self.y_min is not None and t_lo < self.y_min:
            t_lo = self.y_min
        if t_hi - t_lo < step:
            t_hi = t_lo + step
        return _clean(t_lo), _clean(t_hi)

    def update(self, lo: float, hi: float, now: float) -> tuple[float, float] | None:
        """Feed the current data min/max; returns the new range *only if it changed*."""
        if not (math.isfinite(lo) and math.isfinite(hi)) or lo > hi:
            return None
        t = self.target(lo, hi)
        cur = self._cur

        if cur is None:
            self._cur = self._acc = t
            self._hold_until = now + self.shrink_delay
            self._last_eval = now
            return t

        # Data left the visible range: grow right away (every call, no rate cap).
        if t[0] < cur[0] or t[1] > cur[1]:
            new = (min(cur[0], t[0]), max(cur[1], t[1]))
            self._cur = new
            self._acc = t
            self._hold_until = now + self.shrink_delay
            self._last_eval = now
            return new

        # Inside the range: remember the largest need, shrink only when calm.
        acc = self._acc if self._acc is not None else t
        self._acc = (min(acc[0], t[0]), max(acc[1], t[1]))
        if now >= self._hold_until and now - self._last_eval >= self._eval_period:
            self._last_eval = now
            target = self._acc
            self._acc = t
            self._hold_until = now + self.shrink_delay
            if target != cur:
                self._cur = target
                return target
        return None
