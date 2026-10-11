"""LAN address discovery: ranking of made-up adapters + sanity of the live call."""

from __future__ import annotations

import ipaddress
import sys

import pytest

from fh6_telemetry.core import netinfo
from fh6_telemetry.core.netinfo import Adapter, rank_adapters


def A(name, ips, **kw):
    kw.setdefault("up", True)
    return Adapter(name=name, ipv4=tuple(ips), **kw)


def test_home_wifi_beats_hyperv_wsl_and_vpn():
    adapters = [
        A("vEthernet (Default Switch)", ["172.28.16.1"], description="Hyper-V Virtual Ethernet Adapter",
          if_type=6, has_gateway=False, metric=5000),
        A("vEthernet (WSL)", ["172.20.0.1"], if_type=6, metric=5000),
        A("Tailscale", ["100.101.102.103"], if_type=131, has_gateway=False),
        A("Wi-Fi", ["192.168.1.23"], if_type=71, has_gateway=True, metric=35),
        A("Loopback Pseudo-Interface 1", ["127.0.0.1"], if_type=24),
    ]
    ranked = rank_adapters(adapters)
    assert ranked[0].ip == "192.168.1.23" and ranked[0].kind == "wifi"
    assert "127.0.0.1" not in [c.ip for c in ranked]
    assert ranked[-1].ip in ("100.101.102.103", "172.28.16.1", "172.20.0.1")


def test_ethernet_with_gateway_wins_over_wifi_without():
    ranked = rank_adapters([
        A("Wi-Fi", ["192.168.0.50"], if_type=71, has_gateway=False, metric=50),
        A("Ethernet", ["192.168.0.10"], if_type=6, has_gateway=True, metric=25),
    ])
    assert ranked[0].ip == "192.168.0.10"


def test_lowest_metric_breaks_ties():
    ranked = rank_adapters([
        A("Ethernet 2", ["10.0.0.5"], if_type=6, has_gateway=True, metric=50),
        A("Ethernet", ["10.0.0.9"], if_type=6, has_gateway=True, metric=10),
    ])
    assert [c.ip for c in ranked] == ["10.0.0.9", "10.0.0.5"]


def test_down_link_local_and_loopback_are_dropped():
    ranked = rank_adapters([
        A("Ethernet", ["192.168.1.2"], if_type=6, up=False),
        A("Wi-Fi", ["169.254.10.20"], if_type=71),
        A("Loopback", ["127.0.0.1"], if_type=24),
        A("Weird", ["0.0.0.0", "not-an-ip"], if_type=6),
    ])
    assert ranked == []


def test_duplicate_addresses_are_listed_once():
    ranked = rank_adapters([
        A("Wi-Fi", ["192.168.1.2"], if_type=71, has_gateway=True),
        A("Wi-Fi again", ["192.168.1.2"], if_type=71, has_gateway=True),
    ])
    assert [c.ip for c in ranked] == ["192.168.1.2"]


def test_multiple_addresses_on_one_adapter_are_all_candidates():
    ranked = rank_adapters([A("Ethernet", ["192.168.1.2", "10.1.1.2"], if_type=6, has_gateway=True)])
    assert {c.ip for c in ranked} == {"192.168.1.2", "10.1.1.2"}


def test_candidate_url():
    c = rank_adapters([A("Wi-Fi", ["192.168.1.9"], if_type=71, has_gateway=True)])[0]
    assert c.url(8077) == "http://192.168.1.9:8077/"


@pytest.mark.skipif(sys.platform != "win32", reason="GetAdaptersAddresses is Windows only")
def test_live_adapter_enumeration_returns_sane_data():
    adapters = netinfo.windows_adapters()
    assert adapters, "expected at least one adapter on a Windows machine"
    for a in adapters:
        for ip in a.ipv4:
            ipaddress.IPv4Address(ip)                     # every parsed address is valid


def test_lan_candidates_never_contain_loopback_or_link_local():
    for c in netinfo.lan_candidates():
        ip = ipaddress.ip_address(c.ip)
        assert not ip.is_loopback and not ip.is_link_local


def test_fallback_survives_a_broken_network_stack(monkeypatch):
    monkeypatch.setattr(netinfo, "windows_adapters", lambda: [])
    monkeypatch.setattr(netinfo.socket, "getaddrinfo", lambda *a, **k: (_ for _ in ()).throw(OSError("no dns")))
    monkeypatch.setattr(netinfo.socket, "gethostname", lambda: "x")
    cands = netinfo.lan_candidates()
    assert isinstance(cands, list)
