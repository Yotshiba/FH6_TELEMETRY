"""The QR encoder, checked against the standard rather than against itself.

* published byte capacities (all four levels, versions 1-20) prove the block / error-correction tables
* a known Reed-Solomon vector, the known format / version words and the standard's alignment-pattern table
* an independently written decoder (its own function-pattern map, zig-zag reader and block de-interleaver)
  reads back what the encoder wrote, at every version and level, at the capacity boundaries
"""

from __future__ import annotations

import itertools
import random
import re
import xml.etree.ElementTree as ET

import pytest

from fh6_telemetry.core import qr
from fh6_telemetry.core.qr import (
    ECC_LEVELS, MAX_VERSION, QrCode, _Builder, _alignment_positions, capacity_bytes, encode, format_bits,
    rs_generator, rs_remainder, to_svg, to_text, version_bits,
)

# Published maximum numbers of bytes in byte mode (ISO/IEC 18004 table 7), versions 1..20.
CAPACITY = {
    "L": [17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586, 644, 718, 792, 858],
    "M": [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666],
    "Q": [11, 20, 32, 46, 60, 74, 86, 108, 130, 151, 177, 203, 241, 258, 292, 322, 364, 394, 442, 482],
    "H": [7, 14, 24, 34, 44, 58, 64, 84, 98, 119, 137, 155, 177, 194, 220, 250, 280, 310, 338, 382],
}

# Alignment pattern centre coordinates from annex E of the standard.
ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42],
    9: [6, 26, 46], 10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
    15: [6, 26, 48, 70], 16: [6, 26, 50, 74], 17: [6, 30, 54, 78], 18: [6, 30, 56, 82], 19: [6, 30, 58, 86],
    20: [6, 34, 62, 90],
}


# ---------------------------------------------------------------------------
# known answers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("ecc", ECC_LEVELS)
def test_byte_capacity_of_every_version_matches_the_standard(ecc):
    assert [capacity_bytes(v, ecc) for v in range(1, MAX_VERSION + 1)] == CAPACITY[ecc]


def test_reed_solomon_known_answer():
    """The worked example of the HELLO WORLD symbol (version 1-M): 16 data codewords, 10 error-correction codewords."""
    data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]
    assert rs_remainder(data, rs_generator(10)) == [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]
    # the degree-7 generator of version 1-L: x^7 + 127x^6 + 122x^5 + 154x^4 + 164x^3 + 11x^2 + 68x + 117
    assert rs_generator(7) == [127, 122, 154, 164, 11, 68, 117]


def test_format_words_known_values():
    # mask 0 of every level (the standard's table of the 32 format words)
    assert [format_bits(e, 0) for e in ("L", "M", "Q", "H")] == [0x77C4, 0x5412, 0x355F, 0x1689]
    # the whole level-L row of that table
    assert [format(format_bits("L", k), "015b") for k in range(8)] == [
        "111011111000100", "111001011110011", "111110110101010", "111100010011101",
        "110011000101111", "110001100011000", "110110001000001", "110100101110110",
    ]
    # every word is a BCH(15,5) codeword (generator x^10+x^8+x^5+x^4+x^2+x+1 = 0x537) and the 32 words are far apart
    words = [format_bits(e, k) for e in ECC_LEVELS for k in range(8)]
    for w in words:
        rem = w ^ 0x5412
        for bit in range(14, 9, -1):
            if rem >> bit & 1:
                rem ^= 0x537 << (bit - 10)
        assert rem == 0
    assert min(bin(a ^ b).count("1") for a, b in itertools.combinations(words, 2)) >= 7   # BCH(15,5): minimum distance 7 (corrects 3 bit errors)


def test_version_words_known_values():
    assert [version_bits(v) for v in (7, 8, 9, 10, 15)] == [0x07C94, 0x085BC, 0x09A99, 0x0A4D3, 0x0F928]
    assert version_bits(7) == 0b000111110010010100
    assert version_bits(8) == 0b001000010110111100


@pytest.mark.parametrize("v", range(1, MAX_VERSION + 1))
def test_alignment_positions_match_the_standard(v):
    assert _alignment_positions(v) == ALIGN[v]


# ---------------------------------------------------------------------------
# an independent reader
# ---------------------------------------------------------------------------


