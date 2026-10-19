# Performer setup

You can perform from **a browser** (Chrome or Edge) or from the **Performer Studio desktop app**. The desktop app adds a native audio mixer with VST3 instruments and effects; see [desktop-studio.md](desktop-studio.md). Both use the same stage, sign-in and archive.

## What you need

- A computer running Chrome or Edge, on the stage's HTTPS address or `http://localhost`.
- A USB/MIDI keyboard (any class-compliant device).
- Optional: one or two webcams for body and face tracking. The front camera drives head, face, shoulders and sway; a side camera improves forward lean and spine posture.
- Optional: an audio source. This can be the built-in piano synth, an audio interface carrying your digital piano or a software instrument such as Pianoteq, or a microphone.
- The performer password created during [server setup](server-setup.md).

## Sign in

1. Open the stage, e.g. `https://stage.example.com/`.
2. Click **Enter Performer Studio →** and enter the password. The sign-in lasts 12 hours, or until you return to the lobby.

Only one performer can be connected at a time.

## 1. MIDI keyboard

Connect the keyboard before opening the page and allow MIDI access when the browser asks. Choose it in the MIDI section; the badge shows **Ready** and the log shows incoming notes. The avatar's hands follow what you play, anticipating notes with a short look-ahead buffer.

No keyboard yet? **Demo** plays a short piece so you can check the stage.

## 2. Webcams (optional)

1. Choose a **front** camera, and optionally a **side** camera with the side of the piano it sits on.
2. Click **📷 Start Tracking** and allow camera access.
3. Sit in your normal playing posture and click **🎯 Zero Sit**. Repeat this whenever you move the cameras or your chair.

Keep your shoulders, elbows and wrists in frame. Hands that are playing follow the MIDI notes; free hands follow your gestures. Camera choices are remembered, but tracking only starts when you click the button.

## 3. Audio

- **🔊 Piano Synth**: the built-in stereo piano, driven by your MIDI. No setup needed.
- **🎙️ Stream Audio In**: sends an audio input (interface, loopback device or microphone) instead. Pick the device in the list below the buttons.

In the desktop app, audio always comes from its mixer, and these browser controls are disabled.

## 4. Go live

1. Type a session title.
2. Click **⏺ Start Live Show & Record to Archive**. Visitors in the lobby see that you are live.
3. Play. The audio, MIDI and body motion are broadcast and recorded together.
4. Click the button again to stop. The recording is saved to the archive and appears in the lobby for replay.

Stop the show before closing the tab, so the recording is finalised.

## 5. Manage recordings

**Manage recordings ↗** opens the archive manager. There you can rename, hide, delete (recoverable), export and import recordings.

## Tips

- Use wired Ethernet for long shows, and close other heavy apps.
- If the stage gets slow, choose fewer in-world camera screens in **Camera & viewing**.
- Test with a short private recording before an announced show. You can hide it afterwards in the archive manager.
