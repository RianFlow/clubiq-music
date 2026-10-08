"""Persistent, unprivileged WireGuard egress for the isolated darts collector."""
import importlib.util
import json
import os
import signal
import subprocess
import threading
import time
import tomllib
from pathlib import Path

STATE = Path("/state")
STOP = threading.Event()
spec = importlib.util.spec_from_file_location("egress_health", Path(__file__).with_name("darts-egress-health.py"))
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


def quiet_command(args, timeout=120):
    # Both tools can include private configuration values in error messages.
    subprocess.run(args, cwd=STATE, check=True, timeout=timeout,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def bootstrap():
    account = STATE / "wgcf-account.toml"
    profile = STATE / "wgcf-profile.conf"
    attempt = STATE / "registration.attempted"
    if not profile.exists():
        if not account.exists():
            if attempt.exists():
                raise RuntimeError("Previous registration attempt requires inspection")
            if os.environ.get("DARTS_WARP_ACCEPT_TOS") != "1":
                raise RuntimeError("Initial WARP terms acceptance required")
            # An uncertain initial request must not create new devices on every restart.
            with attempt.open("x", encoding="utf-8") as marker:
                marker.write("Initial registration requested\n")
            attempt.chmod(0o600)
            quiet_command(["wgcf", "--config", str(account), "register", "--accept-tos",
                           "--name", "clubiq-darts-egress"])
        stored = tomllib.loads(account.read_text())
        if not all(stored.get(key) for key in ("device_id", "access_token", "private_key")):
            raise RuntimeError("Stored WARP registration is incomplete")
        quiet_command(["wgcf", "--config", str(account), "generate", "--profile", str(profile),
                       "--keepalive", "25"])
    # No direct-fallback routing or endpoint/IP rotation rules are configured.
    config = STATE / "wireproxy.conf"
    config.write_text("WGConfig = /state/wgcf-profile.conf\n\n[Resolve]\nResolveStrategy = ipv4\n\n"
                      "[http]\nBindAddress = 0.0.0.0:40001\n", encoding="utf-8")
    for private_file in (account, profile, config):
        if private_file.exists():
            private_file.chmod(0o600)
    quiet_command(["wireproxy", "--config", str(config), "--configtest"], timeout=15)
    attempt.unlink(missing_ok=True)


def save_health(healthy, error=""):
    result = {"healthy": healthy, "checkedAt": time.time(), "error": error}
    temporary = STATE / "health.tmp"
    temporary.write_text(json.dumps(result), encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(STATE / "health.json")


def stop_child(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)


def wait(seconds, child=None):
    deadline = time.monotonic() + seconds
    while not STOP.is_set() and time.monotonic() < deadline:
        if child is not None and child.poll() is not None:
            return False
        STOP.wait(min(1, max(0, deadline - time.monotonic())))
    return not STOP.is_set()


def supervise():
    while not STOP.is_set():
        save_health(False, "starting")
        child = subprocess.Popen(["wireproxy", "--silent", "--config", str(STATE / "wireproxy.conf")],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        failures = 0
        try:
            wait(5, child)
            while not STOP.is_set() and child.poll() is None:
                good, error, recoverable = health.probe()
                save_health(good, error)
                failures = 0 if good or not recoverable else failures + 1
                if failures >= 3:
                    print("Egress connection failed three probes; restarting the existing tunnel.", flush=True)
                    break
                if not wait(60, child):
                    break
        finally:
            stop_child(child)
            save_health(False, "stopped" if STOP.is_set() else "recovering")
        # A fixed delay prevents restart storms. The profile and registration are reused.
        if not wait(30):
            break


def main():
    import fcntl
    os.umask(0o077)
    STATE.mkdir(exist_ok=True)
    STATE.chmod(0o700)
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: STOP.set())
    with (STATE / ".egress.lock").open("a") as lock:
        # Sharing one registration between concurrent replicas is unsupported.
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        bootstrap()
        supervise()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Keep private keys, token-bearing URLs and tool output out of Docker logs.
        print("Egress initialization failed: " + type(exc).__name__, flush=True)
        raise SystemExit(1)
