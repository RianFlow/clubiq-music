#!/usr/bin/env python3
"""Small, local-only Bluetooth and mpv bridge for ClubIQ Music.

The web container talks to this process through a Unix socket.  No TCP port is
opened and every request additionally needs the shared player token.
"""

from __future__ import annotations

import json
import os
import random
import re
import signal
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from socketserver import UnixStreamServer


SOCKET_PATH = Path(os.getenv("PLAYER_AGENT_SOCKET", "/run/clubiq-music/player.sock"))
TOKEN_FILE = Path(os.getenv("PLAYER_AGENT_TOKEN_FILE", "/etc/clubiq-music/player-token"))
MPV_SOCKET = Path(os.getenv("PLAYER_MPV_SOCKET", "/run/clubiq-music/mpv.sock"))
MPV_LOG_FILE = Path(os.getenv("PLAYER_MPV_LOG", "/var/lib/clubiq-music/mpv.log"))
STATE_FILE = Path(os.getenv("PLAYER_STATE_FILE", "/var/lib/clubiq-music/player.json"))
MAC_RE = re.compile(r"^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$")
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
BLUETOOTH_LOCK = threading.RLock()


def run(command: list[str], timeout: int = 15, check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=check,
                          env={**os.environ, "LC_ALL": "C"})


