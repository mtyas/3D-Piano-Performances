#!/usr/bin/env python3
"""Package the compiled audio engine and Electron runtime into a portable Linux x64 folder and tarball.

Run on Linux after `python3 fetch-deps.py` and a Release build of the native engine.
"""
from pathlib import Path
import hashlib, json, os, shutil, stat, tarfile

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'dependencies.json').read_text())
version = os.environ.get('PERFORMER_VERSION', '0.1.0')
performer = (root / manifest['performerSource']).read_bytes()
actual = hashlib.sha256(performer).hexdigest()
assert actual == manifest['performerSHA256'], f"Performer snapshot differs from the pinned integration source ({actual} != {manifest['performerSHA256']}); check line endings."
(root / 'shell/assets').mkdir(exist_ok=True)
(root / 'shell/assets/app.js').write_bytes(performer)

electron = root / 'vendor/electron'
engine = root / 'build/PerformerAudio_artefacts/Release/Performer Audio Engine'
assert (electron / 'electron').exists() and engine.exists(), 'Run fetch-deps.py and build the native engine (Release) first.'

name = 'Performer-Studio'
app = root / 'dist' / name
# Only replace our generated output folder.
if app.exists():
    shutil.rmtree(app)
app.parent.mkdir(exist_ok=True)
shutil.copytree(electron, app, symlinks=True)
(app / 'electron').rename(app / 'performer-studio')
resources = app / 'resources'
(resources / 'default_app.asar').unlink(missing_ok=True)
shutil.copytree(root / 'shell', resources / 'app')
(resources / 'native').mkdir()
shutil.copy2(engine, resources / 'native' / engine.name)
(resources / 'native' / engine.name).chmod(0o755)
shutil.copy2(root.parent / 'LICENSE', resources / 'LICENSE-AGPL-3.0.txt')
shutil.copy2(root / f"vendor/JUCE-{manifest['juce']['version']}/LICENSE.md", resources / 'JUCE-LICENSE.md')
(app / 'README-LINUX.txt').write_text('''Performer Studio for Linux (x64)

Run ./performer-studio from this folder.

If it exits with a message about the "SUID sandbox helper", either give the
Chromium sandbox helper its required permissions (recommended):

    sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox

or, on Ubuntu 24.04+, allow unprivileged user namespaces for it via AppArmor.
See docs/desktop-studio.md in the source repository for details.
''')

archive = root / 'dist' / f'Performer-Studio-{version}-linux-x64.tar.gz'
with tarfile.open(archive, 'w:gz') as tar:
    tar.add(app, arcname=name)
print(archive)
