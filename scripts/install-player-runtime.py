#!/usr/bin/env python3
"""Install pinned, checksum-verified upstream tools without changing system Python."""
import hashlib
import argparse
import os
import platform
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path('/opt/clubiq-music-runtime')
YTDLP_VERSION = '2026.08.19'
DENO_VERSION = '2.9.6'
YTDLP_SHA256 = '1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6'
DENO_SHA256 = {
    'aarch64': '9a46afc6c392c7cd2ff71a31558935545b46408d0e87f7a86908c712721c046e',
    'x86_64': '394f07f4da2bebe6ce6f1e7ce0fa16429b29b08c35e3fac3fe25972676dff4b2',
}


def download(url, target, expected):
    digest = hashlib.sha256()
    request = urllib.request.Request(url, headers={'User-Agent': 'ClubIQ-Music-Installer'})
    with urllib.request.urlopen(request, timeout=60) as response, target.open('wb') as output:
        while chunk := response.read(1024 * 1024):
            digest.update(chunk)
            output.write(chunk)
    if digest.hexdigest() != expected:
        raise RuntimeError('Download-Pruefsumme ungueltig; Installation abgebrochen.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from-directory', type=Path, help='Pre-downloaded deno.zip and yt-dlp; checksums still mandatory')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Bitte mit sudo starten.')
    arch = platform.machine()
    if arch not in DENO_SHA256:
        raise SystemExit('Die Player-Laufzeit benoetigt ein 64-Bit-Linux (ARM64 oder x86_64).')
    version_dir = ROOT / f'yt-{YTDLP_VERSION}-deno-{DENO_VERSION}'
    ROOT.mkdir(mode=0o755, parents=True, exist_ok=True)
    # Reuse only a complete installation. Old versions remain available for rollback.
    if not (version_dir / '.complete').is_file():
        with tempfile.TemporaryDirectory(prefix='.install-', dir=ROOT) as temporary:
            stage = Path(temporary)
            for filename, url, checksum in [
                ('yt-dlp', f'https://github.com/yt-dlp/yt-dlp/releases/download/{YTDLP_VERSION}/yt-dlp', YTDLP_SHA256),
                ('deno.zip', f'https://github.com/denoland/deno/releases/download/v{DENO_VERSION}/deno-{arch}-unknown-linux-gnu.zip', DENO_SHA256[arch]),
            ]:
                if args.from_directory:
                    shutil.copyfile(args.from_directory / filename, stage / filename)
                    if hashlib.sha256((stage / filename).read_bytes()).hexdigest() != checksum:
                        raise RuntimeError('Lokale Download-Pruefsumme ungueltig; Installation abgebrochen.')
                else:
                    download(url, stage / filename, checksum)
            with zipfile.ZipFile(stage / 'deno.zip') as archive, (stage / 'deno').open('wb') as output:
                # Extract this one known filename only, never arbitrary archive paths.
                with archive.open('deno') as source:
                    shutil.copyfileobj(source, output)
            for name in ('yt-dlp', 'deno'):
                (stage / name).chmod(0o755)
                subprocess.run([str(stage / name), '--version'], check=True, timeout=20)
            (stage / 'deno.zip').unlink()
            (stage / '.complete').write_text(f'{YTDLP_VERSION}\n{DENO_VERSION}\n')
            stage.chmod(0o755)
            stage.rename(version_dir)
    link = ROOT / 'bin.new'
    link.unlink(missing_ok=True)
    link.symlink_to(version_dir.name, target_is_directory=True)
    link.replace(ROOT / 'bin')
    print(f'Player-Laufzeit bereit: yt-dlp {YTDLP_VERSION}, Deno {DENO_VERSION}')


if __name__ == '__main__':
    main()
