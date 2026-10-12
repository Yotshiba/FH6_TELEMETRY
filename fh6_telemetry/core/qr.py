"""
A small QR Code generator (ISO/IEC 18004), standard library only.

Used to show the dashboard's address (and shared cockpit layouts) as a code a phone camera can scan: on the
launcher, in the headless console and on the web page (``/api/qr.svg``).

Scope: byte mode (any UTF-8 text), versions 1-20 (up to 666 bytes at level M, 858 at L), error correction
levels L/M/Q/H, automatic mask selection.  Qt-free and numpy-free.

    qr = encode("http://192.168.1.101:8077/", "M")
    qr.size, qr.get(x, y)           # modules (True = dark)
    to_svg(qr)                      # a complete <svg> document
    to_text(qr)                     # terminal art

The tables and algorithms follow the specification; ``tests/test_qr.py`` checks the capacity table against the
published byte capacities, the Reed-Solomon coder and the format / version words against known values, and decodes
generated symbols with an independently written reader.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

MAX_VERSION = 20
ECC_LEVELS = ("L", "M", "Q", "H")
_FORMAT_BITS = {"L": 1, "M": 0, "Q": 3, "H": 2}

# Per version 1..20 (index 0 = version 1): error-correction codewords per block, and number of blocks.
_ECC_PER_BLOCK = {
    "L": (7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28),
    "M": (10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26),
    "Q": (13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30),
    "H": (17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28),
}
_NUM_BLOCKS = {
    "L": (1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8),
    "M": (1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16),
    "Q": (1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20),
    "H": (1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25),
}

_PENALTY_N1, _PENALTY_N2, _PENALTY_N3, _PENALTY_N4 = 3, 3, 40, 10


# ---------------------------------------------------------------------------
# capacity
# ---------------------------------------------------------------------------


def _size(version: int) -> int:
    return version * 4 + 17


def _raw_modules(version: int) -> int:
    """Number of modules that carry data + error correction (everything but the function patterns)."""
    result = (16 * version + 128) * version + 64
    if version >= 2:
        n_align = version // 7 + 2
        result -= (25 * n_align - 10) * n_align - 55
        if version >= 7:
            result -= 36
    return result


def _data_codewords(version: int, ecc: str) -> int:
    return _raw_modules(version) // 8 - _ECC_PER_BLOCK[ecc][version - 1] * _NUM_BLOCKS[ecc][version - 1]


def _count_bits(version: int) -> int:
    """Width of the byte-mode character count."""
    return 8 if version <= 9 else 16


def capacity_bytes(version: int, ecc: str = "M") -> int:
    """How many bytes of text fit in a symbol of this version and error-correction level."""
    return (_data_codewords(version, ecc) * 8 - 4 - _count_bits(version)) // 8


def max_bytes(ecc: str = "M") -> int:
    return capacity_bytes(MAX_VERSION, ecc)


# ---------------------------------------------------------------------------
# Reed-Solomon over GF(2^8) / x^8 + x^4 + x^3 + x^2 + 1
# ---------------------------------------------------------------------------


def _gf_mul(x: int, y: int) -> int:
    z = 0
    for i in range(7, -1, -1):
        z = (z << 1) ^ ((z >> 7) * 0x11D)
        z ^= ((y >> i) & 1) * x
    return z


def rs_generator(degree: int) -> list[int]:
    """Coefficients (highest first, the leading 1 omitted) of the generator polynomial of this degree."""
    result = [0] * (degree - 1) + [1]
    root = 1
    for _ in range(degree):
        for j in range(degree):
            result[j] = _gf_mul(result[j], root)
            if j + 1 < degree:
                result[j] ^= result[j + 1]
        root = _gf_mul(root, 2)
    return result


def rs_remainder(data: list[int] | bytes, divisor: list[int]) -> list[int]:
    """The error-correction codewords for `data`."""
    result = [0] * len(divisor)
    for b in data:
        factor = b ^ result.pop(0)
        result.append(0)
        for i, coef in enumerate(divisor):
            result[i] ^= _gf_mul(coef, factor)
    return result


# ---------------------------------------------------------------------------
# format / version words
# ---------------------------------------------------------------------------


def format_bits(ecc: str, mask: int) -> int:
    """The 15-bit format information word (BCH(15,5), XOR 0x5412)."""
    data = (_FORMAT_BITS[ecc] << 3) | mask
    rem = data
    for _ in range(10):
        rem = (rem << 1) ^ ((rem >> 9) * 0x537)
    return ((data << 10) | rem) ^ 0x5412


def version_bits(version: int) -> int:
    """The 18-bit version information word (Golay(18,6)), versions 7 and up."""
    rem = version
    for _ in range(12):
        rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
    return (version << 12) | rem


def _bit(value: int, i: int) -> bool:
    return ((value >> i) & 1) != 0


# ---------------------------------------------------------------------------
# the symbol
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class QrCode:
    version: int
    ecc: str
    mask: int
    modules: tuple[tuple[bool, ...], ...]       # modules[y][x], True = dark

    @property
    def size(self) -> int:
        return len(self.modules)

    def get(self, x: int, y: int) -> bool:
        """The module at column x, row y; outside the symbol it is light (the quiet zone)."""
        return 0 <= x < self.size and 0 <= y < self.size and self.modules[y][x]


def _alignment_positions(version: int) -> list[int]:
    if version == 1:
        return []
    n_align = version // 7 + 2
    step = 26 if version == 32 else (version * 4 + n_align * 2 + 1) // (n_align * 2 - 2) * 2
    result = [_size(version) - 7 - i * step for i in range(n_align - 1)] + [6]
    return result[::-1]


class _Builder:
    """Draws the function patterns, places the codewords and applies a mask."""

    def __init__(self, version: int, ecc: str) -> None:
        self.version, self.ecc, self.size = version, ecc, _size(version)
        self.modules = [[False] * self.size for _ in range(self.size)]
        self.is_function = [[False] * self.size for _ in range(self.size)]
        self._draw_function_patterns()

    def _set(self, x: int, y: int, dark: bool) -> None:
        self.modules[y][x] = dark
        self.is_function[y][x] = True

    def _draw_function_patterns(self) -> None:
        n = self.size
        for i in range(n):                                   # timing patterns
            self._set(6, i, i % 2 == 0)
            self._set(i, 6, i % 2 == 0)
        self._finder(3, 3)
        self._finder(n - 4, 3)
        self._finder(3, n - 4)
        pos = _alignment_positions(self.version)
        for i, cx in enumerate(pos):
            for j, cy in enumerate(pos):
                if not ((i == 0 and j == 0) or (i == 0 and j == len(pos) - 1) or (i == len(pos) - 1 and j == 0)):
                    self._alignment(cx, cy)
        self.draw_format(0)                                   # reserve the format area (rewritten per mask)
        self._draw_version()

    def _finder(self, cx: int, cy: int) -> None:
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                x, y = cx + dx, cy + dy
                if 0 <= x < self.size and 0 <= y < self.size:
                    self._set(x, y, max(abs(dx), abs(dy)) not in (2, 4))

    def _alignment(self, cx: int, cy: int) -> None:
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                self._set(cx + dx, cy + dy, max(abs(dx), abs(dy)) != 1)

    def draw_format(self, mask: int) -> None:
        bits = format_bits(self.ecc, mask)
        n = self.size
        for i in range(0, 6):                                 # first copy, around the top-left finder
            self._set(8, i, _bit(bits, i))
        self._set(8, 7, _bit(bits, 6))
        self._set(8, 8, _bit(bits, 7))
        self._set(7, 8, _bit(bits, 8))
        for i in range(9, 15):
            self._set(14 - i, 8, _bit(bits, i))
        for i in range(0, 8):                                 # second copy, split between the other two finders
            self._set(n - 1 - i, 8, _bit(bits, i))
        for i in range(8, 15):
            self._set(8, n - 15 + i, _bit(bits, i))
        self._set(8, n - 8, True)                             # the always-dark module

    def _draw_version(self) -> None:
        if self.version < 7:
            return
        bits = version_bits(self.version)
        for i in range(18):
            a, b = self.size - 11 + i % 3, i // 3
            self._set(a, b, _bit(bits, i))
            self._set(b, a, _bit(bits, i))

    def place(self, codewords: list[int]) -> None:
        """Zig-zag the data bits up and down the column pairs from the bottom-right corner."""
        n = self.size
        i = 0
        total = len(codewords) * 8
        for right in range(n - 1, 0, -2):
            if right <= 6:
                right -= 1                                    # the timing column is skipped
            for vert in range(n):
                for j in range(2):
                    x = right - j
                    upward = (right + 1) & 2 == 0
                    y = (n - 1 - vert) if upward else vert
                    if not self.is_function[y][x] and i < total:
                        self.modules[y][x] = _bit(codewords[i >> 3], 7 - (i & 7))
                        i += 1

    def apply_mask(self, mask: int) -> None:
        """XOR the mask over the data modules (applying the same mask again undoes it)."""
        for y in range(self.size):
            row, fn = self.modules[y], self.is_function[y]
            for x in range(self.size):
                if fn[x]:
                    continue
                if mask == 0:
                    inv = (x + y) % 2 == 0
                elif mask == 1:
                    inv = y % 2 == 0
                elif mask == 2:
                    inv = x % 3 == 0
                elif mask == 3:
                    inv = (x + y) % 3 == 0
                elif mask == 4:
                    inv = (x // 3 + y // 2) % 2 == 0
                elif mask == 5:
                    inv = x * y % 2 + x * y % 3 == 0
                elif mask == 6:
                    inv = (x * y % 2 + x * y % 3) % 2 == 0
                else:
                    inv = ((x + y) % 2 + x * y % 3) % 2 == 0
                if inv:
                    row[x] = not row[x]

    def penalty(self) -> int:
        n = self.size
        rows = ["".join("1" if m else "0" for m in row) for row in self.modules]
        cols = ["".join("1" if self.modules[y][x] else "0" for y in range(n)) for x in range(n)]
        score = 0
        for line in rows + cols:
            for run in re.finditer(r"0{5,}|1{5,}", line):                 # N1: runs of five or more
                score += _PENALTY_N1 + len(run.group()) - 5
            for pat in ("10111010000", "00001011101"):                    # N3: finder-like 1:1:3:1:1 with a light run
                start = line.find(pat)
                while start >= 0:
                    score += _PENALTY_N3
                    start = line.find(pat, start + 1)
        for y in range(n - 1):                                            # N2: 2x2 blocks of one colour
            a, b = rows[y], rows[y + 1]
            for x in range(n - 1):
                if a[x] == a[x + 1] == b[x] == b[x + 1]:
                    score += _PENALTY_N2
        dark = sum(row.count("1") for row in rows)                        # N4: dark / light balance
        total = n * n
        k = (abs(dark * 20 - total * 10) + total - 1) // total - 1
        return score + max(0, k) * _PENALTY_N4


def _add_ecc_and_interleave(data: list[int], version: int, ecc: str) -> list[int]:
    n_blocks = _NUM_BLOCKS[ecc][version - 1]
    block_ecc = _ECC_PER_BLOCK[ecc][version - 1]
    raw = _raw_modules(version) // 8
    n_short = n_blocks - raw % n_blocks
    short_len = raw // n_blocks
    gen = rs_generator(block_ecc)
    blocks, k = [], 0
    for i in range(n_blocks):
        dat_len = short_len - block_ecc + (0 if i < n_short else 1)
        dat = data[k:k + dat_len]
        k += dat_len
        e = rs_remainder(dat, gen)
        if i < n_short:
            dat = dat + [0]                                   # a placeholder so every block has the same length
        blocks.append(dat + e)
    out = []
    for i in range(len(blocks[0])):
        for j, blk in enumerate(blocks):
            if i != short_len - block_ecc or j >= n_short:    # skip the placeholder
                out.append(blk[i])
    return out


def encode(text: str | bytes, ecc: str = "M", min_version: int = 1) -> QrCode:
    """Encode text (UTF-8) as a QR symbol. Raises ValueError if it does not fit in version 20."""
    if ecc not in ECC_LEVELS:
        raise ValueError(f"unknown error correction level {ecc!r}")
    data = text.encode("utf-8") if isinstance(text, str) else bytes(text)
    for version in range(max(1, min_version), MAX_VERSION + 1):
        if 4 + _count_bits(version) + len(data) * 8 <= _data_codewords(version, ecc) * 8:
            break
    else:
        raise ValueError(f"{len(data)} bytes do not fit in a QR code at level {ecc} (limit {max_bytes(ecc)})")

    bits: list[int] = []

    def put(value: int, n: int) -> None:
        bits.extend((value >> i) & 1 for i in range(n - 1, -1, -1))

    put(0b0100, 4)                                            # byte mode
    put(len(data), _count_bits(version))
    for b in data:
        put(b, 8)
    capacity = _data_codewords(version, ecc) * 8
    put(0, min(4, capacity - len(bits)))                      # terminator
    put(0, -len(bits) % 8)                                    # to a byte boundary
    pad = 0xEC
    while len(bits) < capacity:                               # alternate the two pad codewords
        put(pad, 8)
        pad ^= 0xEC ^ 0x11
    codewords = [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]

    final = _add_ecc_and_interleave(codewords, version, ecc)
    best_mask, best_penalty, best = 0, None, None
    builder = _Builder(version, ecc)
    builder.place(final)
    for mask in range(8):
        builder.apply_mask(mask)
        builder.draw_format(mask)
        p = builder.penalty()
        if best_penalty is None or p < best_penalty:
            best_mask, best_penalty = mask, p
            best = tuple(tuple(row) for row in builder.modules)
        builder.apply_mask(mask)                              # undo
    return QrCode(version, ecc, best_mask, best)


# ---------------------------------------------------------------------------
# output
# ---------------------------------------------------------------------------


def to_svg(qr: QrCode, border: int = 4, dark: str = "#000000", light: str = "#ffffff") -> str:
    """A complete SVG document (one path for all dark modules, a light quiet zone around it)."""
    n = qr.size + border * 2
    parts = []
    for y, row in enumerate(qr.modules):
        x = 0
        while x < qr.size:
            if row[x]:
                start = x
                while x < qr.size and row[x]:
                    x += 1
                parts.append(f"M{start + border},{y + border}h{x - start}v1h-{x - start}z")
            else:
                x += 1
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n} {n}" shape-rendering="crispEdges">'
        f'<rect width="{n}" height="{n}" fill="{light}"/><path d="{"".join(parts)}" fill="{dark}"/></svg>'
    )


_BLOCKS = {(False, False): "█", (False, True): "▀", (True, False): "▄", (True, True): " "}


def can_print_blocks(encoding: str | None) -> bool:
    """Can the stream print the half-block characters used by to_text()?"""
    try:
        "█▀▄".encode(encoding or "ascii")
    except (UnicodeEncodeError, LookupError):
        return False
    return True


def to_text(qr: QrCode, border: int = 2, blocks: bool = True) -> str:
    """Terminal art for a DARK terminal: the light modules are drawn bright, so the code reads like paper.

    With ``blocks`` two module rows share one text line (half-block characters); otherwise every module is two
    plain ASCII characters (for consoles that cannot print the blocks).
    """
    n = qr.size + border * 2

    def dark(x: int, y: int) -> bool:
        return qr.get(x - border, y - border)

    lines = []
    if blocks:
        for y in range(0, n, 2):
            lines.append("".join(_BLOCKS[(dark(x, y), dark(x, y + 1))] for x in range(n)))
    else:
        for y in range(n):
            lines.append("".join("  " if dark(x, y) else "##" for x in range(n)))
    return "\n".join(lines)
