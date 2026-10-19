# Security

## Performer password

Backstage (going live, recording, managing the archive) requires the performer password. There is **no default password**. Without one, sign-in is disabled while the stage and archive stay public.

- The setup scripts generate a random password in `.performer-password`, readable only by your user account. You can also provide one with `PERFORMER_PASSWORD_FILE` (recommended) or `PERFORMER_PASSWORD`. Passwords must be at least 16 characters.
- Never commit `.performer-password`, `server.env` or `.env`. They are listed in `.gitignore`.
- Rotate the password by replacing the file and restarting the server.

## Sessions

Signing in creates a random, server-side session in an `HttpOnly`, `SameSite=Strict` cookie; HTTPS deployments add `Secure`. Sessions last 12 hours, are revoked on logout or on returning to the lobby, and are discarded when the server restarts. The server checks the session on every performer message and closes expired performer connections.

Only one connection can hold the performer role at a time. Visitor connections receive live status, audio, MIDI and pose data, but cannot send show controls or broadcasts.

## Origin checks

Sign-in, logout, archive management and WebSocket handshakes must come from the exact `PUBLIC_ORIGIN`. Set it to the address bar origin of your deployment (for example `https://stage.example.com`).

## Limits

- Sign-in: 5 attempts per minute per client and 30 overall. Forwarded IP headers are not trusted, so clients behind a shared proxy share the limit.
- At most 16 sessions and 200 sockets.
- WebSocket messages: 1 MiB, 400 messages/s, 2 MiB/s.
- A recording is capped at 256 MiB of received data. Exceeding it disconnects the performer and saves what was captured.
- Archive imports are capped at 360 MiB.

Only the public stage files are served. Server code, settings, the password file and the archive folder are not reachable over HTTP; archived recordings are only available through the archive API.

## Reporting a vulnerability

Please report security issues privately through GitHub's **Security → Report a vulnerability** on this repository rather than in a public issue.
