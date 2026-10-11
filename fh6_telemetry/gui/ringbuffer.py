"""
RingBuffer — fixed-capacity, multi-series history with an O(1) append and a
*contiguous* oldest→newest window (no ``np.roll`` / deque→array copies).

Every sample is written twice, at ``i`` and ``i + capacity``, so the latest
``capacity`` samples are always one contiguous slice of the doubled buffer.
"""

from __future__ import annotations

from typing import Sequence

import numpy as np


class RingBuffer:
    def __init__(self, n_series: int, capacity: int) -> None:
        if n_series < 1 or capacity < 1:
            raise ValueError("n_series and capacity must be >= 1")
        self.n_series = n_series
        self.capacity = capacity
        self._buf = np.zeros((n_series, 2 * capacity), dtype=np.float64)
        self._head = 0       # next write position, 0 <= head < capacity
        self.count = 0       # valid samples, <= capacity

    def clear(self) -> None:
        self._head = 0
        self.count = 0

    def append(self, row: Sequence[float]) -> None:
        i = self._head
        self._buf[:, i] = row
        self._buf[:, i + self.capacity] = row
        self._head = (i + 1) % self.capacity
        if self.count < self.capacity:
            self.count += 1

    def extend(self, rows: Sequence[Sequence[float]]) -> None:
        for row in rows:
            self.append(row)

    def window(self) -> np.ndarray:
        """View of the valid samples, shape ``(n_series, count)``, oldest first.

        It aliases the buffer — copy before handing it to anything that keeps it.
        """
        end = self._head + self.capacity
        return self._buf[:, end - self.count:end]

    def minmax(self) -> tuple[float, float] | None:
        """Overall (min, max) of the valid samples, or None when empty."""
        if self.count == 0:
            return None
        w = self.window()
        return float(w.min()), float(w.max())
