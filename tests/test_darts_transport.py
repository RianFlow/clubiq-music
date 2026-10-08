import os
import ssl
import traceback
import unittest
from unittest.mock import Mock, patch

import requests

import darts_feed as feed
import darts_live as live
import darts_resilience as resilience
import darts_tournament as tournament
from darts_transport import PUBLIC_HOSTS, scoped_get, websocket_options


class ScopedTransportTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"DARTS_3K_HTTPS_PROXY": "http://egress.test:1080"}, clear=True)
        self.environment.start()

    def tearDown(self):
        self.environment.stop()

    def test_disabled_configuration_preserves_existing_transport(self):
        os.environ.pop("DARTS_3K_HTTPS_PROXY")
        request = Mock(return_value=Mock(status_code=200))
        scoped_get(request, "https://backend4.3k-darts.com/test", timeout=(3, 8))
        request.assert_called_once_with("https://backend4.3k-darts.com/test", timeout=(3, 8))

    def test_only_exact_secure_hosts_receive_proxy(self):
        for host in PUBLIC_HOSTS:
            request = Mock(return_value=Mock(status_code=200))
            scoped_get(request, f"https://{host}:443/test", timeout=(3, 8))
            options = request.call_args.kwargs
            self.assertEqual(options["proxies"], {"https": "http://egress.test:1080"})
            self.assertIs(options["verify"], True)
            self.assertIs(options["allow_redirects"], False)
            self.assertEqual(options["timeout"], (3, 8))
        for url in ("https://www.googleapis.com/test", "https://firebase.googleapis.com/test",
                    "https://backend4.3k-darts.com.evil.test/test", "http://backend4.3k-darts.com/test",
                    "https://backend4.3k-darts.com:444/test", "https://user:pass@backend4.3k-darts.com/test",
                    "https://portal.3k-darts.com/test"):
            request = Mock(return_value=Mock(status_code=200))
            scoped_get(request, url, timeout=3)
            request.assert_called_once_with(url, timeout=3)
        self.assertNotIn("HTTPS_PROXY", os.environ)

    def test_bad_proxy_configuration_and_exceptions_never_expose_credentials(self):
        for proxy in ("http://user:SECRET@egress.test:70000", "socks5://user:SECRET@egress.test:1080",
                      "http://egress.test/SECRET", "http://egress.test:1080?password=SECRET"):
            os.environ["DARTS_3K_HTTPS_PROXY"] = proxy
            request = Mock()
            with self.assertRaises(ValueError) as raised:
                scoped_get(request, "https://backend4.3k-darts.com/test")
            self.assertNotIn("SECRET", str(raised.exception))
            request.assert_not_called()
        os.environ["DARTS_3K_HTTPS_PROXY"] = "http://user:SECRET@egress.test:1080"
        request = Mock(side_effect=requests.exceptions.ProxyError("http://user:SECRET@egress.test:1080"))
        try:
            scoped_get(request, "https://backend4.3k-darts.com/test")
        except requests.exceptions.ProxyError as error:
            self.assertNotIn("SECRET", "".join(traceback.format_exception(error)))
        else:
            self.fail("Expected a sanitized proxy failure")

    def test_redirect_is_not_followed_or_forwarded_to_another_host(self):
        response = Mock(status_code=302, headers={"Location": "https://other.test/"})
        request = Mock(return_value=response)
        with self.assertRaises(requests.HTTPError):
            scoped_get(request, "https://backend4.3k-darts.com/test", allow_redirects=True)
        self.assertEqual(request.call_count, 1)
        self.assertIs(request.call_args.kwargs["allow_redirects"], False)

    def test_tls_cannot_be_disabled_but_explicit_ca_bundle_is_preserved(self):
        request = Mock(return_value=Mock(status_code=200))
        with self.assertRaises(ValueError):
            scoped_get(request, "https://backend4.3k-darts.com/test", verify=False)
        request.assert_not_called()
        scoped_get(request, "https://backend4.3k-darts.com/test", verify="/trusted/ca.pem")
        self.assertEqual(request.call_args.kwargs["verify"], "/trusted/ca.pem")

    def test_all_existing_requests_paths_use_scoped_proxy_without_network(self):
        calls = []

        def send(adapter, request, **kwargs):
            calls.append((request.url, kwargs))
            response = requests.Response()
            response.status_code = 200
            response._content = b"{}"
            response.encoding = "utf-8"
            response.request = request
            return response

        recovery = resilience.PublicSourceRecovery()
        with patch("requests.adapters.HTTPAdapter.send", send), \
             patch.object(resilience, "source_recovery", recovery), patch.object(feed, "source_recovery", recovery):
            for host in PUBLIC_HOSTS:
                url = f"https://{host}/test"
                session = resilience.PublicSession()
                session.verify = False  # The scoped transport still requires verified TLS.
                session.get(url)
                feed._public_get(url)
                tournament._get(url)
            live._GroupConnector(Mock(), "10", "42")._rest_sync()
        self.assertEqual(len(calls), 10)
        for _, options in calls:
            self.assertEqual(options["proxies"]["https"], "http://egress.test:1080")
            self.assertIs(options["verify"], True)

    def test_websocket_settings_are_scoped_verified_and_do_not_inherit_no_proxy(self):
        os.environ.update(DARTS_3K_HTTPS_PROXY="http://user:p%40ss@egress.test:1080", NO_PROXY="*")
        options = websocket_options("wss://live.3k-darts.com/test")
        self.assertEqual(options["http_proxy_host"], "egress.test")
        self.assertEqual(options["http_proxy_port"], 1080)
        self.assertEqual(options["proxy_type"], "http")
        self.assertEqual(options["http_proxy_auth"], ("user", "p@ss"))
        self.assertEqual(options["http_no_proxy"], [""])
        self.assertEqual(options["redirect_limit"], 0)
        self.assertEqual(options["sslopt"]["cert_reqs"], ssl.CERT_REQUIRED)
        self.assertIs(options["sslopt"]["check_hostname"], True)
        self.assertEqual(websocket_options("wss://other.test/test"), {})
        self.assertEqual(websocket_options("ws://live.3k-darts.com/test"), {})
        self.assertNotIn("HTTPS_PROXY", os.environ)

    def test_unsupported_websocket_proxy_fails_before_direct_connection(self):
        os.environ["DARTS_3K_HTTPS_PROXY"] = "https://egress.test:1080"
        connector = live._GroupConnector(Mock(), "10", "42")
        websocket = Mock()
        with patch.object(live, "websocket", websocket), self.assertRaises(ValueError):
            connector._connect_and_listen()
        websocket.create_connection.assert_not_called()
        # HTTPS requests still support this proxy, so the existing REST fallback remains usable.
        request = Mock(return_value=Mock(status_code=200))
        scoped_get(request, "https://live.3k-darts.com/test")
        self.assertEqual(request.call_args.kwargs["proxies"]["https"], "https://egress.test:1080")

    def test_native_websocket_getter_passes_explicit_proxy_settings(self):
        connector = live._GroupConnector(Mock(), "10", "42")
        websocket = Mock()
        websocket.create_connection.side_effect = OSError("mocked failure")
        with patch.object(live, "websocket", websocket), self.assertRaises(OSError):
            connector._connect_and_listen()
        options = websocket.create_connection.call_args.kwargs
        self.assertEqual(options["http_proxy_host"], "egress.test")
        self.assertEqual(options["http_proxy_port"], 1080)
        self.assertEqual(options["sslopt"]["cert_reqs"], ssl.CERT_REQUIRED)

    def test_websocket_proxy_failure_keeps_rest_fallback_running(self):
        class WebSocketProxyFailure(Exception):
            pass
        hub = Mock()
        hub.group_finished.return_value = False
        connector = live._GroupConnector(hub, "10", "42")
        connector._stop = Mock()
        connector._stop.is_set.side_effect = [False, True]
        connector._stop.wait.return_value = False
        connector._rest_sync = Mock(return_value=True)
        connector._connect_and_listen = Mock(side_effect=WebSocketProxyFailure("SECRET proxy password"))
        with patch.object(live, "_WEBSOCKET_ERROR", WebSocketProxyFailure):
            connector._run()
        self.assertEqual(connector._rest_sync.call_count, 2)
        hub.set_connection.assert_called_with("42", False, "WebSocketProxyFailure")
        self.assertNotIn("SECRET", str(hub.set_connection.call_args))
        hub.connector_finished.assert_called_once_with("42", connector)


if __name__ == "__main__":
    unittest.main()
