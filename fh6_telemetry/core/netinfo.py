"""
LAN address discovery — which URL should the phone open?

``socket.gethostbyname(hostname)`` and the "connect a UDP socket to 8.8.8.8"
trick both go wrong on a PC with Hyper-V / WSL / VirtualBox / VPN adapters
(they return the virtual or VPN address, which a phone can't reach).  On
Windows we therefore ask ``GetAdaptersAddresses`` for every adapter, drop the
ones that cannot be the home LAN, and rank the rest; elsewhere (or on failure)
we fall back to ``getaddrinfo`` and finally the UDP trick.

``rank_adapters`` is pure so it can be unit tested with made-up adapters.
"""

from __future__ import annotations

import ctypes
import ipaddress
import re
import socket
import sys
from ctypes import wintypes
from dataclasses import dataclass, field

IF_TYPE_ETHERNET = 6
IF_TYPE_LOOPBACK = 24
IF_TYPE_WIFI = 71
IF_TYPE_TUNNEL = 131
IF_OPER_UP = 1

_VIRTUAL_RE = re.compile(
    r"vethernet|hyper-v|virtualbox|vmware|vmnet|wsl|docker|loopback|bluetooth|"
    r"pseudo|isatap|teredo|miniport|host-only",
    re.I,
)
_VPN_RE = re.compile(
    r"vpn|tap-windows|wintun|wireguard|nordlynx|openvpn|tailscale|zerotier|"
    r"hamachi|cisco anyconnect|fortinet|globalprotect|proton",
    re.I,
)


@dataclass(frozen=True)
class Adapter:
    name: str
    description: str = ""
    if_type: int = 0
    up: bool = True
    ipv4: tuple[str, ...] = ()
    has_gateway: bool = False
    metric: int = 0


@dataclass(frozen=True)
class Candidate:
    ip: str
    name: str
    kind: str           # "ethernet" | "wifi" | "other" | "vpn" | "virtual"
    score: int = 0
    reasons: tuple[str, ...] = field(default=())

    def url(self, port: int) -> str:
        return f"http://{self.ip}:{port}/"


# ---------------------------------------------------------------------------
# Pure ranking
# ---------------------------------------------------------------------------


def _classify(a: Adapter) -> str:
    text = f"{a.name} {a.description}"
    if _VIRTUAL_RE.search(text):
        return "virtual"
    if _VPN_RE.search(text) or a.if_type == IF_TYPE_TUNNEL:
        return "vpn"
    if a.if_type == IF_TYPE_WIFI or re.search(r"wi-?fi|wireless|wlan", text, re.I):
        return "wifi"
    if a.if_type == IF_TYPE_ETHERNET or "ethernet" in text.lower():
        return "ethernet"
    return "other"


def rank_adapters(adapters: list[Adapter]) -> list[Candidate]:
    """Usable LAN addresses, best first.  Never returns loopback / link-local."""
    out: list[tuple[int, int, Candidate]] = []
    for a in adapters:
        if not a.up or a.if_type == IF_TYPE_LOOPBACK:
            continue
        kind = _classify(a)
        for ip in a.ipv4:
            try:
                addr = ipaddress.ip_address(ip)
            except ValueError:
                continue
            if addr.version != 4 or addr.is_loopback or addr.is_link_local or addr.is_unspecified:
                continue
            score, reasons = 0, []
            if a.has_gateway:
                score += 40
                reasons.append("has default gateway")
            if kind in ("ethernet", "wifi"):
                score += 30
                reasons.append(kind)
            elif kind == "other":
                score += 10
            if addr.is_private and not _in_cgnat(addr):
                score += 20
                reasons.append("private LAN range")
            if kind == "virtual":
                score -= 60
                reasons.append("virtual adapter")
            if kind == "vpn" or _in_cgnat(addr):
                score -= 40
                reasons.append("VPN / CGNAT")
            out.append((-score, a.metric, Candidate(ip, a.name, kind, score, tuple(reasons))))
    out.sort(key=lambda t: (t[0], t[1], t[2].ip))
    seen: set[str] = set()
    ranked: list[Candidate] = []
    for _, _, c in out:
        if c.ip not in seen:
            seen.add(c.ip)
            ranked.append(c)
    return ranked


def _in_cgnat(addr) -> bool:
    return addr in ipaddress.ip_network("100.64.0.0/10")


# ---------------------------------------------------------------------------
# Windows: GetAdaptersAddresses
# ---------------------------------------------------------------------------

AF_INET = 2
GAA_FLAG_SKIP_ANYCAST = 0x0002
GAA_FLAG_SKIP_MULTICAST = 0x0004
GAA_FLAG_SKIP_DNS_SERVER = 0x0008
GAA_FLAG_INCLUDE_GATEWAYS = 0x0080
ERROR_BUFFER_OVERFLOW = 111


class _SOCKADDR_IN(ctypes.Structure):
    _fields_ = [
        ("sin_family", ctypes.c_ushort),
        ("sin_port", ctypes.c_ushort),
        ("sin_addr", ctypes.c_ubyte * 4),
    ]


class _SOCKET_ADDRESS(ctypes.Structure):
    _fields_ = [("lpSockaddr", ctypes.c_void_p), ("iSockaddrLength", ctypes.c_int)]


class _UNICAST(ctypes.Structure):
    pass


