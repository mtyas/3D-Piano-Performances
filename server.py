import archive_manager
import asyncio
import json
import math
import os
import time
import uuid
import hashlib
import hmac
import secrets
from datetime import datetime
from aiohttp import web, WSMsgType

ROOT = os.path.dirname(os.path.abspath(__file__))
ARCHIVE_DIR = os.path.abspath(os.environ.get("ARCHIVE_DIR", os.path.join(ROOT, "archives")))
os.makedirs(ARCHIVE_DIR, exist_ok=True)

PERFORMER_PASSWORD = os.environ.get("PERFORMER_PASSWORD", "")
PASSWORD_FILE = os.environ.get("PERFORMER_PASSWORD_FILE", os.path.join(ROOT, ".performer-password"))
if not PERFORMER_PASSWORD and os.path.isfile(PASSWORD_FILE):
    with open(PASSWORD_FILE) as secret_file:
        PERFORMER_PASSWORD = secret_file.read().strip()
if PERFORMER_PASSWORD and (len(PERFORMER_PASSWORD) < 16 or PERFORMER_PASSWORD == "piano2026"):
    raise ValueError("Set a unique performer password of at least 16 characters")
PASSWORD_DIGEST = hashlib.sha256(PERFORMER_PASSWORD.encode()).digest() if PERFORMER_PASSWORD else None
PERFORMER_PASSWORD = ""
PERFORMER_NAME = os.environ.get("PERFORMER_NAME", "Pianist")[:80]
PUBLIC_ORIGIN = os.environ.get("PUBLIC_ORIGIN", "http://localhost:" + os.environ.get("PORT", "8765")).rstrip("/")
SESSION_TTL = 12 * 60 * 60
sessions = {}
login_attempts = {}
MAX_RECORDING = 256 * 1024 * 1024


def valid_session(token):
    return sessions.get(token, 0) > time.time()


def normalize_event(data):
    if data.get("type") == "midi":
        note = data.get("midi")
        action = data.get("action")
        if type(note) is not int or not 21 <= note <= 108 or action not in ("noteOn", "noteOff"):
            return None
        event = {"type": "midi", "action": action, "midi": note}
        if action == "noteOn":
            velocity = data.get("velocity")
            if type(velocity) not in (int, float) or not math.isfinite(velocity) or not 0 <= velocity <= 1:
                return None
            event["velocity"] = velocity
        return event
    if data.get("type") == "pose" and isinstance(data.get("pose"), dict):
        pose = {}
        for name in ("yaw", "pitch", "roll", "sway", "lean", "arch", "shoulderL", "shoulderR", "elbowL", "elbowR", "jaw", "smile", "frown", "browRaise", 'armLUpperX', 'armLUpperY', 'armLUpperZ', 'armLLowerX', 'armLLowerY', 'armLLowerZ', 'armRUpperX', 'armRUpperY', 'armRUpperZ', 'armRLowerX', 'armRLowerY', 'armRLowerZ', 'eyeBlinkLeft', 'eyeBlinkRight', 'eyeTracking', 'armLConfidence', 'armRConfidence'):
            if name not in data["pose"]:
                continue
            value = data["pose"][name]
            if type(value) not in (int, float) or not math.isfinite(value) or abs(value) > (1 if name in ("jaw", "smile", "frown", "browRaise", 'armLUpperX', 'armLUpperY', 'armLUpperZ', 'armLLowerX', 'armLLowerY', 'armLLowerZ', 'armRUpperX', 'armRUpperY', 'armRUpperZ', 'armRLowerX', 'armRLowerY', 'armRLowerZ', 'eyeBlinkLeft', 'eyeBlinkRight', 'eyeTracking', 'armLConfidence', 'armRConfidence') else 90):
                return None
            pose[name] = value
        return {"type": "pose", "pose": pose}
    return None

clients = set()
performer_ws = None

concert_state = {
    "performerOnline": False,
    "liveShowActive": False,
    "currentShowTitle": "Live Studio Session",
    "showStartTime": 0.0,
    "visitorsCount": 0,
    "visitors": 0,
}

# Active recording accumulator when performer is broadcasting a Live Show
current_recording = None


