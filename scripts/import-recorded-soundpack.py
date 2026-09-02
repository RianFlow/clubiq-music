"""Import licensed, real recordings. No speech synthesis or generated effects.

Maintainer-only: python scripts/import-recorded-soundpack.py --ffmpeg /path/to/ffmpeg
Downloads the public HQ previews linked by the original Freesound pages, verifies
their license, converts/trims/levels them, and records source and output hashes.
The Raspberry uses the committed WAVs; it never downloads sounds at startup.
"""
import argparse
from array import array
import hashlib
import html
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.request import Request, urlopen
import wave

ROOT = Path(__file__).resolve().parents[1]
RATE = 22050
CC0 = "https://creativecommons.org/publicdomain/zero/1.0/"
CC_BY = "https://creativecommons.org/licenses/by/4.0/"
# key, button, category, color, author, source ID, uploader ID, title, seconds,
# license, recording evidence (paraphrased from the source description).
SOURCES = [
    ("dart-hit", "Dart-Treffer", "Darts", "green", "aidansamuel", 540132, 10965608,
     "Darts.wav", 3.1, CC0, "Dartboard impacts recorded with a Zoom H6."),
    ("darts", "Pfeile auf die Scheibe", "Darts", "green", "bsumusictech", 62455, 791247,
     "dart hits.wav", 8.6, CC0, "Darts being thrown and picked up, recorded with a Zoom H4."),
    ("cheer", "Jubel & Applaus", "Jubel", "gold", "AlaskaRobotics", 221568, 1282865,
     "cheering and clapping crowd 1", 6.5, CC0, "School-gym crowd recorded with a Marantz PMD660."),
    ("applause", "Applaus im Club", "Jubel", "gold", "KentVideoProduction", 199277, 2590049,
     "Applause", 5.5, CC0, "About 50 people applauding in a jazz club, recorded on an iPhone."),
    ("drumroll", "Trommelwirbel", "Jubel", "gold", "bigjoedrummer", 77305, 1105584,
     "buzz roll.wav", 4.9, CC0, "Snare roll recorded with a Sony condenser microphone and iRiver H340."),
    ("horn", "Sieges-Hupe", "Jubel", "gold", "mcpable", 131930, 1542102,
     "Industrial Air Horn", 2.8, CC0, "Air horn on an oil rig in Alberta."),
    ("rimshot", "Rimshot", "Spaß", "blue", "Sajmund", 132418, 2412414,
     "Rimshot (sweet)", 1.3, CC0, "A 14-inch wooden snare played with a 7a stick."),
    ("trombone", "Pech gehabt!", "Spaß", "red", "Benboncan", 73581, 634166,
     "Sad Trombone.wav", 4.0, CC_BY, "Trombone sequence performed by the recordist's neighbour."),
    ("laugh", "Ansteckendes Lachen", "Spaß", "blue", "SamuelGremaud", 468514, 8031303,
     "WOMAN LAUGH", 2.5, CC0, "A woman laughing, recorded with a Zoom H4N Pro."),
    ("group-laugh", "Publikum lacht", "Spaß", "blue", "kikorurelas", 767470, 6252416,
     "Female crowd laughing", 5.5, CC0, "Amateur performers laughing, recorded with the XY microphone of a Zoom H6."),
    ("boo", "Buh-Rufe", "Spaß", "red", "HowardV", 264378, 1654262,
     "crowd booing", 4.5, CC0, "About 20 adults in a small hall, recorded with a Rode VideoMic Pro."),
    ("slide-whistle", "Rutsch-Pfeife", "Spaß", "blue", "jcookvoice", 586529, 9341034,
     "slide whistle.wav", 4.2, CC0, "Slide whistle recorded with an AT2020 microphone."),
    ("crickets", "Peinliche Stille", "Spaß", "blue", "selcukartut", 504882, 778707,
     "crickets", 4.5, CC0, "Crickets in Maasai Mara, recorded with a Zoom recorder."),
]


def download(url, limit):
    with urlopen(Request(url, headers={"User-Agent": "ClubIQ-Music-Soundpack/2.0"}), timeout=30) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Download exceeds size limit")
    return data


