# Performer Studio (desktop)

Native audio mixer (JUCE, VST3 hosting) and Electron shell for performing on the 3D stage from macOS or Windows.

See [docs/desktop-studio.md](../docs/desktop-studio.md) for features, usage, building from source and tests.

| File | Purpose |
| --- | --- |
| `native/Main.cpp` | Audio engine: device I/O, plug-in graph, mixer, PCM transport (stdin/stdout JSON control, fd 3 PCM) |
| `shell/main.cjs` | Electron main process: starts the engine, hosts the Mixer and Performer tabs |
| `shell/mixer.js`, `shell/console-controls.js` | Mixer UI |
| `shell/stage-bridge.js`, `shell/pcm-worklet.js` | Bridge injected into the stage page: native MIDI and audio into the browser recorder |
| `fetch-deps.py` | Downloads and verifies JUCE and Electron |
| `package-mac.py`, `package-win.py` | Package the app for macOS / Windows |