def seed_initial_archives():
    """Create two rich pre-recorded concert sessions if archives/ is empty."""
    existing = [f for f in os.listdir(ARCHIVE_DIR) if f.endswith(".json")]
    if existing:
        return

    # 1. Nocturne in C Minor (Two-handed lyrical concert piece with expressive body pose)
    events_1 = []
    bpm = 88.0
    sec_per_beat = 60.0 / bpm
    score_1 = [
        (0.0,  [(36, 0.78, 1.8), (48, 0.72, 0.9), (67, 0.85, 0.9)]),
        (0.5,  [(55, 0.65, 0.45)]),
        (1.0,  [(60, 0.68, 0.8), (72, 0.88, 0.95)]),
        (1.5,  [(55, 0.62, 0.45)]),
        (2.0,  [(43, 0.74, 1.8), (63, 0.75, 0.9), (75, 0.92, 0.95)]),
        (2.5,  [(55, 0.64, 0.45)]),
        (3.0,  [(74, 0.82, 0.45)]),
        (3.5,  [(72, 0.78, 0.45)]),
        (4.0,  [(29, 0.82, 1.9), (41, 0.76, 1.0), (68, 0.88, 0.95), (77, 0.90, 0.95)]),
        (4.5,  [(53, 0.66, 0.45)]),
        (5.0,  [(56, 0.70, 0.8), (75, 0.84, 0.45)]),
        (5.5,  [(72, 0.80, 0.45)]),
        (6.0,  [(31, 0.84, 1.9), (43, 0.78, 1.0), (62, 0.76, 0.9), (71, 0.86, 0.9), (79, 0.92, 0.95)]),
        (6.5,  [(55, 0.68, 0.45)]),
        (7.0,  [(77, 0.82, 0.45)]),
        (7.5,  [(74, 0.78, 0.45)]),
        (8.0,  [(24, 0.88, 1.9), (36, 0.84, 1.9), (60, 0.82, 0.45), (72, 0.90, 0.45)]),
        (8.5,  [(48, 0.72, 0.45), (75, 0.86, 0.45)]),
        (9.0,  [(55, 0.74, 0.45), (79, 0.90, 0.45)]),
        (9.5,  [(63, 0.76, 0.45), (84, 0.94, 0.65)]),
        (10.0, [(39, 0.80, 1.8), (51, 0.76, 1.8), (82, 0.88, 0.45)]),
        (10.5, [(79, 0.84, 0.45)]),
        (11.0, [(75, 0.82, 0.45)]),
        (11.5, [(70, 0.78, 0.45)]),
        (12.0, [(32, 0.85, 1.8), (44, 0.80, 1.8), (63, 0.84, 0.9), (68, 0.86, 0.9), (75, 0.90, 0.9)]),
        (13.0, [(31, 0.82, 0.9), (55, 0.76, 0.9), (67, 0.84, 0.9), (74, 0.88, 0.9)]),
        (14.0, [(24, 0.92, 2.2), (36, 0.88, 2.2), (48, 0.84, 2.2), (60, 0.86, 2.2), (67, 0.88, 2.2), (72, 0.94, 2.2)]),
    ]

    # Repeat for 2 expressive variations (32 beats total, with lead-in time so look-ahead shows initial hand approach)
    lead_in_ms = 1400
    note_count = 0
    for loop_idx in range(2):
        beat_offset = loop_idx * 16.0
        for beat, notes in score_1:
            t_on = int(lead_in_ms + (beat_offset + beat) * sec_per_beat * 1000)
            for m, v, d in notes:
                note_count += 1
                t_off = int(t_on + d * sec_per_beat * 1000)
                events_1.append({"t": t_on, "type": "midi", "action": "noteOn", "midi": m, "velocity": v})
                events_1.append({"t": t_off, "type": "midi", "action": "noteOff", "midi": m})

    total_ms_1 = int(lead_in_ms + 32.5 * sec_per_beat * 1000)
    # Add 15 Hz webcam pose track
    for t_ms in range(0, total_ms_1, 66):
        sec = t_ms / 1000.0
        events_1.append({
            "t": t_ms,
            "type": "pose",
            "pose": {
                "yaw": round(math.sin(sec * 0.75) * 14.0 - math.cos(sec * 0.35) * 6.0, 2),
                "pitch": round(6.0 + math.sin(sec * 1.3) * 4.5, 2),
                "roll": round(math.sin(sec * 0.55) * 3.5, 2),
                "sway": round(math.sin(sec * 0.65) * 6.5, 2),
                "lean": round(4.5 + math.sin(sec * 1.1) * 3.2, 2),
                "jaw": round(max(0.0, math.sin(sec * 0.9 - 0.4) * 0.12), 3),
            }
        })
    events_1.sort(key=lambda e: e["t"])

    session_1 = {
        "id": "session_nocturne_c_minor",
        "title": "Nocturne & Virtuoso Etude in C Minor",
        "performer": PERFORMER_NAME,
        "createdAt": "2026-10-12 09:30",
        "durationMs": total_ms_1,
        "noteCount": note_count,
        "hasAudio": False,
        "events": events_1,
    }
    with open(os.path.join(ARCHIVE_DIR, "session_nocturne_c_minor.json"), "w") as f:
        json.dump(session_1, f)

    # 2. Prelude Arpeggios Across 88 Keys
    events_2 = []
    chords = [
        (36, 48, 55, 60, 64, 67, 72, 76),  # C Maj wide
        (38, 50, 57, 60, 66, 69, 72, 78),  # D7
        (31, 43, 55, 59, 62, 67, 71, 79),  # G Maj
        (33, 45, 52, 60, 64, 69, 72, 81),  # A Min
        (29, 41, 53, 57, 60, 65, 69, 84),  # F Maj high reach
        (31, 43, 53, 59, 62, 67, 74, 86),  # G7 high reach
        (24, 36, 48, 55, 60, 64, 72, 84),  # C Maj finale
    ]
    t_cursor = 1400
    step_ms = 240
    n_count_2 = 0
    for ch in chords:
        # Upward and downward sweep across the keyboard
        seq = list(ch) + list(reversed(ch[1:-1]))
        for midi_note in seq:
            n_count_2 += 1
            events_2.append({"t": t_cursor, "type": "midi", "action": "noteOn", "midi": midi_note, "velocity": 0.84})
            events_2.append({"t": t_cursor + int(step_ms * 1.4), "type": "midi", "action": "noteOff", "midi": midi_note})
            t_cursor += step_ms

    total_ms_2 = t_cursor + 1200
    for t_ms in range(0, total_ms_2, 66):
        sec = t_ms / 1000.0
        events_2.append({
            "t": t_ms,
            "type": "pose",
            "pose": {
                "yaw": round(math.sin(sec * 1.1) * 18.0, 2),
                "pitch": round(7.0 + math.cos(sec * 1.5) * 4.0, 2),
                "roll": round(math.sin(sec * 0.8) * 3.0, 2),
                "sway": round(-math.sin(sec * 1.1) * 7.5, 2),
                "lean": round(5.0 + math.sin(sec * 1.4) * 3.0, 2),
                "jaw": 0.0,
            }
        })
    events_2.sort(key=lambda e: e["t"])

    session_2 = {
        "id": "session_grand_arpeggios",
        "title": "Grand 88-Key Sweeping Arpeggios",
        "performer": PERFORMER_NAME,
        "createdAt": "2026-10-12 09:45",
        "durationMs": total_ms_2,
        "noteCount": n_count_2,
        "hasAudio": False,
        "events": events_2,
    }
    with open(os.path.join(ARCHIVE_DIR, "session_grand_arpeggios.json"), "w") as f:
        json.dump(session_2, f)