def bluetoothctl(command: str, timeout: int = 5) -> str:
    """Wait for BlueZ's command callback instead of piping commands plus quit.

    Non-interactive bluetoothctl exits when the requested operation finishes.
    The pairing agent stays alive for that entire operation, including devices
    using Just Works (speakers with no keyboard/display).
    """
    arguments = command.split()
    # BlueZ --timeout suppresses callback exit codes and keeps the process alive
    # until its timer fires. Bound the process in Python instead, so a failed
    # pair/trust/connect remains a failure and success can return immediately.
    invocation = ["bluetoothctl"]
    if arguments[0] == "pair":
        invocation += ["--agent", "NoInputNoOutput"]
    invocation += arguments
    stage = {"power": "Einschalten", "pair": "Koppeln", "trust": "Vertrauen",
             "connect": "Verbinden", "disconnect": "Trennen", "remove": "Vergessen"}.get(arguments[0], "Status")
    try:
        result = run(invocation, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Bluetooth ({stage}): Zeitüberschreitung. Box im Kopplungsmodus lassen und erneut versuchen.") from None
    output = ANSI_RE.sub("", "\n".join((result.stdout or "", result.stderr or ""))).strip()
    if result.returncode:
        errors = [line.strip() for line in output.splitlines()
                  if re.search(r"failed|error|not available|not found|invalid|timeout", line, re.I)]
        detail = "\n".join(errors[-3:]) or "Keine Bestätigung innerhalb der Wartezeit."
        hint = ""
        if "Authentication" in detail:
            hint = " Box in den Kopplungsmodus setzen und eine bestehende Handy-Verbindung trennen."
        elif "NotReady" in detail or "rfkill" in detail.lower():
            hint = " Bluetooth am Raspberry ist ausgeschaltet oder gesperrt."
        elif "br-connection-profile-unavailable" in detail:
            hint = " Das Bluetooth-Audioprofil fehlt; den bluealsa-Dienst am Raspberry prüfen."
        raise RuntimeError(f"Bluetooth ({stage}): {detail[:600]}{hint}")
    return output


def connect_bluetooth_device(address: str) -> dict:
    with BLUETOOTH_LOCK:
        bluetoothctl("power on")
        info = device_info(address)
        # Never re-pair a known device: this can invalidate its existing bond.
        if not info["paired"]:
            bluetoothctl(f"pair {address}", timeout=25)
        bluetoothctl(f"trust {address}")
        info = device_info(address)
        if not info["connected"]:
            bluetoothctl(f"connect {address}", timeout=15)
            info = device_info(address)
        if not info["connected"]:
            raise RuntimeError("Bluetooth (Verbinden): Die Box meldet noch keine Verbindung. Bitte erneut versuchen.")
        return info


def scan_bluetooth_devices() -> list[dict]:
    """Run BlueZ discovery with a bounded timeout and return all visible devices."""
    bluetoothctl("power on", timeout=5)
    scan = run(["bluetoothctl", "--timeout", "8", "scan", "on"], timeout=12)
    output = "\n".join((scan.stdout, scan.stderr, bluetoothctl("devices", timeout=5)))
    return parse_devices(output)


def parse_devices(output: str) -> list[dict]:
    devices: dict[str, dict] = {}
    for line in output.splitlines():
        match = re.search(r"Device ([0-9A-F:]{17}) (.+)$", line.strip(), re.I)
        if match:
            address = match.group(1).upper()
            devices[address] = {"address": address, "name": match.group(2).strip()}
    return list(devices.values())


def device_info(address: str) -> dict:
    output = bluetoothctl(f"info {address}")
    name_match = re.search(r"\n\s*Name:\s*(.+)", output)
    return {
        "address": address,
        "name": name_match.group(1).strip() if name_match else address,
        "paired": "Paired: yes" in output,
        "trusted": "Trusted: yes" in output,
        "connected": "Connected: yes" in output,
    }


class MpvController:
    def __init__(self) -> None:
        self.process: subprocess.Popen | None = None
        self.lock = threading.RLock()
        self.queue: list[dict] = []
        self.current_index = -1
        self.repeat = "off"
        self.shuffle = False
        self.volume = 70
        self.muted = False
        self.last_error = ""
        self.connected_speaker = ""
        self.sound_active = False
        self.track_was_active = False
        self.resume_position = 0.0
        self.resume_paused = True
        self.restored_at = ""
        self.last_checkpoint = 0.0
        self.source_mode = "playlist"
        self.radio_station: dict | None = None
        self.radio_retry_count = 0
        self.radio_last_load_at = 0.0
        self.load_state()

    def load_state(self) -> None:
        try:
            saved = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            self.queue = saved.get("queue", [])
            self.current_index = int(saved.get("current_index", -1))
            self.repeat = saved.get("repeat", "off")
            self.shuffle = bool(saved.get("shuffle", False))
            self.volume = max(0, min(100, int(saved.get("volume", 70))))
            self.muted = bool(saved.get("muted", False))
            self.connected_speaker = saved.get("connected_speaker", "")
            self.resume_position = max(0.0, float(saved.get("resume_position", 0) or 0))
            self.resume_paused = bool(saved.get("resume_paused", True))
            self.source_mode = saved.get("source_mode", "playlist")
            self.radio_station = saved.get("radio_station")
        except (OSError, ValueError, TypeError):
            pass

    def save_state(self) -> None:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp = STATE_FILE.with_suffix(".tmp")
        temp.write_text(json.dumps({
            "queue": self.queue,
            "current_index": self.current_index,
            "repeat": self.repeat,
            "shuffle": self.shuffle,
            "volume": self.volume,
            "muted": self.muted,
            "connected_speaker": self.connected_speaker,
            "resume_position": round(self.resume_position, 1),
            "resume_paused": self.resume_paused,
            "source_mode": self.source_mode,
            "radio_station": self.radio_station,
        }, ensure_ascii=False), encoding="utf-8")
        temp.replace(STATE_FILE)

    def checkpoint_playback(self) -> None:
        """Persist enough state to resume after a reboot or Bluetooth outage."""
        if self.sound_active:
            return
        if self.source_mode == "radio":
            self.save_state()
            return
        running = bool(self.process and self.process.poll() is None and MPV_SOCKET.exists())
        if running and not bool(self.property("idle-active", True)):
            self.resume_position = max(0.0, float(self.property("time-pos", 0) or 0))
            self.resume_paused = bool(self.property("pause", True))
        self.save_state()

    def restore_session(self) -> None:
        """Reconnect mpv to the saved track without losing queue or position."""
        if self.source_mode == "radio" and self.radio_station:
            self.play_radio(self.radio_station)
            return
        if not (0 <= self.current_index < len(self.queue)):
            return
        self.ensure_mpv()
        item = self.queue[self.current_index]
        self.command("loadfile", item["url"], "replace", start=False)
        self.command("set_property", "pause", True, start=False)
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if not bool(self.property("idle-active", True)):
                break
            time.sleep(.2)
        if self.resume_position > 1:
            self.command("set_property", "time-pos", self.resume_position, start=False)
        self.command("set_property", "mute", self.muted, start=False)
        self.command("set_property", "pause", self.resume_paused, start=False)
        self.track_was_active = not self.resume_paused
        self.restored_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.last_error = ""
        self.save_state()

    def ensure_mpv(self) -> None:
        if self.process and self.process.poll() is None and MPV_SOCKET.exists():
            return
        if not self.connected_speaker or not device_info(self.connected_speaker)["connected"]:
            raise RuntimeError("Bitte zuerst eine Bluetooth-Box verbinden.")
        MPV_SOCKET.unlink(missing_ok=True)
        MPV_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        if MPV_LOG_FILE.exists() and MPV_LOG_FILE.stat().st_size > 1_000_000:
            MPV_LOG_FILE.unlink()
        audio_device = f"alsa/bluealsa:DEV={self.connected_speaker},PROFILE=a2dp,SOFTVOL=yes"
        command = [
            "mpv", "--no-config", "--idle=yes", "--force-window=no", "--audio-display=no",
            f"--input-ipc-server={MPV_SOCKET}", "--ytdl=yes", "--ytdl-format=bestaudio/best",
            f"--log-file={MPV_LOG_FILE}",
            f"--audio-device={audio_device}", "--audio-fallback-to-null=no", f"--volume={self.volume}",
            f"--mute={'yes' if self.muted else 'no'}", "--network-timeout=10",
        ]
        self.process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)
        for _ in range(30):
            if MPV_SOCKET.exists():
                return
            if self.process.poll() is not None:
                try:
                    self.last_error = MPV_LOG_FILE.read_text(encoding="utf-8", errors="replace")[-500:]
                except OSError:
                    self.last_error = "mpv wurde unerwartet beendet."
                raise RuntimeError(self.last_error or "Player konnte nicht gestartet werden.")
            time.sleep(.1)
        raise RuntimeError("Player antwortet nicht.")

    def command(self, *args, start: bool = True):
        if start:
            self.ensure_mpv()
        elif not (self.process and self.process.poll() is None and MPV_SOCKET.exists()):
            raise RuntimeError("Player ist noch nicht gestartet.")
        payload = json.dumps({"command": list(args)}).encode() + b"\n"
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(3)
            client.connect(str(MPV_SOCKET))
            client.sendall(payload)
            response = b""
            while not response.endswith(b"\n"):
                chunk = client.recv(65536)
                if not chunk:
                    break
                response += chunk
        result = json.loads(response or b"{}")
        if result.get("error") not in (None, "success"):
            raise RuntimeError(result["error"])
        return result.get("data")

    def property(self, name: str, default=None):
        try:
            result = self.command("get_property", name, start=False)
            return default if result is None else result
        except (OSError, ValueError, RuntimeError):
            return default

    def load_current(self, play: bool = True) -> None:
        if not self.queue:
            self.current_index = -1
            self.command("stop")
            self.save_state()
            return
        self.current_index %= len(self.queue)
        self.source_mode = "playlist"
        self.radio_station = None
        item = self.queue[self.current_index]
        self.resume_position = 0.0
        self.resume_paused = not play
        self.command("loadfile", item["url"], "replace")
        self.track_was_active = False
        if not play:
            self.command("set_property", "pause", True)
        self.save_state()

    def set_queue(self, items: list[dict]) -> None:
        with self.lock:
            self.source_mode = "playlist"
            self.radio_station = None
            self.queue = items[:250]
            self.current_index = 0 if self.queue else -1
            self.save_state()
            try:
                connected = bool(self.connected_speaker and device_info(self.connected_speaker)["connected"])
            except RuntimeError:
                connected = False
            if connected:
                self.load_current(play=False)

    def add_queue_item(self, item: dict, position: str) -> None:
        with self.lock:
            if len(self.queue) >= 250:
                raise ValueError("Die Warteschlange ist voll.")
            queue_was_empty = not self.queue
            insert_at = len(self.queue)
            if position == "next":
                insert_at = self.current_index + 1 if self.current_index >= 0 else 0
            self.queue.insert(insert_at, item)
            if self.current_index < 0:
                self.current_index = 0
            elif insert_at <= self.current_index:
                self.current_index += 1
            self.save_state()
            if queue_was_empty:
                try:
                    connected = bool(
                        self.connected_speaker
                        and device_info(self.connected_speaker)["connected"]
                    )
                except RuntimeError:
                    connected = False
                if connected:
                    self.load_current(play=False)

    def move_queue_item(self, source_index: int, target_index: int) -> None:
        with self.lock:
            if not 0 <= source_index < len(self.queue):
                raise ValueError("Song nicht mehr in der Warteschlange.")
            target_index = max(0, min(target_index, len(self.queue) - 1))
            current_item = self.queue[self.current_index] if 0 <= self.current_index < len(self.queue) else None
            item = self.queue.pop(source_index)
            self.queue.insert(target_index, item)
            if current_item is not None:
                self.current_index = next(
                    (index for index, queued in enumerate(self.queue) if queued is current_item),
                    self.current_index,
                )
            self.save_state()

    def remove_queue_item(self, index: int) -> None:
        with self.lock:
            if not 0 <= index < len(self.queue):
                raise ValueError("Song nicht mehr in der Warteschlange.")
            removing_current = index == self.current_index
            was_playing = bool(self.process and self.process.poll() is None) and not bool(
                self.property("pause", True)
            )
            self.queue.pop(index)
            if not self.queue:
                self.current_index = -1
                if self.process and self.process.poll() is None:
                    self.command("stop")
            elif index < self.current_index:
                self.current_index -= 1
            elif removing_current:
                self.current_index = min(index, len(self.queue) - 1)
                if self.connected_speaker and device_info(self.connected_speaker)["connected"]:
                    self.load_current(play=was_playing)
            self.save_state()

    def play_queue_item(self, index: int) -> None:
        with self.lock:
            if not 0 <= index < len(self.queue):
                raise ValueError("Song nicht mehr in der Warteschlange.")
            self.current_index = index
            self.load_current(play=True)

    def stop_mpv(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
        self.process = None
        MPV_SOCKET.unlink(missing_ok=True)

    def advance_after_end(self) -> None:
        if self.source_mode == "radio":
            return
        if not self.queue or self.sound_active:
            return
        if self.repeat == "one":
            self.load_current()
            return
        if self.shuffle and len(self.queue) > 1:
            choices = [index for index in range(len(self.queue)) if index != self.current_index]
            self.current_index = random.choice(choices)
            self.load_current()
            return
        if self.current_index + 1 < len(self.queue):
            self.current_index += 1
            self.load_current()
        elif self.repeat == "all":
            self.current_index = 0
            self.load_current()

    def play_sound(self, url: str) -> None:
        if not url.startswith("http://127.0.0.1:"):
            raise ValueError("Nicht erlaubte Soundboard-Adresse.")
        if self.sound_active:
            raise RuntimeError("Es läuft bereits ein Soundboard-Sound.")
        self.ensure_mpv()
        self.sound_active = True
        saved_index = self.current_index
        saved_position = float(self.property("time-pos", 0) or 0)
        saved_paused = bool(self.property("pause", True))
        saved_mode = self.source_mode
        saved_station = dict(self.radio_station) if self.radio_station else None

        def worker() -> None:
            try:
                self.command("loadfile", url, "replace", start=False)
                active_seen = False
                deadline = time.monotonic() + 35
                while time.monotonic() < deadline:
                    idle = bool(self.property("idle-active", True))
                    if not idle:
                        active_seen = True
                    elif active_seen:
                        break
                    time.sleep(.15)
                if saved_mode == "radio" and saved_station:
                    self.play_radio(saved_station)
                    if saved_paused:
                        self.command("set_property", "pause", True)
                elif 0 <= saved_index < len(self.queue):
                    self.current_index = saved_index
                    self.load_current(play=not saved_paused)
                    if saved_position:
                        self.command("set_property", "time-pos", saved_position)
            except Exception as exc:
                self.last_error = f"Soundboard: {exc}"
            finally:
                self.sound_active = False

        threading.Thread(target=worker, daemon=True).start()

    def play_radio(self, station: dict) -> None:
        stream_url = str(station.get("stream_url", ""))
        if not stream_url.startswith(("http://", "https://")):
            raise ValueError("Nicht erlaubte Radio-Adresse.")
        if self.source_mode == "playlist":
            self.checkpoint_playback()
        self.ensure_mpv()
        self.source_mode = "radio"
        self.radio_station = {
            "id": int(station["id"]),
            "name": str(station["name"])[:120],
            "stream_url": stream_url,
            "fallback_url": str(station.get("fallback_url") or "")[:1000],
            "logo_url": str(station.get("logo_url") or "")[:1000],
            "genre": str(station.get("genre") or "")[:80],
        }
        self.command("loadfile", stream_url, "replace", start=False)
        self.command("set_property", "pause", False, start=False)
        self.resume_paused = False
        self.track_was_active = False
        self.radio_retry_count = 0
        self.radio_last_load_at = time.monotonic()
        self.last_error = ""
        self.save_state()

    def retry_radio(self) -> None:
        if self.source_mode != "radio" or not self.radio_station:
            return
        fallback_url = str(self.radio_station.get("fallback_url") or "")
        use_fallback = self.radio_retry_count >= 2 and fallback_url.startswith(("http://", "https://"))
        stream_url = fallback_url if use_fallback else str(self.radio_station["stream_url"])
        self.radio_retry_count += 1
        self.radio_last_load_at = time.monotonic()
        self.command("loadfile", stream_url, "replace", start=False)
        self.command("set_property", "pause", False, start=False)
        source = "Ersatz-Stream" if use_fallback else "Haupt-Stream"
        self.last_error = f"Internetradio: {source} wird erneut verbunden."

    def stop_radio(self) -> None:
        if self.source_mode != "radio":
            return
        self.command("stop")
        self.source_mode = "playlist"
        self.radio_station = None
        self.radio_retry_count = 0
        self.radio_last_load_at = 0.0
        self.resume_paused = True
        self.save_state()
        if 0 <= self.current_index < len(self.queue):
            self.restore_session()

    def act(self, action: str, value=None) -> dict:
        with self.lock:
            if action == "play":
                if self.source_mode == "radio" and self.radio_station:
                    if bool(self.property("idle-active", True)):
                        self.play_radio(self.radio_station)
                    else:
                        self.command("set_property", "pause", False)
                elif self.current_index < 0 and self.queue:
                    self.current_index = 0
                    self.load_current()
                elif self.current_index >= 0 and bool(self.property("idle-active", True)):
                    self.load_current()
                else:
                    self.command("set_property", "pause", False)
                self.resume_paused = False
                self.save_state()
            elif action == "pause":
                self.command("set_property", "pause", True)
                self.checkpoint_playback()
            elif action in {"next", "previous"}:
                if self.source_mode != "radio" and self.queue:
                    step = 1 if action == "next" else -1
                    self.current_index = (self.current_index + step) % len(self.queue)
                    self.load_current()
            elif action == "seek":
                if self.source_mode != "radio":
                    self.command("set_property", "time-pos", max(0, float(value)))
                    self.resume_position = max(0, float(value))
                    self.save_state()
            elif action == "volume":
                self.volume = max(0, min(100, int(value)))
                self.command("set_property", "volume", self.volume)
                self.save_state()
            elif action == "mute":
                self.muted = bool(value)
                self.command("set_property", "mute", self.muted)
                self.save_state()
            elif action == "shuffle":
                self.shuffle = bool(value)
                self.save_state()
            elif action == "repeat":
                if value not in {"off", "one", "all"}:
                    raise ValueError("Ungültiger Wiederholmodus.")
                self.repeat = value
                self.save_state()
            elif action == "sound":
                self.play_sound(str(value))
            else:
                raise ValueError("Unbekannter Player-Befehl.")
        return self.state()

    def state(self) -> dict:
        playlist_item = self.queue[self.current_index] if 0 <= self.current_index < len(self.queue) else None
        running = bool(self.process and self.process.poll() is None and MPV_SOCKET.exists())
        idle = bool(self.property("idle-active", True)) if running else True
        paused = bool(self.property("pause", self.resume_paused)) if running else self.resume_paused
        duration = (self.property("duration", 0) or 0) if running else 0
        position = (self.property("time-pos", self.resume_position) or 0) if running else self.resume_position
        speaker = device_info(self.connected_speaker) if self.connected_speaker else None
        reported_volume = self.property("volume", None) if running else None
        metadata = self.property("metadata", {}) if running and self.source_mode == "radio" else {}
        if not isinstance(metadata, dict):
            metadata = {}
        radio_title = metadata.get("icy-title") or metadata.get("title") or self.property("media-title", "")
        item = ({
            "title": radio_title or self.radio_station.get("name", "Internetradio"),
            "artist": self.radio_station.get("name", "Internetradio"),
            "thumbnail": self.radio_station.get("logo_url", ""),
            "source": "radio",
        } if self.source_mode == "radio" and self.radio_station else playlist_item)
        return {
            "available": True,
            "running": running,
            "playing": not idle and not paused,
            "paused": paused,
            "position": round(float(position), 1),
            "duration": round(float(duration), 1),
            "volume": self.volume if reported_volume is None else int(reported_volume),
            "muted": bool(self.property("mute", self.muted)) if running else self.muted,
            "repeat": self.repeat,
            "shuffle": self.shuffle,
            "queue": self.queue,
            "current_index": self.current_index,
            "current": item,
            "source_mode": self.source_mode,
            "radio_station": self.radio_station,
            "speaker": speaker,
            "sound_active": self.sound_active,
            "recovery_ready": bool(item and self.connected_speaker),
            "restored_at": self.restored_at,
            "last_error": self.last_error,
        }


PLAYER = MpvController()


class UnixHTTPServer(UnixStreamServer):
    allow_reuse_address = True


class Handler(BaseHTTPRequestHandler):
    server_version = "ClubIQPlayer/1.0"

    def log_message(self, format_string: str, *args) -> None:
        print(format_string % args)

    def body(self) -> dict:
        length = min(int(self.headers.get("Content-Length", "0")), 1_000_000)
        return json.loads(self.rfile.read(length) or b"{}")

    def reply(self, status: int, data: dict | list) -> None:
        encoded = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def authorized(self) -> bool:
        try:
            expected = TOKEN_FILE.read_text(encoding="utf-8").strip()
        except OSError:
            expected = ""
        return bool(expected) and self.headers.get("X-Player-Token", "") == expected

    def do_GET(self) -> None:
        if not self.authorized():
            return self.reply(403, {"error": "Nicht autorisiert."})
        try:
            if self.path == "/health":
                return self.reply(200, {"ok": True, "mpv": bool(PLAYER.process and PLAYER.process.poll() is None)})
            if self.path == "/state":
                return self.reply(200, PLAYER.state())
            if self.path == "/bluetooth/devices":
                paired = parse_devices(bluetoothctl("devices Paired"))
                return self.reply(200, {"devices": [device_info(item["address"]) for item in paired]})
            self.reply(404, {"error": "Nicht gefunden."})
        except Exception as exc:
            self.reply(503, {"error": str(exc)})

    def do_POST(self) -> None:
        if not self.authorized():
            return self.reply(403, {"error": "Nicht autorisiert."})
        try:
            data = self.body()
            if self.path == "/bluetooth/scan":
                return self.reply(200, {"devices": scan_bluetooth_devices()})
            if self.path.startswith("/bluetooth/"):
                address = str(data.get("address", "")).upper()
                if not MAC_RE.fullmatch(address):
                    return self.reply(422, {"error": "Ungültige Bluetooth-Adresse."})
                operation = self.path.rsplit("/", 1)[-1]
                if operation == "connect":
                    info = connect_bluetooth_device(address)
                    PLAYER.connected_speaker = address
                    PLAYER.last_error = ""
                    PLAYER.save_state()
                    PLAYER.restore_session()
                    return self.reply(200, {"device": info})
                if operation == "disconnect":
                    PLAYER.stop_mpv()
                    bluetoothctl(f"disconnect {address}")
                    if PLAYER.connected_speaker == address:
                        # Ein bewusstes Trennen darf nicht vom automatischen
                        # Wiederverbinden wenige Sekunden später aufgehoben werden.
                        PLAYER.connected_speaker = ""
                        PLAYER.save_state()
                    return self.reply(200, {"device": device_info(address)})
                if operation == "forget":
                    if PLAYER.connected_speaker == address:
                        PLAYER.stop_mpv()
                    bluetoothctl(f"remove {address}")
                    if PLAYER.connected_speaker == address:
                        PLAYER.connected_speaker = ""
                        PLAYER.save_state()
                    return self.reply(200, {"ok": True})
            if self.path == "/queue":
                items = data.get("items", [])
                safe = []
                for item in items:
                    url = str(item.get("url", ""))
                    if not (url.startswith("https://www.youtube.com/watch?v=") or url.startswith("http://127.0.0.1:")):
                        raise ValueError("Nicht erlaubte Medienadresse.")
                    safe.append({
                        "id": str(item["id"])[:100], "title": str(item["title"])[:255],
                        "artist": str(item.get("artist", ""))[:255], "thumbnail": str(item.get("thumbnail", ""))[:500],
                        "url": url, "source": str(item.get("source", "ranking"))[:20],
                    })
                PLAYER.set_queue(safe)
                return self.reply(200, PLAYER.state())
            if self.path == "/radio":
                PLAYER.play_radio(data.get("station", {}))
                return self.reply(200, PLAYER.state())
            if self.path == "/radio/stop":
                PLAYER.stop_radio()
                return self.reply(200, PLAYER.state())
            if self.path == "/queue/add":
                item = data.get("item", {})
                url = str(item.get("url", ""))
                if not url.startswith("https://www.youtube.com/watch?v="):
                    raise ValueError("Nicht erlaubte Medienadresse.")
                safe_item = {
                    "id": str(item.get("id", ""))[:100],
                    "title": str(item.get("title", ""))[:255],
                    "artist": str(item.get("artist", ""))[:255],
                    "thumbnail": str(item.get("thumbnail", ""))[:500],
                    "url": url,
                    "source": "dj",
                }
                if not safe_item["id"] or not safe_item["title"]:
                    raise ValueError("Songangaben fehlen.")
                position = str(data.get("position", "end"))
                if position not in {"next", "end"}:
                    raise ValueError("Ungültige Position.")
                PLAYER.add_queue_item(safe_item, position)
                return self.reply(200, PLAYER.state())
            if self.path == "/queue/move":
                PLAYER.move_queue_item(int(data.get("source_index", -1)), int(data.get("target_index", -1)))
                return self.reply(200, PLAYER.state())
            if self.path == "/queue/remove":
                PLAYER.remove_queue_item(int(data.get("index", -1)))
                return self.reply(200, PLAYER.state())
            if self.path == "/queue/play":
                PLAYER.play_queue_item(int(data.get("index", -1)))
                return self.reply(200, PLAYER.state())
            if self.path == "/command":
                return self.reply(200, PLAYER.act(str(data.get("action", "")), data.get("value")))
            self.reply(404, {"error": "Nicht gefunden."})
        except (ValueError, KeyError) as exc:
            self.reply(422, {"error": str(exc)})
        except Exception as exc:
            PLAYER.last_error = str(exc)
            self.reply(503, {"error": str(exc)})


def reconnect_loop(stop: threading.Event) -> None:
    while not stop.is_set():
        address = PLAYER.connected_speaker
        if address and BLUETOOTH_LOCK.acquire(blocking=False):
            try:
                connected = bool(device_info(address)["connected"])
                if not connected:
                    PLAYER.checkpoint_playback()
                    PLAYER.stop_mpv()
                    bluetoothctl("power on")
                    bluetoothctl(f"connect {address}", timeout=12)
                    connected = bool(device_info(address)["connected"])
                if connected and not (PLAYER.process and PLAYER.process.poll() is None):
                    with PLAYER.lock:
                        PLAYER.restore_session()
            except Exception as exc:
                PLAYER.last_error = f"Bluetooth-Wiederverbindung: {exc}"
            finally:
                BLUETOOTH_LOCK.release()
        stop.wait(10)


def playback_loop(stop: threading.Event) -> None:
    while not stop.wait(1):
        if PLAYER.sound_active or not (PLAYER.process and PLAYER.process.poll() is None):
            continue
        idle = bool(PLAYER.property("idle-active", True))
        if not idle:
            PLAYER.track_was_active = True
            if PLAYER.source_mode == "radio":
                PLAYER.radio_retry_count = 0
                PLAYER.last_error = ""
            if time.monotonic() - PLAYER.last_checkpoint >= 5:
                PLAYER.last_checkpoint = time.monotonic()
                try:
                    PLAYER.checkpoint_playback()
                except Exception as exc:
                    PLAYER.last_error = f"Player-Sicherung: {exc}"
        elif PLAYER.source_mode == "radio" and time.monotonic() - PLAYER.radio_last_load_at >= 5:
            try:
                with PLAYER.lock:
                    PLAYER.retry_radio()
            except Exception as exc:
                PLAYER.last_error = f"Internetradio: {exc}"
                PLAYER.radio_last_load_at = time.monotonic()
        elif PLAYER.track_was_active:
            PLAYER.track_was_active = False
            try:
                with PLAYER.lock:
                    PLAYER.advance_after_end()
            except Exception as exc:
                PLAYER.last_error = f"Warteschlange: {exc}"


def main() -> None:
    SOCKET_PATH.parent.mkdir(parents=True, exist_ok=True)
    SOCKET_PATH.unlink(missing_ok=True)
    stop = threading.Event()
    threading.Thread(target=reconnect_loop, args=(stop,), daemon=True).start()
    threading.Thread(target=playback_loop, args=(stop,), daemon=True).start()
    server = UnixHTTPServer(str(SOCKET_PATH), Handler)
    os.chmod(SOCKET_PATH, 0o600)
    try:
        os.chown(SOCKET_PATH, 10001, -1)
    except PermissionError:
        pass
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    try:
        server.serve_forever()
    finally:
        stop.set()
        try:
            with PLAYER.lock:
                PLAYER.checkpoint_playback()
        except Exception:
            pass
        SOCKET_PATH.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
