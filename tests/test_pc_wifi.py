"""Metric semantics and loopback API boundaries, without real WLAN probes."""
import json
from functools import partial
from http.client import HTTPConnection
from pathlib import Path
import sys
from threading import Thread
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "viewer"))
from pc_wifi import summarize, WifiMonitor
from serve import Handler, LocalServer


def sample(t, status, rtt=None, quality=None):
    return dict(t=t, probeStatus=status, rtt=rtt, quality=quality)


class MetricsTests(unittest.TestCase):
    def test_no_probe_is_unknown_instead_of_zero_loss(self):
        result = summarize([sample(0, "unavailable", quality=80)])
        self.assertEqual(result["attempts"], 0)
        self.assertIsNone(result["loss"])
        self.assertIsNone(result["rtt"])

    def test_failures_include_timeout_and_unreachable_but_not_unavailable(self):
        rows = [sample(0, "ok", 0), sample(1000, "timeout"),
                sample(2000, "error"), sample(3000, "unavailable")]
        result = summarize(rows)
        self.assertEqual(result["attempts"], 3)
        self.assertEqual(result["failures"], 2)
        self.assertAlmostEqual(result["loss"], 200 / 3)
        self.assertEqual(result["rtt"], 0)

    def test_jitter_only_uses_adjacent_successes(self):
        rows = [sample(0, "ok", 2), sample(1000, "ok", 5), sample(2000, "timeout"),
                sample(3000, "ok", 100), sample(4000, "ok", 105)]
        self.assertEqual(summarize(rows)["jitter"], 4)

    def test_sampling_gap_breaks_jitter_adjacency(self):
        self.assertIsNone(summarize([sample(0, "ok", 1), sample(4000, "ok", 100)])["jitter"])

    def test_quality_range_excludes_missing_samples(self):
        rows = [sample(0, "ok", 1, 0), sample(1000, "unavailable"), sample(2000, "ok", 3, 90)]
        result = summarize(rows)
        self.assertEqual((result["qualityMin"], result["qualityMax"]), (0, 90))
        self.assertEqual(result["duration"], 2)


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1] / "viewer"
        cls.server = LocalServer(("127.0.0.1", 0), partial(Handler, directory=str(root)))
        cls.server.wifi = SimpleNamespace(snapshot=lambda: {"source": "windows-wlan", "samples": []})
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, headers=None):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.request("GET", "/api/pc-wifi", headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_loopback_api_returns_uncached_json(self):
        status, headers, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(json.loads(body)["source"], "windows-wlan")

    def test_remote_origin_cannot_read_wifi(self):
        self.assertEqual(self.request({"Origin": "https://example.com"})[0], 403)

    def test_cross_site_fetch_cannot_start_sampling(self):
        self.assertEqual(self.request({"Sec-Fetch-Site": "cross-site"})[0], 403)

    def test_unexpected_host_rejected(self):
        self.assertEqual(self.request({"Host": "example.com"})[0], 403)

    def test_second_server_cannot_share_the_same_port(self):
        with self.assertRaises(OSError):
            LocalServer(("127.0.0.1", self.server.server_port), Handler)


class MonitorTests(unittest.TestCase):
    def run_monitor(self, readings, routes=None, idle=False):
        monitor = WifiMonitor()
        monitor.last_request = 0 if idle else 10

        class Stop:
            steps = 0
            def is_set(self):
                return self.steps >= len(readings)
            def wait(self, seconds):
                self.steps += 1

        monitor.stop_event = Stop()
        with patch("pc_wifi.os.name", "nt"), patch("pc_wifi.time.monotonic", return_value=10), \
                patch("pc_wifi.WindowsWifi") as wifi, patch("pc_wifi.ipv4_route", side_effect=routes) as route, \
                patch("pc_wifi.ping_gateway", return_value={"probeStatus": "ok", "rtt": 2, "probeCode": 0}) as ping:
            wifi.return_value.read.side_effect = readings
            monitor.run()
            return monitor, wifi, route, ping

    def test_disconnect_does_not_count_as_successful_probe(self):
        monitor, _, _, ping = self.run_monitor([dict(status="disconnected", connected=False)])
        ping.assert_not_called()
        self.assertIsNone(summarize(monitor.samples)["loss"])

    def test_wifi_gateway_change_restarts_window(self):
        reading = dict(status="connected", connected=True, guid="wifi", ssid="test", quality=90, message="ok")
        a = dict(source="192.0.2.2", gateway="192.0.2.1")
        b = dict(source="192.0.2.2", gateway="192.0.2.254")
        monitor, _, route, ping = self.run_monitor([reading.copy() for _ in range(3)], [a, a, b])
        self.assertEqual(route.call_count, 3)
        self.assertEqual(len(monitor.samples), 1)
        self.assertEqual(ping.call_args.args, (b["source"], b["gateway"]))

    def test_idle_view_does_not_read_adapter_or_probe(self):
        monitor, wifi, route, ping = self.run_monitor([{}], idle=True)
        wifi.assert_not_called()
        route.assert_not_called()
        ping.assert_not_called()
        self.assertEqual(monitor.samples, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