def list_archive_summaries(all_items=False):
    summaries = []
    for fname in os.listdir(ARCHIVE_DIR):
        if not fname.endswith(".json") or fname.startswith("."):
            continue
        fpath = os.path.join(ARCHIVE_DIR, fname)
        try:
            with open(fpath, "r") as f:
                data = json.load(f)
            summaries.append({
                "id": data.get("id", fname[:-5]),
                "title": data.get("title", "Recorded Performance"),
                "performer": data.get("performer", PERFORMER_NAME),
                "createdAt": data.get("createdAt", ""),
                "durationMs": data.get("durationMs", 0),
                "noteCount": data.get("noteCount", 0),
                "hasAudio": bool(data.get("hasAudio", False)),
            })
        except Exception:
            pass
    summaries.sort(key=lambda x: x.get("createdAt", ""), reverse=True)
    return archive_manager.decorate(ARCHIVE_DIR, summaries, all_items)


def _ebml_el(el_id_bytes: bytes, payload: bytes) -> bytes:
    import struct
    n = len(payload)
    if n < 0x7F:
        sz = bytes([0x80 | n])
    elif n < 0x3FFF:
        sz = struct.pack(">H", 0x4000 | n)
    else:
        sz = struct.pack(">I", 0x10000000 | n)
    return el_id_bytes + sz + payload


