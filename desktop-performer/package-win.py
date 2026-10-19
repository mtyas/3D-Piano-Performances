#!/usr/bin/env python3
"""Package the compiled audio engine and Electron runtime into a portable Windows folder and zip.

Run on Windows after `python fetch-deps.py` and a Release build of the native engine.
"""
from pathlib import Path
import hashlib, json, shutil

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'dependencies.json').read_text())
version = '0.1.0'
performer = (root / manifest['performerSource']).read_bytes()
assert hashlib.sha256(performer).hexdigest() == manifest['performerSHA256'], 'Performer snapshot differs from the pinned integration source.'
(root / 'shell/assets').mkdir(exist_ok=True)
(root / 'shell/assets/app.js').write_bytes(performer)

electron = root / 'vendor/electron'
engine = root / 'build/PerformerAudio_artefacts/Release/Performer Audio Engine.exe'
assert (electron / 'electron.exe').exists() and engine.exists(), 'Run fetch-deps.py and build the native engine (Release) first.'

app = root / 'dist' / 'Performer Studio'
# Only replace our generated output folder.
if app.exists():
    shutil.rmtree(app)
app.parent.mkdir(exist_ok=True)
shutil.copytree(electron, app)
(app / 'electron.exe').rename(app / 'Performer Studio.exe')
resources = app / 'resources'
(resources / 'default_app.asar').unlink(missing_ok=True)
shutil.copytree(root / 'shell', resources / 'app')
(resources / 'native').mkdir()
shutil.copy2(engine, resources / 'native' / engine.name)
shutil.copy2(root / f"vendor/JUCE-{manifest['juce']['version']}/LICENSE.md", resources / 'JUCE-LICENSE.md')

archive = shutil.make_archive(str(root / 'dist' / f'Performer-Studio-{version}-win-x64'), 'zip', app.parent, app.name)
receipt = {'version': version, 'architecture': 'x64', 'signing': 'unsigned', 'folder': str(app), 'zip': archive,
           'juce': manifest['juce']['version'], 'electron': manifest['electron']['version'],
           'performerScriptSHA256': hashlib.sha256((resources / 'app/assets/app.js').read_bytes()).hexdigest()}
(root / 'dist/build-receipt-win.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(archive)