def level_recording(pcm):
    """Apply only gain and short edge fades; preserve the actual performance."""
    if not pcm:
        raise ValueError("Empty recording")
    peak = max(abs(value) for value in pcm)
    active = [value for value in pcm if abs(value) > peak * .025]
    if not peak or not active:
        raise ValueError("Silent recording")
    rms = math.sqrt(sum(value * value for value in active) / len(active))
    gain = min((32767 * 10 ** (-21 / 20)) / rms, 16380 / peak)
    fade_in, fade_out = int(RATE * .005), int(RATE * .06)
    return array("h", (round(value * gain * min(1, i / fade_in, (len(pcm) - 1 - i) / fade_out))
                       for i, value in enumerate(pcm)))


def credits_html(items):
    esc = html.escape
    rows = []
    for item in items:
        source = item["source"]
        rows.append(f'<li><strong>{esc(item["name"])}</strong> – '
                    f'<a href="{esc(source["url"])}">{esc(source["title"])}</a> '
                    f'von {esc(source["author"])} · '
                    f'<a href="{esc(source["license_url"])}">{esc(source["license"])}</a>. '
                    'Bearbeitet: gekürzt, Mono-WAV, Pegel angeglichen, kurze Ein-/Ausblendung.</li>')
    return ('<!doctype html><html lang="de"><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>Sound-Quellen · ClubIQ Music</title>'
            '<link rel="stylesheet" href="/static/app.css">'
            '<main class="shell"><h1>Echte Aufnahmen · Sound-Quellen</h1>'
            '<p>Keine Sprachsynthese und keine zufällig erzeugten Effekte. '
            'Die Ausschnitte stammen aus den öffentlich verlinkten HQ-Vorschauen '
            'der unten genannten Aufnahmen. Die Urheber unterstützen ClubIQ damit nicht ausdrücklich.</p>'
            '<ul>' + ''.join(rows) + '</ul>'
            '<p>Die Lizenzen der Audiodateien bleiben unabhängig von der Software-Lizenz gültig. '
            'Bei Weitergabe müssen insbesondere die Angaben für die CC-BY-Aufnahme erhalten bleiben.</p>'
            '<p><a href="/">Zurück zu ClubIQ Music</a></p></main></html>\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", required=True)
    args = parser.parse_args()
    items = []
    with tempfile.TemporaryDirectory(prefix="clubiq-recordings-") as temporary:
        for key, name, category, color, author, sound_id, uploader, title, seconds, license_url, evidence in SOURCES:
            source_url = f"https://freesound.org/people/{author}/sounds/{sound_id}/"
            preview_url = f"https://cdn.freesound.org/previews/{sound_id // 1000}/{sound_id}_{uploader}-hq.mp3"
            page = download(source_url, 2_000_000).decode("utf-8")
            if license_url.removeprefix("https:") not in page or preview_url not in page:
                raise ValueError(f"Source/license changed; review {source_url}")
            data = download(preview_url, 12_000_000)
            original = Path(temporary) / f"{key}.mp3"
            original.write_bytes(data)
            result = subprocess.run([args.ffmpeg, "-v", "error", "-nostdin", "-i", str(original),
                                     "-t", str(seconds), "-vn", "-ac", "1", "-ar", str(RATE),
                                     "-f", "s16le", "pipe:1"], check=True, capture_output=True)
            pcm = array("h", result.stdout)
            if sys.byteorder != "little":
                pcm.byteswap()
            pcm = level_recording(pcm)
            duration = round(len(pcm) / RATE * 1000)
            if sys.byteorder != "little":
                pcm.byteswap()
            filename = f"recorded-{key}.wav"
            path = ROOT / "soundpack" / filename
            with wave.open(str(path), "wb") as wav:
                wav.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
                wav.writeframes(pcm.tobytes())
            items.append({"key": f"clubiq-v2-{key}", "name": name, "category": category,
                          "color": color, "file": filename, "duration_ms": duration,
                          "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                          "source": {"kind": "recording", "title": title, "author": author,
                                     "url": source_url, "download_url": preview_url,
                                     "download_sha256": hashlib.sha256(data).hexdigest(),
                                     "license": "CC0-1.0" if license_url == CC0 else "CC-BY-4.0",
                                     "license_url": license_url, "verified_at": "2026-09-02",
                                     "recording_evidence": evidence,
                                     "edits": f"First {duration} ms; mono 22050 Hz PCM16; gain adjustment; edge fades."}})
            print(f"Imported {name}: {duration} ms")
    (ROOT / "soundpack" / "manifest.json").write_text(json.dumps(items, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (ROOT / "static" / "soundboard-credits.html").write_text(credits_html(items), encoding="utf-8")


if __name__ == "__main__":
    main()