def ensure_valid_webm(raw_bytes: bytes) -> bytes:
    """Ensure saved WebM audio starts with a valid EBML/Segment/Tracks header and 0-based Cluster timestamps."""
    import re
    import struct

    if not raw_bytes:
        return raw_bytes
    if raw_bytes.startswith(b"\x1a\x45\xdf\xa3"):
        return raw_bytes

    first_cluster = raw_bytes.find(b"\x1f\x43\xb6\x75")
    if first_cluster < 0:
        return raw_bytes
    body = raw_bytes[first_cluster:]

    ebml_body = (
        _ebml_el(b"\x42\x86", b"\x01")
        + _ebml_el(b"\x42\xf7", b"\x01")
        + _ebml_el(b"\x42\xf2", b"\x04")
        + _ebml_el(b"\x42\xf3", b"\x08")
        + _ebml_el(b"\x42\x82", b"webm")
        + _ebml_el(b"\x42\x87", b"\x04")
        + _ebml_el(b"\x42\x85", b"\x02")
    )
    ebml_header = _ebml_el(b"\x1a\x45\xdf\xa3", ebml_body)
    seg_header = b"\x18\x53\x80\x67\x01\xff\xff\xff\xff\xff\xff\xff"
    info_body = (
        _ebml_el(b"\x2a\xd7\xb1", struct.pack(">I", 1000000))
        + _ebml_el(b"\x4d\x80", b"Chrome")
        + _ebml_el(b"\x57\x41", b"Chrome")
    )
    info_el = _ebml_el(b"\x15\x49\xa9\x66", info_body)
    opus_head = struct.pack("<8sBBHIhB", b"OpusHead", 1, 2, 312, 48000, 0, 0)
    audio_settings = (
        _ebml_el(b"\xb5", struct.pack(">f", 48000.0))
        + _ebml_el(b"\x9f", b"\x02")
        + _ebml_el(b"\x62\x64", b"\x10")
    )
    track_entry = (
        _ebml_el(b"\xd7", b"\x01")
        + _ebml_el(b"\x73\xc5", b"\x01")
        + _ebml_el(b"\x83", b"\x02")
        + _ebml_el(b"\x86", b"A_OPUS")
        + _ebml_el(b"\x63\xa2", opus_head)
        + _ebml_el(b"\xe1", audio_settings)
    )
    tracks_el = _ebml_el(b"\x16\x54\xae\x6b", _ebml_el(b"\xae", track_entry))

    pat = re.compile(b"\x1f\x43\xb6\x75\x01\xff\xff\xff\xff\xff\xff\xff\xe7")
    out = bytearray()
    pos = 0
    base_tc = None
    for m in pat.finditer(body):
        c_start = m.start()
        out.extend(body[pos:c_start])
        tc_pos = m.end()
        vint_b = body[tc_pos]
        if vint_b & 0x80:
            tc_len = vint_b & 0x7F
            tc_hdr_len = 1
        elif vint_b & 0x40:
            tc_len = ((vint_b & 0x3F) << 8) | body[tc_pos + 1]
            tc_hdr_len = 2
        else:
            tc_len = 0
            tc_hdr_len = 1
        tc_val = int.from_bytes(body[tc_pos + tc_hdr_len : tc_pos + tc_hdr_len + tc_len], "big")
        if base_tc is None:
            base_tc = tc_val
        new_tc = max(0, tc_val - base_tc)
        out.extend(b"\x1f\x43\xb6\x75\x01\xff\xff\xff\xff\xff\xff\xff\xe7\x84" + new_tc.to_bytes(4, "big"))
        pos = tc_pos + tc_hdr_len + tc_len

    out.extend(body[pos:])
    return ebml_header + seg_header + info_el + tracks_el + bytes(out)


