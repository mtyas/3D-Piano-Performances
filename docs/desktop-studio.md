# Performer Studio desktop app (macOS and Windows)

Performer Studio is an optional desktop app for the performer. It has two tabs that keep running side by side:

- **Performer:** the normal stage page, with sign-in, webcams, live show and archive controls.
- **Mixer:** a native audio console that hosts your VST3 plug-ins. It has a piano instrument channel and a microphone channel, two inserts per channel, two stereo aux buses (two inserts each) and two master inserts. It also has stereo meters, mute, solo, pan/balance, bypass and a separate headphone level.

The master output feeds the live stream and recording directly. No virtual audio cable or loopback device is needed.

Status: **0.1 preview.** The macOS Apple Silicon build is tested with Pianoteq 9 and UADx plug-ins. The Windows x64 build adds ASIO, Windows Audio (WASAPI) and DirectSound support, but it has not yet been tested on Windows hardware. Please report issues.

## Signal flow

```
MIDI -> VST3 instrument -> piano inserts -> piano fader/balance --+--> master inserts -> master fader -> stream
                                                               |                                  -> headphone level -> audio output
Audio input -> input 1/2 -> mic inserts -> mic fader/pan -------+
                                    | post-fader aux sends     |
                                    +-> aux inserts -> return--+
```

Plug-in latency is compensated between branches. The audio callback never waits for the network or the stage page.

## Using it

1. **Mixer → Driver:** choose the audio driver. On macOS that is **CoreAudio**. On Windows, use **ASIO** when your interface has an ASIO driver (lowest latency); otherwise use **Windows Audio** or **Windows Audio (Low Latency Mode)**.
2. Choose the input and output device, the sample rate and the buffer size. Start at 48 kHz / 256 samples. Choose **No input (piano only)** if you don't use a microphone.
3. Load your instrument (for example Pianoteq) in the piano slot, and choose your MIDI keyboard.
4. Optionally add effects: a channel strip on the microphone, a reverb on **Aux 1** (set it to 100 % wet in its editor, opened with ↗, then raise each channel's Aux 1 send), and a bus compressor on the master.
5. Click **Start audio**. Headphone monitoring starts off; enable it in the Headphones section.
6. Under **Stage connection**, enter your stage (e.g. `https://stage.example.com/`, or `http://localhost:8765/` for a server on the same computer) and click **Connect**.
7. Switch to **Performer**, sign in, set up webcams and start the show as described in [performer-setup.md](performer-setup.md).

Your mixer setup (plug-ins and their settings, levels, sends, devices and MIDI choice) is saved when you quit and restored on the next launch. **Save session** and **Restore session** do the same on demand. Audio and monitoring always stay off after a restore until you start them. During a live show, plug-in loading and device changes are locked; faders, sends, mute/solo and plug-in editors stay available.

Plug-ins are listed from the standard VST3 folders:

- macOS: `/Library/Audio/Plug-Ins/VST3` and `~/Library/Audio/Plug-Ins/VST3`
- Windows: `C:\Program Files\Common Files\VST3` and `%LOCALAPPDATA%\Programs\Common\VST3`

Plug-ins run in a separate audio-engine process. If a plug-in crashes, audio stops but the app stays open; relaunch the app to restart audio.

## Build from source

The app has two parts: a native audio engine (C++, [JUCE](https://juce.com) 8.0.12) and an [Electron](https://www.electronjs.org) 44.9.0 shell. `desktop-performer/dependencies.json` pins both with SHA-256 checksums. `fetch-deps.py` downloads and verifies them.

### macOS (Apple Silicon)

Requirements: Xcode command-line tools (`xcode-select --install`), CMake 3.22+, Python 3.

```bash
cd desktop-performer
python3 fetch-deps.py
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j 6
python3 package-mac.py          # -> dist/Performer Studio.app (ad-hoc signed, not notarized)
```

### Windows (x64)

Requirements: [Visual Studio 2022](https://visualstudio.microsoft.com/) with **Desktop development with C++** (includes CMake), and Python 3. Run in a **Developer PowerShell for VS 2022**:

```powershell
cd desktop-performer
python fetch-deps.py
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
python package-win.py           # -> dist\Performer Studio\ and dist\Performer-Studio-0.1.0-win-x64.zip
```

Run `dist\Performer Studio\Performer Studio.exe`. The build is unsigned, so Windows SmartScreen may warn on first launch. ASIO support uses the ASIO interface headers bundled with JUCE 8.

### Tests

```bash
cd desktop-performer
node --test tests/audio-protocol.test.cjs
node tests/native-smoke.cjs     # offline engine test; needs Pianoteq 9 + UADx API Vision, Pure Plate, API 2500, otherwise skipped
```

### Licensing note

The project is licensed under AGPL-3.0-or-later (see [LICENSE](../LICENSE)), which matches JUCE's open-source licence (AGPLv3). The ASIO interface headers bundled with JUCE are used under their GPLv3 option, which may be combined with AGPLv3 code. If you distribute builds, include the complete corresponding source, or a written offer for it, along with the licences that `package-mac.py` and `package-win.py` copy into the app. A closed-source build would need a commercial JUCE licence and a Steinberg ASIO licence.
