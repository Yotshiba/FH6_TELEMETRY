"""RingBuffer behaves exactly like deque(maxlen=capacity) per series."""

from __future__ import annotations

import random
from collections import deque

import numpy as np
import pytest

from fh6_telemetry.gui.ringbuffer import RingBuffer


@pytest.mark.parametrize("capacity", [1, 2, 5, 300])
def test_matches_deque_reference_over_many_wraps(capacity):
    rng = random.Random(capacity)
    rb = RingBuffer(3, capacity)
    refs = [deque(maxlen=capacity) for _ in range(3)]
    for step in range(capacity * 4 + 7):
        row = [rng.random() * 100 for _ in range(3)]
        rb.append(row)
        for r, v in zip(refs, row):
            r.append(v)
        if step % 7 == 0 or step < 3:
            w = rb.window()
            assert w.shape == (3, min(step + 1, capacity))
            for i in range(3):
                assert list(w[i]) == pytest.approx(list(refs[i]))


def test_window_is_contiguous_and_ordered_oldest_first():
    rb = RingBuffer(1, 4)
    for v in range(10):
        rb.append([float(v)])
    w = rb.window()
    assert list(w[0]) == [6.0, 7.0, 8.0, 9.0]
    assert w[0].flags["C_CONTIGUOUS"]


def test_partial_fill_and_minmax():
    rb = RingBuffer(2, 10)
    assert rb.count == 0 and rb.minmax() is None
    rb.extend([[1, 10], [3, 5], [2, 7]])
    assert rb.count == 3 and rb.minmax() == (1.0, 10.0)
    assert rb.window().shape == (2, 3)


def test_extend_with_more_than_capacity_keeps_the_latest():
    rb = RingBuffer(1, 3)
    rb.extend([[float(i)] for i in range(10)])
    assert list(rb.window()[0]) == [7.0, 8.0, 9.0]


def test_extend_empty_is_a_noop_and_clear_resets():
    rb = RingBuffer(1, 3)
    rb.extend([])
    assert rb.count == 0
    rb.append([1.0])
    rb.clear()
    assert rb.count == 0 and rb.minmax() is None
    rb.append([5.0])
    assert list(rb.window()[0]) == [5.0]


def test_window_aliases_the_buffer_so_callers_must_copy():
    rb = RingBuffer(1, 3)
    rb.extend([[1.0], [2.0], [3.0]])
    snapshot = np.array(rb.window())
    rb.append([4.0])
    assert list(snapshot[0]) == [1.0, 2.0, 3.0]          # the copy is untouched
    assert list(rb.window()[0]) == [2.0, 3.0, 4.0]


def test_rejects_bad_dimensions():
    with pytest.raises(ValueError):
        RingBuffer(0, 5)
    with pytest.raises(ValueError):
        RingBuffer(1, 0)
