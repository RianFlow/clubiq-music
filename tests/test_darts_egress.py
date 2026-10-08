import importlib.util
import json
import os
import ssl
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError


def module(filename, name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / "scripts" / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


start = module("darts-egress-start.py", "test_egress_start")
health = start.health


class EgressTests(unittest.TestCase):
    def test_existing_profile_is_reused_without_registration(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            (state / "wgcf-profile.conf").write_text("private test fixture")
            with patch.object(start, "STATE", state), patch.object(start, "quiet_command") as run:
                start.bootstrap()
            self.assertEqual(run.call_args.args[0][0], "wireproxy")
            self.assertEqual(run.call_count, 1)
            self.assertIn("BindAddress = 0.0.0.0:40001", (state / "wireproxy.conf").read_text())

    def test_bootstrap_needs_acceptance_and_never_overwrites_bad_account(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            with patch.object(start, "STATE", state), patch.object(start, "quiet_command") as run:
                with patch.dict(os.environ, {"DARTS_WARP_ACCEPT_TOS": "0"}):
                    with self.assertRaises(RuntimeError):
                        start.bootstrap()
                (state / "wgcf-account.toml").write_text('device_id = "present"')
                with patch.dict(os.environ, {"DARTS_WARP_ACCEPT_TOS": "1"}):
                    with self.assertRaises(RuntimeError):
                        start.bootstrap()
                run.assert_not_called()

    def test_existing_registration_generates_missing_profile(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            (state / "wgcf-account.toml").write_text('device_id="d"\naccess_token="t"\nprivate_key="k"')
            with patch.object(start, "STATE", state), patch.object(start, "quiet_command") as run:
                start.bootstrap()
            commands = [call.args[0] for call in run.call_args_list]
            self.assertEqual(commands[0][3], "generate")
            self.assertFalse(any("register" in command for command in commands))

    def test_private_tool_output_is_never_forwarded(self):
        with patch.object(start.subprocess, "run") as run:
            start.quiet_command(["wgcf", "register"])
            self.assertEqual(run.call_args.kwargs["stdout"], subprocess.DEVNULL)
            self.assertEqual(run.call_args.kwargs["stderr"], subprocess.DEVNULL)

    def test_uncertain_first_registration_is_not_repeated_after_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            with patch.object(start, "STATE", state), patch.dict(os.environ, {"DARTS_WARP_ACCEPT_TOS": "1"}), \
                 patch.object(start, "quiet_command", side_effect=subprocess.TimeoutExpired("wgcf", 120)) as run:
                with self.assertRaises(subprocess.TimeoutExpired):
                    start.bootstrap()
                self.assertTrue((state / "registration.attempted").exists())
                with self.assertRaises(RuntimeError):
                    start.bootstrap()
                self.assertEqual(run.call_count, 1)

    def test_health_validates_cloudflare_and_the_actual_3k_event(self):
        with patch.object(health, "read_url", side_effect=[b"warp=on\n", b'{"event":{"id":32751,"dbId":5}}']) as get:
            self.assertEqual(health.probe(), (True, "", True))
            self.assertEqual(get.call_args_list[1].args[0], health.SOURCE)
        with patch.object(health, "read_url", side_effect=[b"warp=off\n"]):
            self.assertEqual(health.probe(), (False, "warp-not-active", True))

    def test_access_restrictions_do_not_trigger_reconnection(self):
        for code in (403, 429):
            with self.subTest(code=code), patch.object(health, "read_url", side_effect=HTTPError("url", code, "private", {}, None)):
                self.assertEqual(health.probe(), (False, "http-" + str(code), False))
        with patch.object(health, "read_url", side_effect=ssl.SSLCertVerificationError("private certificate details")):
            self.assertEqual(health.probe(), (False, "invalid-response", False))

    def test_expired_or_false_health_never_reports_ready(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            for checked, good, ready in ((100, True, True), (1, True, False), (100, False, False), (201, True, False)):
                (state / "health.json").write_text(json.dumps({"checkedAt": checked, "healthy": good}))
                self.assertEqual(health.cached_health(state, now=200), ready)

    def test_three_failed_probes_restart_the_tunnel_with_same_profile(self):
        stop = threading.Event()
        child = Mock()
        child.poll.return_value = None

        def wait(seconds, _child=None):
            if seconds == 30:
                stop.set()
                return False
            return True

        with patch.object(start, "STOP", stop), patch.object(start, "wait", side_effect=wait), \
             patch.object(start.subprocess, "Popen", return_value=child) as process, \
             patch.object(start, "stop_child") as terminate, patch.object(start, "save_health"), \
             patch.object(start.health, "probe", return_value=(False, "connection-error", True)) as probe, \
             patch.object(start, "bootstrap") as bootstrap:
            start.supervise()
        self.assertEqual(probe.call_count, 3)
        self.assertEqual(process.call_count, 1)
        terminate.assert_called_once_with(child)
        bootstrap.assert_not_called()

    def test_health_uses_connect_and_certificate_validation_even_with_no_proxy(self):
        connection = Mock()
        connection.getresponse.return_value.status = 200
        connection.getresponse.return_value.read.return_value = b"warp=on\n"
        with patch.dict(os.environ, {"NO_PROXY": "*"}), \
             patch.object(health.http.client, "HTTPSConnection", return_value=connection) as factory:
            self.assertEqual(health.read_url(health.TRACE), b"warp=on\n")
        factory.assert_called_once()
        self.assertEqual(factory.call_args.args, ("127.0.0.1", 40001))
        context = factory.call_args.kwargs["context"]
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        connection.set_tunnel.assert_called_once_with("www.cloudflare.com", 443)
        connection.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
