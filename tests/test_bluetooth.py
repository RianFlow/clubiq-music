"""Hardware-free regressions for the BlueZ command/connection lifecycle."""
import subprocess
import socketserver
import unittest
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, call, patch

# Windows has no UnixStreamServer. These tests never create a server; retain
# the real class on Linux and substitute only that unused transport on Windows.
with patch.object(socketserver, "UnixStreamServer",
                  getattr(socketserver, "UnixStreamServer", socketserver.TCPServer), create=True):
    import player_agent as agent


ADDRESS = "02:11:22:33:44:55"


def info(paired=False, connected=False):
    return {"address": ADDRESS, "name": "Testbox", "paired": paired,
            "trusted": paired, "connected": connected}


class BluetoothTests(unittest.TestCase):
    @patch.object(agent, "device_info", return_value=info())
    @patch.object(agent, "bluetoothctl")
    def test_quick_reconnect_cannot_pair_unknown_device(self, command, _info):
        with self.assertRaisesRegex(ValueError, "nicht mehr gekoppelt"):
            agent.connect_bluetooth_device(ADDRESS, allow_pair=False)
        self.assertEqual(command.call_args_list, [call("power on")])

    @patch.object(agent, "device_info", return_value=info(True, True))
    @patch.object(agent, "connect_bluetooth_device", return_value=info(True, True))
    def test_reconnect_of_running_speaker_does_not_restart_music(self, connect, _info):
        with patch.object(agent.MpvController, "load_state"):
            player = agent.MpvController()
        player.connected_speaker = ADDRESS
        player.process = MagicMock()
        player.process.poll.return_value = None
        with patch.object(player, "save_state"), patch.object(player, "restore_session") as restore, patch.object(player, "stop_mpv") as stop:
            player.connect_speaker(ADDRESS, allow_pair=False)
        connect.assert_called_once_with(ADDRESS, allow_pair=False)
        restore.assert_not_called()
        stop.assert_not_called()
        self.assertEqual(player.last_speaker, ADDRESS)

    @patch.object(agent, "device_info", return_value=info(True))
    @patch.object(agent, "bluetoothctl")
    def test_disconnecting_keeps_box_for_next_connection_but_forgetting_removes_it(self, command, _info):
        with tempfile.TemporaryDirectory() as directory, patch.object(agent, "STATE_FILE", Path(directory) / "player.json"):
            player = agent.MpvController()
            player.connected_speaker = player.last_speaker = ADDRESS
            with patch.object(player, "stop_mpv"):
                player.disconnect_speaker(ADDRESS)
            restored = agent.MpvController()
            self.assertEqual(restored.connected_speaker, "")
            self.assertEqual(restored.last_speaker, ADDRESS)
            restored.disconnect_speaker(ADDRESS, forget=True)
            self.assertEqual(agent.MpvController().last_speaker, "")
        self.assertEqual(command.call_args_list, [call(f"disconnect {ADDRESS}"), call(f"remove {ADDRESS}")])

    @patch.object(agent, "connect_bluetooth_device", return_value=info(True, True))
    def test_switching_saved_speaker_reopens_audio_on_new_target(self, connect):
        with patch.object(agent.MpvController, "load_state"):
            player = agent.MpvController()
        player.connected_speaker = "02:11:22:33:44:66"
        player.process = MagicMock()
        player.process.poll.return_value = None
        with patch.object(player, "save_state"), patch.object(player, "checkpoint_playback") as checkpoint, patch.object(player, "stop_mpv") as stop, patch.object(player, "restore_session") as restore:
            player.connect_speaker(ADDRESS, allow_pair=False)
        connect.assert_called_once_with(ADDRESS, allow_pair=False)
        checkpoint.assert_called_once()
        stop.assert_called_once()
        restore.assert_called_once()
        self.assertEqual(player.connected_speaker, ADDRESS)

    @patch.object(agent, "run")
    def test_pair_waits_in_noninteractive_mode_with_live_agent(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, "Pairing successful", "")
        self.assertEqual(agent.bluetoothctl(f"pair {ADDRESS}", timeout=25), "Pairing successful")
        run.assert_called_once_with(
            ["bluetoothctl", "--agent", "NoInputNoOutput", "pair", ADDRESS], timeout=25)

    @patch.object(agent, "run")
    def test_read_only_command_does_not_start_pairing_agent(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, "Controller Test", "")
        agent.bluetoothctl("show")
        run.assert_called_once_with(["bluetoothctl", "show"], timeout=5)

    @patch.object(agent, "run")
    def test_failure_reports_stage_and_bluez_reason_without_ansi(self, run):
        run.return_value = subprocess.CompletedProcess([], 1,
            "\x1b[0;31mFailed to pair: org.bluez.Error.AuthenticationFailed\x1b[0m", "")
        with self.assertRaisesRegex(RuntimeError, r"Koppeln.*AuthenticationFailed") as context:
            agent.bluetoothctl(f"pair {ADDRESS}")
        self.assertNotIn("\x1b", str(context.exception))
        self.assertIn("Kopplungsmodus", str(context.exception))

    @patch.object(agent, "run")
    def test_timeout_is_readable(self, run):
        run.side_effect = subprocess.TimeoutExpired("bluetoothctl", 7)
        with self.assertRaisesRegex(RuntimeError, "Verbinden.*Zeitüberschreitung"):
            agent.bluetoothctl(f"connect {ADDRESS}")

    @patch.object(agent, "run")
    def test_nonzero_exit_without_message_is_not_success(self, run):
        run.return_value = subprocess.CompletedProcess([], 1, "", "")
        with self.assertRaisesRegex(RuntimeError, "Keine Bestätigung"):
            agent.bluetoothctl("power on")

    @patch.object(agent, "device_info", side_effect=[info(), info(True), info(True, True)])
    @patch.object(agent, "bluetoothctl")
    def test_connect_steps_are_sequential_and_state_is_verified(self, command, device_info):
        result = agent.connect_bluetooth_device(ADDRESS)
        self.assertTrue(result["connected"])
        self.assertEqual(command.call_args_list, [call("power on"), call(f"pair {ADDRESS}", timeout=25),
            call(f"trust {ADDRESS}"), call(f"connect {ADDRESS}", timeout=15)])
        self.assertEqual(device_info.call_count, 3)

    @patch.object(agent, "device_info", side_effect=[info(True), info(True), info(True, True)])
    @patch.object(agent, "bluetoothctl")
    def test_existing_bond_is_never_repaired(self, command, device_info):
        agent.connect_bluetooth_device(ADDRESS)
        self.assertEqual(command.call_args_list, [call("power on"), call(f"trust {ADDRESS}"),
                                                call(f"connect {ADDRESS}", timeout=15)])

    @patch.object(agent, "device_info", return_value=info(True, True))
    @patch.object(agent, "bluetoothctl")
    def test_already_connected_speaker_is_not_disrupted(self, command, device_info):
        agent.connect_bluetooth_device(ADDRESS)
        self.assertEqual(command.call_args_list, [call("power on"), call(f"trust {ADDRESS}")])

    @patch.object(agent, "device_info", return_value=info())
    @patch.object(agent, "bluetoothctl", side_effect=["", RuntimeError("pair failed")])
    def test_pair_failure_stops_trust_and_connect(self, command, device_info):
        with self.assertRaisesRegex(RuntimeError, "pair failed"):
            agent.connect_bluetooth_device(ADDRESS)
        self.assertEqual(command.call_count, 2)

    @patch.object(agent, "device_info", return_value=info(True))
    @patch.object(agent, "bluetoothctl")
    def test_disconnected_final_state_is_not_reported_as_success(self, command, device_info):
        with self.assertRaisesRegex(RuntimeError, "keine Verbindung"):
            agent.connect_bluetooth_device(ADDRESS)


if __name__ == "__main__":
    unittest.main()
