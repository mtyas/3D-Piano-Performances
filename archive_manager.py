"""Authenticated archive management; .catalog and .trash are never public assets."""
import base64
import json
import math
import os
import re
import time
import uuid
from pathlib import Path
from datetime import datetime, timezone
from aiohttp import web

ID = re.compile(r'^[a-zA-Z0-9_-]{1,100}$')
LIMIT = 360 * 1024 * 1024

def catalog(directory):
    try:
        return json.loads((Path(directory) / '.catalog.json').read_text())
    except FileNotFoundError:
        return {'hidden': [], 'order': []}

def save(directory, data):
    target = Path(directory) / '.catalog.json'
    tmp = target.with_suffix('.tmp')
    tmp.write_text(json.dumps(data))
    os.replace(tmp, target)

def visible(directory, archive_id):
    return bool(ID.fullmatch(archive_id) and (Path(directory) / (archive_id + '.json')).is_file() and archive_id not in catalog(directory)['hidden'])

def decorate(directory, items, all_items=False):
    c = catalog(directory)
    items = [dict(i, **({'hidden': i['id'] in c['hidden']} if all_items else {})) for i in items if all_items or i['id'] not in c['hidden']]
    items.sort(key=lambda i: i.get('createdAt', ''), reverse=True)
    items.sort(key=lambda i: c['order'].index(i['id']) if i['id'] in c['order'] else 10**9)
    return items

async def handle(request, directory, authorized, origin, validator, list_items):
    def response(data, status=200):
        return web.json_response(data, status=status, headers={'Cache-Control': 'no-store'})
    if not authorized:
        return response({'error': 'Performer login required'}, 401)
    if request.method != 'GET' and request.headers.get('Origin') != origin:
        return response({'error': 'Origin not allowed'}, 403)
    path = request.path[request.path.index('/api/admin/'):]
    body = {}
    if request.method != 'GET':
        limit = LIMIT if path.endswith('/import') else 65536
        data = bytearray()
        async for chunk in request.content.iter_chunked(65536):
            data.extend(chunk)
            if len(data) > limit:
                return response({'error': 'Request too large'}, 413)
        try:
            body = json.loads(data or b'{}')
        except ValueError:
            return response({'error': 'Invalid JSON'}, 400)
    # No awaits in the mutation section: catalog + filesystem updates cannot interleave.
    try:
        directory = Path(directory)
        if request.method == 'GET' and path == '/api/admin/archives':
            return response({'archives': decorate(directory, list_items(), True)})
        if request.method == 'POST' and path.endswith('/import'):
            if body.get('format') != 'piano-archive-v1':
                raise ValueError('Invalid archive package')
            r = body['recording']
            if not isinstance(r.get('events'), list) or len(r['events']) > 1000000:
                raise ValueError('Invalid event list')
            events, last = [], -1
            for event in r['events']:
                t = event.get('t')
                if type(t) not in (float, int) or not math.isfinite(t) or t < last or t < 0 or t > 86400000:
                    raise ValueError('Invalid event timing')
                clean = validator(event)
                if clean is None:
                    raise ValueError('Invalid event')
                clean['t'] = t
                events.append(clean)
                last = t
            audio = base64.b64decode(body['audioBase64'], validate=True) if body.get('audioBase64') else None
            if audio and (len(audio) > 256*1024*1024 or not audio.startswith(b'\x1a\x45\xdf\xa3')):
                raise ValueError('Expected WebM audio')
            if r.get('hasAudio') and not audio:
                raise ValueError('Archive audio is missing')
            archive_id = 'import_' + uuid.uuid4().hex
            created = r.get('createdAt', '')
            try:
                datetime.fromisoformat(created.replace('Z', '+00:00'))
            except (ValueError, AttributeError):
                created = datetime.now(timezone.utc).isoformat()
            duration = r.get('durationMs', 0)
            if type(duration) not in (float, int) or not math.isfinite(duration):
                duration = 0
            doc = {'id': archive_id, 'title': str(r.get('title', 'Imported performance'))[:160], 'performer': str(r.get('performer', os.environ.get('PERFORMER_NAME', 'Pianist')))[:80], 'createdAt': created, 'durationMs': max(last, min(86400000, duration), 0), 'events': events, 'noteCount': sum(e['type']=='midi' and e['action']=='noteOn' for e in events), 'hasAudio': bool(audio), 'hasRecordedSynth': bool(r.get('hasRecordedSynth'))}
            c = catalog(directory); c['hidden'].append(archive_id); save(directory, c)
            if audio:
                (directory / (archive_id + '.webm')).write_bytes(audio)
            (directory / (archive_id + '.json')).write_text(json.dumps(doc))
            return response({'ok': True, 'id': archive_id, 'hidden': True})
        if request.method == 'POST' and path.endswith('/order'):
            ids = [i['id'] for i in list_items()]
            new = body.get('ids')
            if not isinstance(new, list) or len(new) != len(ids) or set(new) != set(ids):
                raise ValueError('Order must contain every archive exactly once')
            c = catalog(directory); c['order'] = new; save(directory, c)
            return response({'ok': True})
        match = re.fullmatch(r'/api/admin/archives/([a-zA-Z0-9_-]{1,100})(/export)?', path)
        if not match or not (directory / (match[1]+'.json')).is_file():
            return response({'error': 'Archive not found'}, 404)
        archive_id = match[1]
        if request.method == 'GET' and match[2]:
            doc = json.loads((directory / (archive_id+'.json')).read_text())
            audio = base64.b64encode((directory / (archive_id+'.webm')).read_bytes()).decode() if doc.get('hasAudio') else None
            result = response({'format': 'piano-archive-v1', 'recording': doc, 'audioBase64': audio})
            result.headers['Content-Disposition'] = f'attachment; filename="{archive_id}.piano.json"'
            return result
        if request.method == 'PATCH' and not match[2]:
            if not isinstance(body, dict) or not any(k in body for k in ('title', 'hidden')):
                raise ValueError('Specify a title or visibility')
            if 'title' in body and (not isinstance(body['title'], str) or not 1 <= len(body['title'].strip()) <= 160):
                raise ValueError('Title must contain 1–160 characters')
            if 'hidden' in body and type(body['hidden']) is not bool:
                raise ValueError('Specify hidden true or false')
            if 'title' in body:
                target = directory / (archive_id+'.json')
                doc = json.loads(target.read_text()); doc['title'] = body['title'].strip()
                temp = target.with_suffix('.rename-tmp'); temp.write_text(json.dumps(doc)); os.replace(temp, target)
            if 'hidden' in body:
                c = catalog(directory); c['hidden'] = [i for i in c['hidden'] if i != archive_id]
                if body['hidden']:
                    c['hidden'].append(archive_id)
                save(directory, c)
            return response({'ok': True})
        if request.method == 'DELETE' and not match[2]:
            c = catalog(directory)
            if archive_id not in c['hidden']:
                c['hidden'].append(archive_id)
            save(directory, c)
            trash = directory / '.trash' / (archive_id+'_'+uuid.uuid4().hex)
            trash.mkdir(parents=True)
            for ext in ('.json', '.webm'):
                source = directory / (archive_id+ext)
                if source.exists():
                    source.rename(trash / source.name)
            c['order'] = [i for i in c['order'] if i != archive_id]
            c['hidden'] = [i for i in c['hidden'] if i != archive_id]
            save(directory, c)
            return response({'ok': True, 'recoverable': True})
        return response({'error': 'Method not allowed'}, 405)
    except (ValueError, KeyError, TypeError) as error:
        return response({'error': str(error)}, 400)