def finalize_current_recording():
    global current_recording
    if not current_recording:
        return None
    rec = current_recording
    current_recording = None
    concert_state["liveShowActive"] = False

    events = rec["events"]
    if not events and not rec["audio_chunks"]:
        return None

    duration_ms = max((e.get("t", 0) for e in events), default=0) + 600
    note_count = sum(1 for e in events if e.get("type") == "midi" and e.get("action") == "noteOn")

    raw_audio = b"".join(rec["audio_chunks"])
    has_audio = len(raw_audio) > 0
    session_id = rec["id"]
    if has_audio:
        valid_audio = ensure_valid_webm(raw_audio)
        audio_path = os.path.join(ARCHIVE_DIR, f"{session_id}.webm")
        with open(audio_path, "wb") as af:
            af.write(valid_audio)

    session_doc = {
        "id": session_id,
        "title": rec["title"],
        "performer": PERFORMER_NAME,
        "createdAt": rec["createdAt"],
        "durationMs": duration_ms,
        "noteCount": note_count,
        "hasAudio": has_audio,
        "hasRecordedSynth": bool(rec.get("hasRecordedSynth", False)),
        "events": events,
    }
    json_path = os.path.join(ARCHIVE_DIR, f"{session_id}.json")
    with open(json_path, "w") as jf:
        json.dump(session_doc, jf)

    return session_doc


