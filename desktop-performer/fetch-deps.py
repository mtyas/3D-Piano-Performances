#!/usr/bin/env python3
"""Download the pinned JUCE and Electron archives, verify their SHA-256 and extract them into vendor/.

Usage: python3 fetch-deps.py            (macOS arm64, Windows x64 or Linux x64, detected automatically)
"""
from pathlib import Path
import hashlib, json, platform, shutil, subprocess, sys, tarfile, urllib.request, zipfile

root = Path(__file__).resolve().parent
vendor = root / 'vendor'
manifest = json.loads((root / 'dependencies.json').read_text())


def target():
    if sys.platform == 'darwin' and platform.machine() == 'arm64':
        return 'darwin-arm64'
    if sys.platform == 'win32' and platform.machine().lower() in ('amd64', 'x86_64'):
        return 'win32-x64'
    if sys.platform.startswith('linux') and platform.machine() == 'x86_64':
        return 'linux-x64'
    sys.exit(f'Unsupported build platform: {sys.platform} {platform.machine()} (supported: macOS arm64, Windows x64, Linux x64)')


def fetch(url, sha256, destination):
    if destination.exists() and hashlib.sha256(destination.read_bytes()).hexdigest() == sha256:
        print('Already downloaded', destination.name)
        return
    print('Downloading', url)
    with urllib.request.urlopen(url) as response, open(destination, 'wb') as out:
        shutil.copyfileobj(response, out)
    actual = hashlib.sha256(destination.read_bytes()).hexdigest()
    if actual != sha256:
        destination.unlink()
        sys.exit(f'Checksum mismatch for {destination.name}: expected {sha256}, got {actual}')


def main():
    vendor.mkdir(exist_ok=True)
    juce = manifest['juce']
    juce_dir = vendor / f"JUCE-{juce['version']}"
    archive = vendor / 'juce.tar.gz'
    fetch(juce['url'], juce['sha256'], archive)
    if not juce_dir.exists():
        with tarfile.open(archive) as tar:
            tar.extractall(vendor, filter='data') if hasattr(tarfile, 'data_filter') else tar.extractall(vendor)

    name = target()
    electron = manifest['electron']['platforms'][name]
    archive = vendor / f'electron-{name}.zip'
    fetch(electron['url'], electron['sha256'], archive)
    destination = vendor / 'electron'
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir()
    if name.startswith('darwin'):
        # The macOS app bundle relies on framework symlinks, which zipfile does not restore.
        subprocess.run(['ditto', '-x', '-k', str(archive), str(destination)], check=True)
    elif name.startswith('linux'):
        # zipfile drops the executable bits Electron needs.
        subprocess.run(['unzip', '-q', str(archive), '-d', str(destination)], check=True)
    else:
        with zipfile.ZipFile(archive) as z:
            z.extractall(destination)
    print('Ready:', juce_dir, destination)


if __name__ == '__main__':
    main()
