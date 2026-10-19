"""End-to-end HTTP/WebSocket security regressions for the Python stage server.
Run: python -m unittest discover -s tests -v
Requires aiohttp; every recording uses a temporary directory.
"""
import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest

import aiohttp

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'https://stage.example.com'
PASSWORD = 'integration-test-secret-not-for-production'


class SecurityTests(unittest.IsolatedAsyncioTestCase):
    async def start_backend(self, backend, secret=PASSWORD, ttl=43200):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        directory = Path(temp.name)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        env = dict(os.environ, PORT=str(port), PUBLIC_ORIGIN=ORIGIN, PERFORMER_PASSWORD=secret,
                   PERFORMER_PASSWORD_FILE=str(directory / 'missing-secret'),
                   PYTHONPYCACHEPREFIX=str(directory / 'pycache'))
        command = [sys.executable, '-c', f'''import sys
sys.path.insert(0, {str(ROOT)!r})
import server
server.ARCHIVE_DIR = {str(directory / 'archives')!r}
server.SESSION_TTL = {ttl}
import os
os.makedirs(server.ARCHIVE_DIR)
server.web.run_app(server.create_app(), host='127.0.0.1', port={port}, print=None)
''']
        log = open(directory / 'server.log', 'w+')
        self.addCleanup(log.close)
        proc = subprocess.Popen(command, env=env, stdout=log, stderr=log)
        def stop():
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        self.addCleanup(stop)
        client = aiohttp.ClientSession(headers={'Origin': ORIGIN})
        self.addAsyncCleanup(client.close)
        base = f'http://127.0.0.1:{port}/piano'
        for _ in range(100):
            try:
                async with client.get(base + '/api/archives') as response:
                    if response.status == 200:
                        return client, base
            except aiohttp.ClientError:
                pass
            if proc.poll() is not None:
                log.seek(0)
                self.fail(log.read())
            await asyncio.sleep(.03)
        self.fail('Backend did not start')

    async def receive_type(self, ws, kind):
        while True:
            msg = await ws.receive(timeout=4)
            if msg.type != aiohttp.WSMsgType.TEXT:
                self.fail(f'Expected {kind}, received {msg.type}')
            event = json.loads(msg.data)
            if event.get('type') == kind:
                return event

    async def exercise(self, backend):
        client, base = await self.start_backend(backend)
        async with client.post(base + '/api/login', json={'password': PASSWORD}, headers={'Origin': 'https://evil.example'}) as r:
            self.assertEqual(r.status, 403)
        async with client.post(base + '/api/login', json={'password': 'piano2026'}) as r:
            self.assertEqual(r.status, 401)
        async with client.post(base + '/api/login', json={'password': PASSWORD}) as r:
            self.assertEqual(r.status, 200)
            cookie = r.headers['Set-Cookie']
            self.assertIn('HttpOnly', cookie)
            self.assertIn('SameSite=Strict', cookie)
            self.assertIn('Secure', cookie)
            auth = {'Cookie': cookie.split(';')[0]}
        with self.assertRaises(aiohttp.WSServerHandshakeError):
            await client.ws_connect(base + '/ws', headers={'Origin': 'https://evil.example'})
        visitor = await client.ws_connect(base + '/ws')
        self.addAsyncCleanup(visitor.close)
        await visitor.send_json({'type': 'role', 'role': 'performer'})
        await self.receive_type(visitor, 'auth_error')
        await visitor.send_json({'type': 'start_show', 'title': 'Unauthorized'})
        await self.receive_type(visitor, 'auth_error')
        performer = await client.ws_connect(base + '/ws', headers=auth)
        self.addAsyncCleanup(performer.close)
        await performer.send_json({'type': 'role', 'role': 'performer'})
        await self.receive_type(performer, 'role_accepted')
        second = await client.ws_connect(base + '/ws', headers=auth)
        self.addAsyncCleanup(second.close)
        await second.send_json({'type': 'role', 'role': 'performer'})
        await self.receive_type(second, 'auth_error')
        await performer.send_json({'type': 'start_show', 'title': 'Authorized concert'})
        state = await self.receive_type(performer, 'room_state')
        while not state['liveShowActive']:
            state = await self.receive_type(performer, 'room_state')
        await visitor.send_json({'type': 'stop_show'})
        await self.receive_type(visitor, 'auth_error')
        await visitor.send_json({'type': 'midi', 'action': 'noteOn', 'midi': 60, 'velocity': 1})
        await self.receive_type(visitor, 'auth_error')
        await visitor.send_bytes(b'visitor-injected-audio')
        await performer.send_json({'type': 'start_show', 'title': 'Duplicate'})
        await performer.send_json({'type': 'midi', 'action': 'noteOn', 'midi': 60, 'velocity': .8})
        await performer.send_json({'type': 'pose', 'pose': {'lean': 3, 'yaw': 10, 'smile': .7, 'frown': .2, 'browRaise': .4, 'jaw': .3, 'eyeBlinkLeft': .9, 'eyeBlinkRight': .1, 'eyeTracking': 1, 'armLUpperY': .8, 'armLConfidence': .9, 'armRLowerZ': -.6}})
        await performer.send_json({'type': 'midi', 'action': 'noteOn', 'midi': 999, 'velocity': 1})
        await performer.send_json({'type': 'pose', 'pose': {'smile': 2}})
        await performer.send_json({'type': 'pose', 'pose': {'eyeBlinkLeft': 2}})
        await performer.send_json({'type': 'room_state', 'liveShowActive': False})
        await performer.send_bytes(b'performer-audio')
        await performer.send_json({'type': 'stop_show'})
        saved = await self.receive_type(performer, 'show_saved')
        async with client.get(base + '/api/archives/' + saved['session']['id']) as r:
            doc = await r.json()
            self.assertEqual(doc['title'], 'Authorized concert')
            self.assertEqual(doc['noteCount'], 1)
            self.assertEqual([e['type'] for e in doc['events']], ['midi', 'pose'])
            self.assertEqual(doc['events'][1]['pose']['smile'], .7)
            self.assertEqual(doc['events'][1]['pose']['eyeBlinkLeft'], .9)
            self.assertEqual(doc['events'][1]['pose']['eyeBlinkRight'], .1)
            self.assertEqual(doc['events'][1]['pose']['eyeTracking'], 1)
            self.assertEqual(doc['events'][1]['pose']['armLUpperY'], .8)
            self.assertEqual(doc['events'][1]['pose']['armRLowerZ'], -.6)
            self.assertEqual(doc['events'][1]['pose']['frown'], .2)
            self.assertEqual(doc['events'][1]['pose']['browRaise'], .4)
        async with client.get(base + '/api/archives/' + saved['session']['id'] + '/audio') as r:
            self.assertEqual(await r.read(), b'performer-audio')
        async with client.post(base + '/api/logout', headers=auth) as r:
            self.assertEqual(r.status, 200)
        await performer.send_json({'type': 'start_show'})
        await self.receive_type(performer, 'auth_error')
        for path in ['server.py', 'README.md', '.performer-password', 'archive_manager.py', 'archives/', '.git/config']:
            async with client.get(base + '/' + path) as r:
                self.assertEqual(r.status, 404, path)
        async with client.get(base + '/api/archives') as r:
            self.assertFalse((await r.json())['liveShowActive'])
        for _ in range(3):
            async with client.post(base + '/api/login', json={'password': 'wrong'}) as r:
                self.assertEqual(r.status, 401)
        async with client.post(base + '/api/login', json={'password': PASSWORD}) as r:
            self.assertEqual(r.status, 429)

    async def disabled(self, backend):
        client, base = await self.start_backend(backend, secret='')
        async with client.post(base + '/api/login', json={'password': ''}) as r:
            self.assertEqual(r.status, 503)
        async with client.get(base + '/api/archives') as r:
            self.assertEqual(r.status, 200)

    async def expiry(self, backend):
        client, base = await self.start_backend(backend, ttl=1.2)
        async with client.post(base + '/api/login', json={'password': PASSWORD}) as r:
            auth = {'Cookie': r.headers['Set-Cookie'].split(';')[0]}
        performer = await client.ws_connect(base + '/ws', headers=auth)
        self.addAsyncCleanup(performer.close)
        await performer.send_json({'type': 'role', 'role': 'performer'})
        await self.receive_type(performer, 'role_accepted')
        while True:
            msg = await performer.receive(timeout=4)
            if msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED):
                break
        async with client.get(base + '/api/archives') as r:
            self.assertFalse((await r.json())['performerOnline'])

    async def archive_management(self, backend):
        import base64
        client, base = await self.start_backend(backend)
        route = base + '/api/admin/archives'
        async with client.get(route) as r:
            self.assertEqual(r.status, 401)
        async with client.post(base + '/api/login', json={'password': PASSWORD}) as r:
            auth = {'Cookie': r.headers['Set-Cookie'].split(';')[0]}
        package = {'format': 'piano-archive-v1', 'recording': {'title': '<script>test</script>', 'createdAt': '2026-10-13T10:00:00Z', 'durationMs': 1000, 'hasAudio': True, 'events': [{'type': 'midi', 'action': 'noteOn', 'midi': 60, 'velocity': .7, 't': 0}, {'type': 'pose', 'pose': {'smile': .8, 'armLConfidence': .95, 'eyeBlinkLeft': .9, 'eyeBlinkRight': .1, 'eyeTracking': 1, 'armLUpperY': .8}, 't': 10}, {'type': 'midi', 'action': 'noteOff', 'midi': 60, 't': 500}]}, 'audioBase64': base64.b64encode(b'\x1a\x45\xdf\xa3test-audio').decode()}
        async with client.post(route+'/import', json=package, headers={**auth, 'Origin':'https://evil.example'}) as r:
            self.assertEqual(r.status, 403)
        async with client.post(route+'/import', json=package, headers=auth) as r:
            self.assertEqual(r.status, 200, await r.text())
            archive_id = (await r.json())['id']
        async with client.get(base+'/api/archives') as r:
            self.assertNotIn(archive_id, [a['id'] for a in (await r.json())['archives']])
        for suffix in ['', '/audio']:
            async with client.get(base+'/api/archives/'+archive_id+suffix) as r:
                self.assertEqual(r.status, 404)
        async with client.get(route+'/'+archive_id+'/export') as r:
            self.assertEqual(r.status, 401)
        async with client.get(route+'/'+archive_id+'/export', headers=auth) as r:
            exported = await r.json()
            self.assertEqual(exported['audioBase64'], package['audioBase64'])
            self.assertEqual(exported['recording']['events'], package['recording']['events'])
        async with client.patch(route+'/'+archive_id, json={'hidden':False}, headers=auth) as r:
            self.assertEqual(r.status, 200)
        async with client.get(base+'/api/archives/'+archive_id) as r:
            self.assertEqual(r.status, 200)
        async with client.patch(route+'/'+archive_id, json={'title':'  Renamed recital  '}, headers=auth) as r:
            self.assertEqual(r.status, 200)
        async with client.get(base+'/api/archives/'+archive_id) as r:
            renamed = await r.json()
            self.assertEqual(renamed['title'], 'Renamed recital')
            self.assertEqual(renamed['events'], package['recording']['events'])
        async with client.get(route+'/'+archive_id+'/export', headers=auth) as r:
            renamed = await r.json()
            self.assertEqual(renamed['audioBase64'], package['audioBase64'])
            self.assertEqual(renamed['recording']['title'], 'Renamed recital')
        for title in ['', '   ', 123, 'a'*161]:
            async with client.patch(route+'/'+archive_id, json={'title':title}, headers=auth) as r:
                self.assertEqual(r.status, 400)
        async with client.patch(route+'/'+archive_id, json={'title':'unauthorized'}) as r:
            self.assertEqual(r.status, 401)
        async with client.get(route, headers=auth) as r:
            ids = [a['id'] for a in (await r.json())['archives']]
        async with client.post(route+'/order', json={'ids':[archive_id]+list(reversed([i for i in ids if i!=archive_id]))}, headers=auth) as r:
            self.assertEqual(r.status, 200)
        async with client.get(base+'/api/archives') as r:
            self.assertEqual((await r.json())['archives'][0]['id'], archive_id)
        async with client.post(route+'/order', json={'ids':['../escape']}, headers=auth) as r:
            self.assertEqual(r.status, 400)
        bad = json.loads(json.dumps(package)); bad['recording']['events'][0]['midi']=999
        async with client.post(route+'/import', json=bad, headers=auth) as r:
            self.assertEqual(r.status, 400)
        async with client.delete(route+'/'+archive_id, json={}, headers=auth) as r:
            self.assertEqual(r.status, 200)
            self.assertTrue((await r.json())['recoverable'])
        async with client.get(base+'/api/archives/'+archive_id) as r:
            self.assertEqual(r.status, 404)
        async with client.get(route+'/'+archive_id+'/export', headers=auth) as r:
            self.assertEqual(r.status, 404)

    async def test_python_archive_management(self): await self.archive_management('python')

    async def test_python_authorization(self): await self.exercise('python')
    async def test_python_disabled_without_secret(self): await self.disabled('python')
    async def test_python_session_expiry(self): await self.expiry('python')


if __name__ == '__main__':
    unittest.main()