async def broadcast_status():
    concert_state["performerOnline"] = performer_ws is not None and not performer_ws.closed
    if not concert_state["performerOnline"] and concert_state["liveShowActive"]:
        finalize_current_recording()
    concert_state["visitorsCount"] = sum(1 for c in clients if not c.closed and c is not performer_ws)
    concert_state["visitors"] = concert_state["visitorsCount"]
    msg = json.dumps({
        "type": "room_state",
        **concert_state,
        "archives": list_archive_summaries(),
    })
    dead = []
    for ws in list(clients):
        if ws.closed:
            dead.append(ws)
            continue
        try:
            await ws.send_str(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


async def websocket_handler(request):
    global performer_ws, current_recording
    if request.headers.get("Origin") != PUBLIC_ORIGIN or len(clients) >= 200:
        raise web.HTTPForbidden()
    token = request.cookies.get("piano_session", "")
    ws = web.WebSocketResponse(max_msg_size=1024 * 1024, heartbeat=30)
    async def expire_session():
        while not ws.closed:
            await asyncio.sleep(1)
            if performer_ws is ws and not valid_session(token):
                await ws.close(code=1008, message=b"Session expired")
    await ws.prepare(request)
    expiry_task = asyncio.create_task(expire_session())
    clients.add(ws)
    await broadcast_status()

    rate_start = time.monotonic()
    rate_messages = 0
    rate_bytes = 0
    try:
        async for msg in ws:
            if time.monotonic() - rate_start >= 1:
                rate_start = time.monotonic()
                rate_messages = rate_bytes = 0
            rate_messages += 1
            rate_bytes += len(msg.data) if isinstance(msg.data, (str, bytes)) else 0
            if rate_messages > 400 or rate_bytes > 2 * 1024 * 1024:
                await ws.close(code=1008, message=b"Message rate exceeded")
                break
            if msg.type == WSMsgType.TEXT:
                data = msg.data
                try:
                    parsed = json.loads(data)
                except Exception:
                    continue

                if not isinstance(parsed, dict):
                    continue
                mtype = parsed.get("type")
                if mtype in ("set_role", "role"):
                    role = parsed.get("role", "visitor")
                    if role == "performer":
                        if not valid_session(token):
                            await ws.send_json({"type": "auth_error", "error": "Please sign in again"})
                            continue
                        if performer_ws is not None and performer_ws is not ws and not performer_ws.closed:
                            await ws.send_json({"type": "auth_error", "error": "Another performer is already connected"})
                            continue
                        performer_ws = ws
                        await ws.send_json({"type": "role_accepted", "role": "performer"})
                    elif performer_ws is ws:
                        performer_ws = None
                    await broadcast_status()
                    continue

                if performer_ws is not ws or not valid_session(token):
                    await ws.send_json({"type": "auth_error", "error": "Performer authentication required"})
                    continue

                if mtype == "start_show":
                    if current_recording:
                        continue
                    title = str(parsed.get("title") or "")[:200].strip() or "Live Concert Performance"
                    now_ts = time.time()
                    concert_state["liveShowActive"] = True
                    concert_state["currentShowTitle"] = title
                    concert_state["showStartTime"] = now_ts
                    current_recording = {
                        "id": f"session_{int(now_ts)}_{uuid.uuid4().hex[:6]}",
                        "title": title,
                        "startTime": now_ts,
                        "createdAt": datetime.now().strftime("%Y-%m-%d %H:%M"),
                        "hasRecordedSynth": bool(parsed.get("hasRecordedSynth", True)),
                        "events": [],
                        "audio_chunks": [],
                        "byte_count": 0,
                    }
                    await broadcast_status()
                    continue

                elif mtype == "stop_show":
                    saved = finalize_current_recording()
                    await broadcast_status()
                    if saved and not ws.closed:
                        await ws.send_str(json.dumps({
                            "type": "show_saved",
                            "session": {
                                "id": saved["id"],
                                "title": saved["title"],
                                "durationMs": saved["durationMs"],
                                "noteCount": saved["noteCount"],
                            },
                            "archives": list_archive_summaries(),
                        }))
                    continue

                parsed = normalize_event(parsed)
                if parsed is None:
                    continue
                if current_recording is not None:
                    current_recording["byte_count"] += len(data.encode())
                    if current_recording["byte_count"] > MAX_RECORDING:
                        await ws.close(code=1009, message=b"Recording limit reached")
                        break
                # Stamp live midi & pose events with server performance timestamp 't' (ms)
                if mtype in ("midi", "pose"):
                    if current_recording is not None:
                        rel_t = int((time.time() - current_recording["startTime"]) * 1000)
                        parsed["t"] = rel_t
                        current_recording["events"].append(parsed)
                    else:
                        parsed["t"] = int(time.time() * 1000)
                    out_str = json.dumps(parsed)
                else:
                    out_str = data

                for other in list(clients):
                    if other is not ws and not other.closed:
                        try:
                            await other.send_str(out_str)
                        except Exception:
                            pass

            elif msg.type == WSMsgType.BINARY:
                if performer_ws is not ws or not valid_session(token):
                    continue
                if current_recording is not None:
                    current_recording["byte_count"] += len(msg.data)
                    if current_recording["byte_count"] > MAX_RECORDING:
                        await ws.close(code=1009, message=b"Recording limit reached")
                        break
                if current_recording is not None:
                    current_recording["audio_chunks"].append(bytes(msg.data))
                for other in list(clients):
                    if other is not ws and not other.closed:
                        try:
                            await other.send_bytes(msg.data)
                        except Exception:
                            pass
    finally:
        expiry_task.cancel()
        clients.discard(ws)
        if performer_ws is ws:
            performer_ws = None
            if current_recording is not None:
                finalize_current_recording()
        await broadcast_status()

    return ws


def set_session_cookie(response, token, max_age, request):
    response.set_cookie("piano_session", token, max_age=max_age,
                        path="/piano/" if request.path.startswith("/piano/") else "/",
                        httponly=True, samesite="Strict", secure=PUBLIC_ORIGIN.startswith("https:"))


async def api_logout_handler(request):
    if request.headers.get("Origin") != PUBLIC_ORIGIN:
        raise web.HTTPForbidden()
    sessions.pop(request.cookies.get("piano_session", ""), None)
    response = web.json_response({"ok": True})
    set_session_cookie(response, "", 0, request)
    return response


async def api_login_handler(request):
    if request.headers.get("Origin") != PUBLIC_ORIGIN:
        raise web.HTTPForbidden()
    if not PASSWORD_DIGEST:
        return web.json_response({"ok": False, "error": "Backstage is disabled until a password is configured"}, status=503)
    now = time.time()
    for key, entry in list(login_attempts.items()):
        if entry[1] <= now:
            del login_attempts[key]
    for key, limit in ((request.remote or "unknown", 5), ("global", 30)):
        count, expiry = login_attempts.get(key, (0, now + 60))
        if count >= limit:
            return web.json_response({"ok": False, "error": "Too many attempts. Try again in a minute."}, status=429, headers={"Retry-After": "60"})
        login_attempts[key] = (count + 1, expiry)
    try:
        body = await request.json()
    except web.HTTPRequestEntityTooLarge:
        raise
    except Exception:
        return web.json_response({"ok": False, "error": "Invalid request"}, status=400)
    if not isinstance(body, dict) or not isinstance(body.get("password"), str):
        return web.json_response({"ok": False, "error": "Invalid request"}, status=400)
    if not hmac.compare_digest(hashlib.sha256(body["password"].encode()).digest(), PASSWORD_DIGEST):
        return web.json_response({"ok": False, "error": "Invalid performer password"}, status=401)
    for token, expiry in list(sessions.items()):
        if expiry <= now:
            del sessions[token]
    sessions.pop(request.cookies.get("piano_session", ""), None)
    if len(sessions) >= 16:
        del sessions[next(iter(sessions))]
    token = secrets.token_hex(32)
    sessions[token] = now + SESSION_TTL
    response = web.json_response({"ok": True})
    set_session_cookie(response, token, SESSION_TTL, request)
    return response


async def api_admin_handler(request):
    return await archive_manager.handle(request, ARCHIVE_DIR, valid_session(request.cookies.get("piano_session", "")), PUBLIC_ORIGIN, normalize_event, lambda: list_archive_summaries(True))


async def api_archives_handler(request):
    return web.json_response({
        "liveShowActive": concert_state["liveShowActive"],
        "performerOnline": concert_state["performerOnline"],
        "currentShowTitle": concert_state["currentShowTitle"],
        "visitors": concert_state["visitorsCount"],
        "archives": list_archive_summaries(),
    })


async def api_archive_detail_handler(request):
    session_id = request.match_info.get("id", "")
    safe_id = os.path.basename(session_id)
    if not archive_manager.visible(ARCHIVE_DIR, safe_id):
        return web.json_response({"error": "Archive not found"}, status=404)
    fpath = os.path.join(ARCHIVE_DIR, f"{safe_id}.json")
    if not os.path.exists(fpath):
        return web.json_response({"error": "Archive not found"}, status=404)
    with open(fpath, "r") as f:
        data = json.load(f)
    return web.json_response(data)


async def api_archive_audio_handler(request):
    session_id = request.match_info.get("id", "")
    safe_id = os.path.basename(session_id)
    if not archive_manager.visible(ARCHIVE_DIR, safe_id):
        return web.Response(status=404)
    fpath = os.path.join(ARCHIVE_DIR, f"{safe_id}.webm")
    if not os.path.exists(fpath):
        return web.Response(status=404)
    return web.FileResponse(fpath, headers={"Content-Type": "audio/webm"})


async def index_handler(request):
    if request.path == "/piano":
        raise web.HTTPFound("/piano/")
    return web.FileResponse(
        os.path.join(ROOT, "index.html"),
        headers={"Cache-Control": "no-store"},
    )


@web.middleware
async def no_cache_middleware(request, handler):
    resp = await handler(request)
    if not isinstance(resp, web.WebSocketResponse):
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "no-referrer"
        if "/api/" in request.path:
            resp.headers["Cache-Control"] = "no-store"
    if request.path.endswith((".js", ".html", ".json", ".glb")):
        resp.headers["Cache-Control"] = "no-store"
    return resp


def create_app():
    seed_initial_archives()
    app = web.Application(middlewares=[no_cache_middleware], client_max_size=4096)

    # Root & /piano/* routes (works both standalone and behind Cloudflare Tunnel / Nginx / Caddy path routing)
    for prefix in ("", "/piano"):
        app.router.add_get(f"{prefix}/", index_handler)
        if prefix:
            app.router.add_get(prefix, index_handler)
        app.router.add_get(f"{prefix}/ws", websocket_handler)
        app.router.add_post(f"{prefix}/api/login", api_login_handler)
        app.router.add_post(f"{prefix}/api/logout", api_logout_handler)
        app.router.add_get(f"{prefix}/api/archives", api_archives_handler)
        app.router.add_get(f"{prefix}/api/archives/{{id}}", api_archive_detail_handler)
        app.router.add_get(f"{prefix}/api/archives/{{id}}/audio", api_archive_audio_handler)

        app.router.add_route("*", f"{prefix}/api/admin/{{tail:.*}}", api_admin_handler)

        for name in ("archive-admin.html", "archive-admin.js", "performance-motion.js", "replay-timing.js", "stage-direction.js", "fingertip-contact.js", "index.html", "app.js", "concert_stage.glb", "rig_calibration.json"):
            async def asset_handler(request, filename=name):
                return web.FileResponse(os.path.join(ROOT, filename), headers={"Cache-Control": "no-store"})
            app.router.add_get(f"{prefix}/{name}", asset_handler)
    return app


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8765))
    host = os.environ.get("HOST", "0.0.0.0")
    print(f"Starting Live Avatar Concert Server on http://localhost:{port} (public origin {PUBLIC_ORIGIN})")
    print("Backstage enabled" if PASSWORD_DIGEST else "Backstage disabled: configure PERFORMER_PASSWORD_FILE or PERFORMER_PASSWORD")
    web.run_app(create_app(), host=host, port=port)
