"""Build ClubIQ's original, short arcade sound pack (Python stdlib + eSpeak NG).

Usage: python scripts/generate-soundpack.py --espeak /path/to/espeak-ng
No downloaded samples, music recordings or imitated celebrity voices are used.
"""
import argparse
from array import array
import hashlib
import json
import math
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import wave

RATE = 22050
ROOT = Path(__file__).resolve().parents[1] / "soundpack"

# Stable keys: removing a bundled button in the app must survive later updates.
CALLS = [
    ("180", "180!", "Darts", "gold", "en-gb", "One hundred and eighty!"),
    ("140", "140!", "Darts", "green", "en-gb", "One hundred and forty!"),
    ("100", "100!", "Darts", "green", "en-gb", "One hundred!"),
    ("60", "60!", "Darts", "blue", "en-gb", "Sixty!"),
    ("26", "Die klassische 26", "Spaß", "blue", "de", "Sechsundzwanzig. Der Klassiker!"),
    ("bullseye", "Bullseye!", "Darts", "gold", "en-gb", "Bull's eye!"),
    ("checkout", "Checkout!", "Darts", "gold", "en-gb", "Check out!"),
    ("game-shot", "Game Shot!", "Darts", "gold", "en-gb", "Game shot!"),
    ("game-on", "Game On!", "Darts", "green", "en-gb", "Game on!"),
    ("matchdart", "Matchdart", "Darts", "red", "de", "Ruhe bitte. Matchdart!"),
    ("double", "Doppel getroffen!", "Darts", "green", "de", "Doppel getroffen!"),
    ("triple", "Triple Twenty!", "Darts", "green", "en-gb", "Triple twenty!"),
    ("nine-darter", "Neun-Darter!", "Darts", "gold", "de", "Neun Darter! Unglaublich!"),
    ("bust", "Überworfen!", "Darts", "red", "de", "Überworfen! Nächster Versuch!"),
    ("madhouse", "Madhouse · Doppel 1", "Darts", "red", "en-gb", "Madhouse! Double one!"),
    ("barver", "Auf geht's, Barver!", "Jubel", "green", "de", "Auf geht's, Barver!"),
    ("good-darts", "Good Darts!", "Darts", "blue", "en-gb", "Good darts!"),
    ("warmup", "Nur warmgeworfen", "Spaß", "blue", "de", "Das war nur zum Warmwerfen!"),
    ("board", "Die Scheibe war's", "Spaß", "blue", "de", "Die Scheibe hing schief!"),
    ("maths", "Kurz nachrechnen", "Spaß", "blue", "de", "Moment. Ich muss kurz rechnen!"),
    ("almost", "Knapp daneben", "Spaß", "red", "de", "Knapp daneben ist auch vorbei!"),
    ("next-round", "Nächste Runde!", "Darts", "green", "de", "Nächste Runde! Pfeile bereit!"),
]
EFFECTS = [
    ("three-darts", "Drei Pfeile", "Darts", "green", 1.5),
    ("fanfare", "Siegesfanfare", "Jubel", "gold", 2.0),
    ("applause", "Mini-Applaus", "Jubel", "gold", 2.6),
    ("drumroll", "Trommelwirbel", "Jubel", "gold", 2.2),
    ("level-up", "Level Up!", "Jubel", "green", 1.3),
    ("airhorn", "Kurze Party-Tröte", "Jubel", "gold", 1.1),
    ("rimshot", "Ba-dum-tss", "Spaß", "blue", 1.5),
    ("trombone", "Pech gehabt", "Spaß", "red", 2.2),
    ("boing", "Boing!", "Spaß", "blue", 1.3),
    ("crickets", "Grillenzirpen", "Spaß", "blue", 2.4),
]


def add_tone(out, start, length, frequency, gain=0.3, end_frequency=None, brass=False):
    phase = 0.0
    for i in range(min(int(length * RATE), len(out) - int(start * RATE))):
        t = i / RATE
        freq = frequency if end_frequency is None else frequency + (end_frequency - frequency) * t / length
        phase += 2 * math.pi * freq / RATE
        envelope = min(1, t / 0.012, (length - t) / 0.06)
        value = math.sin(phase)
        if brass:
            value += 0.3 * math.sin(2 * phase) + 0.15 * math.sin(3 * phase)
        out[int(start * RATE) + i] += gain * max(0, envelope) * value


def add_hit(out, start, length, rng, gain=0.5, pitch=160):
    for i in range(min(int(length * RATE), len(out) - int(start * RATE))):
        t = i / RATE
        attack = min(1, t / 0.002)
        decay = math.exp(-t * 6 / length)
        value = 0.7 * rng.uniform(-1, 1) + 0.3 * math.sin(2 * math.pi * pitch * t)
        out[int(start * RATE) + i] += gain * attack * decay * value


