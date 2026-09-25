from __future__ import annotations

import base64
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def encoded(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Aufruf: generate-vapid.py PFAD_ZUR_ENV")
    target = Path(sys.argv[1]).resolve()
    if not target.is_file():
        raise SystemExit("Die angegebene .env-Datei fehlt.")
    text = target.read_text(encoding="utf-8")
    required = ("DARTS_VAPID_PUBLIC_KEY", "DARTS_VAPID_PRIVATE_KEY", "DARTS_VAPID_SUBJECT")
    if all(has_value(text, key) for key in required):
        print("VAPID-Schlüssel bereits vorhanden; keine Änderung.")
        return
    private = ec.generate_private_key(ec.SECP256R1())
    private_der = private.private_bytes(
        serialization.Encoding.DER,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    public_bytes = private.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    values = {
        "DARTS_VAPID_PUBLIC_KEY": encoded(public_bytes),
        "DARTS_VAPID_PRIVATE_KEY": encoded(private_der),
        "DARTS_VAPID_SUBJECT": "https://barverdarts.clubiq.party",
    }
    lines = text.splitlines()
    found = set()
    for index, line in enumerate(lines):
        key = line.split("=", 1)[0].strip() if "=" in line else ""
        if key in values:
            lines[index] = f"{key}={values[key]}"
            found.add(key)
    if found != values.keys():
        if lines and lines[-1]:
            lines.append("")
        lines.extend(f"{key}={value}" for key, value in values.items() if key not in found)
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(target, 0o600)
    print("VAPID-Schlüssel eingerichtet.")


def has_value(text: str, key: str) -> bool:
    return any(line.startswith(f"{key}=") and bool(line.split("=", 1)[1].strip()) for line in text.splitlines())


if __name__ == "__main__":
    main()
