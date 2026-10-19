#!/usr/bin/env python3
"""Package the compiled host and Electron runtime into one locally signed app."""
from pathlib import Path
import shutil, plistlib, subprocess, json, hashlib, os
version=os.environ.get('PERFORMER_VERSION','0.1.0')
root=Path(__file__).resolve().parent
app=root/'dist'/'Performer Studio.app'
source=root/'vendor/electron/Electron.app'
manifest=json.loads((root/'dependencies.json').read_text())
performer=(root/manifest['performerSource']).read_bytes()
actual=hashlib.sha256(performer).hexdigest()
assert actual==manifest['performerSHA256'], f"Performer snapshot differs from the pinned integration source ({actual} != {manifest['performerSHA256']}); check line endings."
(root/'shell/assets').mkdir(exist_ok=True)
(root/'shell/assets/app.js').write_bytes(performer)
engine=root/'build/PerformerAudio_artefacts/Release/Performer Audio Engine.app'
assert source.exists() and engine.exists(), 'Build the native engine and fetch Electron first.'
# Only replace our generated app bundle, never an installed application.
if app.exists(): shutil.rmtree(app)
app.parent.mkdir(exist_ok=True)
shutil.copytree(source,app,symlinks=True)
resources=app/'Contents/Resources'
(resources/'default_app.asar').unlink(missing_ok=True)
shutil.copytree(root/'shell',resources/'app')
shutil.copy2(root/'vendor/JUCE-8.0.12/LICENSE.md',resources/'JUCE-LICENSE.md')
shutil.copy2(root.parent/'LICENSE',resources/'LICENSE-AGPL-3.0.txt')
shutil.copy2(root/'vendor/JUCE-8.0.12/modules/juce_audio_devices/native/asio/LICENSE.txt',resources/'ASIO-LICENSE.txt')
shutil.copy2(root/'shell/performer.icns',resources/'performer.icns')
shutil.copytree(engine,resources/'native/Performer Audio Engine.app',symlinks=True)
plist=app/'Contents/Info.plist'
info=plistlib.loads(plist.read_bytes())
info.update(CFBundleIconFile='performer.icns',CFBundleDisplayName='Performer Studio',CFBundleName='Performer Studio',CFBundleIdentifier='org.pianoperformances.studio',CFBundleVersion=version,CFBundleShortVersionString=version,NSMicrophoneUsageDescription='Use your selected microphone in the performer mixer.',NSCameraUsageDescription='Track your performance using your selected webcams.',NSHighResolutionCapable=True)
plist.write_bytes(plistlib.dumps(info))
helper=resources/'native/Performer Audio Engine.app/Contents/Info.plist'
info=plistlib.loads(helper.read_bytes());info['LSUIElement']=True;helper.write_bytes(plistlib.dumps(info))
subprocess.run(['codesign','--force','--deep','--sign','-',str(app)],check=True)
subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
receipt={'version':version,'architecture':'arm64','signing':'local ad-hoc; not notarized','app':str(app),'juce':'8.0.12','electron':'44.9.0','performerScriptSHA256':hashlib.sha256((resources/'app/assets/app.js').read_bytes()).hexdigest()}
(root/'dist/build-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(app)