def effect(key, length):
    out = [0.0] * int(length * RATE)
    rng = random.Random(key)
    if key == "three-darts":
        for t in (0.1, 0.6, 1.1):
            add_hit(out, t, 0.16, rng, pitch=220)
    elif key == "fanfare":
        for t, freq, duration in ((0.05, 392, .2), (.3, 523.25, .2), (.55, 659.25, .2), (.8, 783.99, .95)):
            add_tone(out, t, duration, freq, brass=True)
            add_tone(out, t, duration, freq / 2, gain=.13)
    elif key == "applause":
        for _ in range(95):
            t = rng.uniform(.05, 2.3)
            add_hit(out, t, .065, rng, gain=rng.uniform(.08, .28) * min(1, (2.6-t)/.6), pitch=900)
    elif key == "drumroll":
        for i in range(33):
            add_hit(out, .05 + i*.047, .075, rng, gain=.1 + .012*i, pitch=180)
        add_hit(out, 1.68, .5, rng, .55, 2200)
    elif key == "level-up":
        for i, freq in enumerate((523.25, 659.25, 783.99, 1046.5)):
            add_tone(out, .05 + i*.2, .22 if i < 3 else .5, freq)
    elif key == "airhorn":
        for t, duration in ((.04, .19), (.31, .55)):
            for freq in (220, 277.18, 329.63):
                add_tone(out, t, duration, freq, .15, brass=True)
    elif key == "rimshot":
        add_hit(out, .05, .13, rng, pitch=150)
        add_hit(out, .31, .15, rng, pitch=230)
        add_hit(out, .52, .9, rng, .5, 4100)
    elif key == "trombone":
        for i, freq in enumerate((293.66, 277.18, 261.63)):
            add_tone(out, .05+i*.36, .31, freq, brass=True)
        add_tone(out, 1.15, .92, 246.94, end_frequency=160, brass=True)
    elif key == "boing":
        for i in range(6):
            add_tone(out, .05+i*.17, .2, 520-i*55, .3/(1+i*.22), end_frequency=130+i*20)
    elif key == "crickets":
        for start in (.1, .9, 1.7):
            for i in range(4):
                add_tone(out, start+i*.085, .045, 2900, .2)
    return out


def normalize(samples):
    # Common RMS target (~-21 dBFS), peak ceiling -6 dBFS; no harsh clipped hits.
    peak = max(abs(value) for value in samples)
    active = [value for value in samples if abs(value) > peak * .015]
    rms = math.sqrt(sum(value*value for value in active) / len(active))
    gain = min(.5 / peak, .089 / rms)
    samples = [value * gain for value in samples]
    for i in range(min(220, len(samples) // 2)):
        samples[i] *= i / 220
        samples[-1-i] *= i / 220
    return samples


def save(key, samples):
    pcm = array("h", (round(value * 32767) for value in normalize(samples)))
    if sys.byteorder != "little":
        pcm.byteswap()
    path = ROOT / (key + ".wav")
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        output.writeframes(pcm.tobytes())
    return {"file": path.name, "duration_ms": round(len(samples) / RATE * 1000),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def speech(executable, text, voice):
    with tempfile.TemporaryDirectory(prefix="clubiq-voice-") as temp:
        path = Path(temp) / "voice.wav"
        subprocess.run([executable, "-v", voice, "-s", "150", "-p", "38", "-a", "100",
                        "-w", str(path), text], check=True, timeout=20)
        with wave.open(str(path)) as source:
            assert source.getframerate() == RATE and source.getnchannels() == 1 and source.getsampwidth() == 2
            pcm = array("h", source.readframes(source.getnframes()))
        if sys.byteorder != "little":
            pcm.byteswap()
        samples = [value / 32768 for value in pcm]
        # Trim long synthesizer tail, preserve a short release and leading margin.
        audible = [i for i, value in enumerate(samples) if abs(value) > .003]
        if not audible:
            raise ValueError("Empty speech output")
        return [0.0] * 1100 + samples[max(0, audible[0]-220):audible[-1]+2200]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--espeak", default="espeak-ng")
    args = parser.parse_args()
    ROOT.mkdir(exist_ok=True)
    items = []
    for key, name, category, color, voice, text in CALLS:
        items.append({"key": "clubiq-v1-" + key, "name": name, "category": category,
                      "color": color, "text": text, "voice": voice,
                      **save(key, speech(args.espeak, text, voice))})
    for key, name, category, color, length in EFFECTS:
        items.append({"key": "clubiq-v1-" + key, "name": name, "category": category,
                      "color": color, **save(key, effect(key, length))})
    (ROOT / "manifest.json").write_text(json.dumps(items, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Generated {len(items)} sounds in {ROOT}")


if __name__ == "__main__":
    main()