_UNICAST._fields_ = [
    ("Length", wintypes.ULONG),
    ("Flags", wintypes.DWORD),
    ("Next", ctypes.POINTER(_UNICAST)),
    ("Address", _SOCKET_ADDRESS),
]


class _GATEWAY(ctypes.Structure):
    pass


_GATEWAY._fields_ = [
    ("Length", wintypes.ULONG),
    ("Reserved", wintypes.DWORD),
    ("Next", ctypes.POINTER(_GATEWAY)),
    ("Address", _SOCKET_ADDRESS),
]


class _ADAPTER(ctypes.Structure):
    pass


_ADAPTER._fields_ = [
    ("Length", wintypes.ULONG),
    ("IfIndex", wintypes.DWORD),
    ("Next", ctypes.POINTER(_ADAPTER)),
    ("AdapterName", ctypes.c_char_p),
    ("FirstUnicastAddress", ctypes.POINTER(_UNICAST)),
    ("FirstAnycastAddress", ctypes.c_void_p),
    ("FirstMulticastAddress", ctypes.c_void_p),
    ("FirstDnsServerAddress", ctypes.c_void_p),
    ("DnsSuffix", ctypes.c_wchar_p),
    ("Description", ctypes.c_wchar_p),
    ("FriendlyName", ctypes.c_wchar_p),
    ("PhysicalAddress", ctypes.c_ubyte * 8),
    ("PhysicalAddressLength", wintypes.ULONG),
    ("Flags", wintypes.ULONG),
    ("Mtu", wintypes.ULONG),
    ("IfType", wintypes.DWORD),
    ("OperStatus", ctypes.c_int),
    ("Ipv6IfIndex", wintypes.DWORD),
    ("ZoneIndices", wintypes.DWORD * 16),
    ("FirstPrefix", ctypes.c_void_p),
    ("TransmitLinkSpeed", ctypes.c_ulonglong),
    ("ReceiveLinkSpeed", ctypes.c_ulonglong),
    ("FirstWinsServerAddress", ctypes.c_void_p),
    ("FirstGatewayAddress", ctypes.POINTER(_GATEWAY)),
    ("Ipv4Metric", wintypes.ULONG),
    ("Ipv6Metric", wintypes.ULONG),
]


def _sockaddr_to_ipv4(addr: _SOCKET_ADDRESS) -> str | None:
    if not addr.lpSockaddr or addr.iSockaddrLength < ctypes.sizeof(_SOCKADDR_IN):
        return None
    sin = ctypes.cast(addr.lpSockaddr, ctypes.POINTER(_SOCKADDR_IN)).contents
    if sin.sin_family != AF_INET:
        return None
    return ".".join(str(b) for b in sin.sin_addr)


def windows_adapters() -> list[Adapter]:
    """All IPv4 adapters via ``GetAdaptersAddresses`` (empty list on any failure)."""
    if sys.platform != "win32":
        return []
    try:
        iphlpapi = ctypes.WinDLL("iphlpapi", use_last_error=True)
        fn = iphlpapi.GetAdaptersAddresses
        fn.restype = wintypes.ULONG
        fn.argtypes = [wintypes.ULONG, wintypes.ULONG, ctypes.c_void_p,
                       ctypes.c_void_p, ctypes.POINTER(wintypes.ULONG)]
        flags = (GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST
                 | GAA_FLAG_SKIP_DNS_SERVER | GAA_FLAG_INCLUDE_GATEWAYS)
        size = wintypes.ULONG(16 * 1024)
        for _ in range(4):
            buf = ctypes.create_string_buffer(size.value)
            rc = fn(AF_INET, flags, None, ctypes.cast(buf, ctypes.c_void_p), ctypes.byref(size))
            if rc != ERROR_BUFFER_OVERFLOW:
                break
        if rc != 0:
            return []
        adapters: list[Adapter] = []
        node = ctypes.cast(buf, ctypes.POINTER(_ADAPTER))
        while node:
            a = node.contents
            ips: list[str] = []
            u = a.FirstUnicastAddress
            while u:
                ip = _sockaddr_to_ipv4(u.contents.Address)
                if ip:
                    ips.append(ip)
                u = u.contents.Next
            has_gw = False
            g = a.FirstGatewayAddress
            while g:
                if _sockaddr_to_ipv4(g.contents.Address):
                    has_gw = True
                g = g.contents.Next
            adapters.append(Adapter(
                name=a.FriendlyName or "", description=a.Description or "",
                if_type=int(a.IfType), up=a.OperStatus == IF_OPER_UP,
                ipv4=tuple(ips), has_gateway=has_gw, metric=int(a.Ipv4Metric),
            ))
            node = a.Next
        return adapters
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def _fallback_addresses() -> list[Candidate]:
    found: list[str] = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.append(info[4][0])
    except OSError:
        pass
    try:                               # no packet is sent; it just selects a route
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("192.0.2.1", 9))
            found.append(s.getsockname()[0])
        finally:
            s.close()
    except OSError:
        pass
    adapters = [Adapter(name="host", ipv4=tuple(dict.fromkeys(found)))]
    return rank_adapters(adapters)


def lan_candidates() -> list[Candidate]:
    """Addresses a phone on the same Wi-Fi/LAN could use, best first."""
    ranked = rank_adapters(windows_adapters())
    return ranked or _fallback_addresses()


def best_url(port: int) -> str | None:
    cands = lan_candidates()
    return cands[0].url(port) if cands else None