def _function_map(v: int) -> list[list[bool]]:
    n = 17 + 4 * v
    f = [[False] * n for _ in range(n)]

    def fill(x0, y0, x1, y1):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                f[y][x] = True

    fill(0, 0, 8, 8)                         # top-left finder + separator + format
    fill(n - 8, 0, n - 1, 8)                 # top-right
    fill(0, n - 8, 8, n - 1)                 # bottom-left (includes the dark module)
    fill(6, 0, 6, n - 1)                     # timing
    fill(0, 6, n - 1, 6)
    pos = ALIGN[v]
    for cx, cy in itertools.product(pos, pos):
        if (cx, cy) in {(6, 6), (6, pos[-1]), (pos[-1], 6)}:
            continue
        fill(cx - 2, cy - 2, cx + 2, cy + 2)
    if v >= 7:
        fill(n - 11, 0, n - 9, 5)
        fill(0, n - 11, 5, n - 9)
    return f


def decode(code: QrCode) -> bytes:
    n, v = code.size, code.version
    assert n == 17 + 4 * v
    m = [[1 if code.get(x, y) else 0 for x in range(n)] for y in range(n)]

    # --- format information (first copy), error-corrected against all 32 valid words, second copy must agree
    first = [m[i][8] for i in range(6)] + [m[7][8], m[8][8], m[8][7]] + [m[8][14 - i] for i in range(9, 15)]
    word = sum(b << i for i, b in enumerate(first))
    second = [m[8][n - 1 - i] for i in range(8)] + [m[n - 15 + i][8] for i in range(8, 15)]
    assert sum(b << i for i, b in enumerate(second)) == word, "the two copies of the format word differ"
    valid = {format_bits(e, k): (e, k) for e in ECC_LEVELS for k in range(8)}
    assert word in valid, "format word is not one of the 32 valid words"
    ecc, mask = valid[word]
    assert (ecc, mask) == (code.ecc, code.mask)
    assert m[n - 8][8] == 1, "the dark module"

    # --- version information (v >= 7): both copies
    if v >= 7:
        vw = version_bits(v)
        for i in range(18):
            assert m[i // 3][n - 11 + i % 3] == ((vw >> i) & 1)
            assert m[n - 11 + i % 3][i // 3] == ((vw >> i) & 1)

    # --- zig-zag read of the data modules, unmasked
    fn = _function_map(v)
    inv = [
        lambda x, y: (x + y) % 2 == 0, lambda x, y: y % 2 == 0, lambda x, y: x % 3 == 0,
        lambda x, y: (x + y) % 3 == 0, lambda x, y: (x // 3 + y // 2) % 2 == 0,
        lambda x, y: (x * y) % 2 + (x * y) % 3 == 0, lambda x, y: ((x * y) % 2 + (x * y) % 3) % 2 == 0,
        lambda x, y: ((x + y) % 2 + (x * y) % 3) % 2 == 0,
    ][mask]
    bits, x, up = [], n - 1, True
    while x > 0:
        if x == 6:
            x -= 1
        for y in (range(n - 1, -1, -1) if up else range(n)):
            for xx in (x, x - 1):
                if not fn[y][xx]:
                    bits.append(m[y][xx] ^ (1 if inv(xx, y) else 0))
        up = not up
        x -= 2
    codewords = [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits) - len(bits) % 8, 8)]
    assert len(codewords) == qr._raw_modules(v) // 8

    # --- de-interleave into blocks and check every block's Reed-Solomon code
    nb, eb = qr._NUM_BLOCKS[ecc][v - 1], qr._ECC_PER_BLOCK[ecc][v - 1]
    total = len(codewords)
    short = total // nb
    n_short = nb - total % nb
    lens = [short - eb + (0 if i < n_short else 1) for i in range(nb)]
    data_blocks = [[] for _ in range(nb)]
    pos = 0
    for i in range(max(lens)):
        for b in range(nb):
            if i < lens[b]:
                data_blocks[b].append(codewords[pos])
                pos += 1
    ecc_blocks = [[] for _ in range(nb)]
    for _ in range(eb):
        for b in range(nb):
            ecc_blocks[b].append(codewords[pos])
            pos += 1
    assert pos == total
    gen = rs_generator(eb)
    for b in range(nb):
        assert rs_remainder(data_blocks[b], gen) == ecc_blocks[b], f"block {b} fails its Reed-Solomon check"

    # --- parse the byte-mode segment
    stream = "".join(f"{c:08b}" for blk in data_blocks for c in blk)
    assert stream[:4] == "0100", "byte mode indicator"
    cb = 8 if v <= 9 else 16
    count = int(stream[4:4 + cb], 2)
    body = stream[4 + cb:4 + cb + count * 8]
    out = bytes(int(body[i:i + 8], 2) for i in range(0, len(body), 8))
    rest = stream[4 + cb + count * 8:]
    assert set(rest[:4]) <= {"0"}, "terminator"
    pad = rest[4 + (-(4 + cb + count * 8 + min(4, len(rest))) % 8):]
    expect = "".join(f"{b:08b}" for b in itertools.islice(itertools.cycle([0xEC, 0x11]), len(pad) // 8))
    assert pad == expect, "pad codewords alternate 0xEC / 0x11"
    return out


# ---------------------------------------------------------------------------
# round trips
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("ecc", ECC_LEVELS)
def test_every_version_round_trips_at_its_exact_capacity(ecc):
    rng = random.Random(7)
    for v in range(1, MAX_VERSION + 1):
        cap = capacity_bytes(v, ecc)
        text = bytes(rng.randrange(256) for _ in range(cap))
        code = encode(text, ecc)
        assert code.version == v, f"{cap} bytes at {ecc} should need exactly version {v}, got {code.version}"
        assert decode(code) == text
        if v < MAX_VERSION:
            bigger = encode(text + b"x", ecc)
            assert bigger.version == v + 1, "one byte more moves to the next version"
            assert decode(bigger) == text + b"x"


@pytest.mark.parametrize("ecc", ECC_LEVELS)
def test_short_and_awkward_inputs_round_trip(ecc):
    for text in ["", "a", "http://192.168.1.101:8077/", "FH6-" + "A1_-" * 20, "ünïcödé ✓ 🚗", "0" * 33, "\x00\xff" * 5]:
        raw = text.encode("utf-8") if isinstance(text, str) else text
        code = encode(text, ecc)
        assert decode(code) == raw
        assert code.size == 17 + 4 * code.version


def test_min_version_and_too_long_inputs():
    assert encode("hi", "L", min_version=5).version == 5
    with pytest.raises(ValueError):
        encode("x" * (capacity_bytes(MAX_VERSION, "M") + 1), "M")
    with pytest.raises(ValueError):
        encode("x" * (capacity_bytes(MAX_VERSION, "L") + 1), "L")
    with pytest.raises(ValueError):
        encode("x", "Z")
    assert encode("x" * capacity_bytes(MAX_VERSION, "M"), "M").version == MAX_VERSION


def test_mask_choice_is_the_lowest_penalty_and_output_is_deterministic():
    text = "http://192.168.1.101:8077/?cockpit=FH6-abcDEF123"
    code = encode(text, "M")
    assert encode(text, "M") == code
    # recompute all eight penalties independently of encode()
    builder = _Builder(code.version, code.ecc)
    data = list(text.encode())
    # (the codewords the encoder used are not exposed: rebuild them through the same public helpers)
    bits = [int(c) for c in f"0100{len(data):08b}" + "".join(f"{b:08b}" for b in data)]
    cap = qr._data_codewords(code.version, "M") * 8
    bits += [0] * min(4, cap - len(bits))
    bits += [0] * (-len(bits) % 8)
    pad = 0xEC
    while len(bits) < cap:
        bits += [int(c) for c in f"{pad:08b}"]
        pad ^= 0xEC ^ 0x11
    words = [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]
    builder.place(qr._add_ecc_and_interleave(words, code.version, "M"))
    pens = []
    for mask in range(8):
        builder.apply_mask(mask)
        builder.draw_format(mask)
        pens.append(builder.penalty())
        builder.apply_mask(mask)
    assert code.mask == pens.index(min(pens))


# ---------------------------------------------------------------------------
# structure
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("v", [1, 2, 7, 14, 20])
def test_function_patterns_are_where_the_standard_puts_them(v):
    code = encode("x", "L", min_version=v)
    n = code.size
    g = code.get
    for cx, cy in ((3, 3), (n - 4, 3), (3, n - 4)):                 # finder patterns: 7x7 ring, 3x3 core, light ring between
        for dy in range(-3, 4):
            for dx in range(-3, 4):
                ring = max(abs(dx), abs(dy))
                assert g(cx + dx, cy + dy) == (ring != 2), (v, cx, cy, dx, dy)
    for i in range(8, n - 8):                                        # timing patterns
        assert g(6, i) == (i % 2 == 0) and g(i, 6) == (i % 2 == 0)
    assert g(8, n - 8), "dark module"
    for cx, cy in itertools.product(ALIGN[v], ALIGN[v]):             # alignment patterns
        if (cx, cy) in {(6, 6), (6, ALIGN[v][-1]), (ALIGN[v][-1], 6)}:
            continue
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                assert g(cx + dx, cy + dy) == (max(abs(dx), abs(dy)) != 1)


def test_quiet_zone_reads_as_light():
    code = encode("x")
    assert not code.get(-1, 0) and not code.get(0, -1) and not code.get(code.size, 0) and not code.get(0, code.size)


# ---------------------------------------------------------------------------
# output formats
# ---------------------------------------------------------------------------


def _modules_from_svg(svg: str, size: int, border: int) -> set[tuple[int, int]]:
    root = ET.fromstring(svg)
    ns = "{http://www.w3.org/2000/svg}"
    d = root.find(f"{ns}path").attrib["d"]
    dark = set()
    for m in re.finditer(r"M(\d+),(\d+)h(\d+)v1h-\d+z", d):
        x, y, w = int(m.group(1)) - border, int(m.group(2)) - border, int(m.group(3))
        dark.update((x + i, y) for i in range(w))
    return dark


def test_svg_is_valid_xml_and_reproduces_every_module():
    code = encode("http://192.168.1.101:8077/", "M")
    svg = to_svg(code)
    root = ET.fromstring(svg)
    n = code.size + 8
    assert root.attrib["viewBox"] == f"0 0 {n} {n}"
    assert root.find("{http://www.w3.org/2000/svg}rect").attrib["fill"] == "#ffffff"
    dark = _modules_from_svg(svg, code.size, 4)
    assert dark == {(x, y) for y in range(code.size) for x in range(code.size) if code.get(x, y)}
    assert to_svg(code, border=0, dark="#112233", light="#eeeeee").count("#112233") == 1
    assert "<script" not in svg and "javascript" not in svg


def test_terminal_art_blocks_and_ascii_encode_the_same_symbol():
    code = encode("hello", "L")
    n = code.size + 4                                       # two light modules around, as to_text() draws it

    def dark(x, y):
        return code.get(x - 2, y - 2)

    art = to_text(code, border=2, blocks=True).split("\n")
    assert len(art) == (n + 1) // 2 and all(len(line) == n for line in art)
    inverse = {v: k for k, v in qr._BLOCKS.items()}
    for ly, line in enumerate(art):
        for x, ch in enumerate(line):
            top, bottom = inverse[ch]
            assert top == dark(x, 2 * ly) and bottom == dark(x, 2 * ly + 1)
    plain = to_text(code, border=2, blocks=False).split("\n")
    assert len(plain) == n and all(len(line) == 2 * n for line in plain)
    for y, line in enumerate(plain):
        for x in range(n):
            assert line[2 * x:2 * x + 2] == ("  " if dark(x, y) else "##")
    assert all(ord(c) < 128 for line in plain for c in line)


def test_can_print_blocks_depends_on_the_console_encoding():
    assert qr.can_print_blocks("utf-8") and qr.can_print_blocks("cp437") and qr.can_print_blocks("cp850")
    assert not qr.can_print_blocks("cp1252") and not qr.can_print_blocks("ascii")
    assert not qr.can_print_blocks("no-such-codec") and not qr.can_print_blocks(None)


def test_generating_a_large_symbol_is_fast_enough_for_a_request_handler():
    import time

    t0 = time.perf_counter()
    encode("y" * 400, "M")
    assert time.perf_counter() - t0 < 1.5
