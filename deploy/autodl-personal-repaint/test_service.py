import asyncio
import base64
import hashlib
import gzip
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

spec = importlib.util.spec_from_file_location('service', Path(__file__).with_name('service.py'))
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


def png(size=(16, 16), color='white'):
    buffer = io.BytesIO()
    Image.new('RGB', size, color).save(buffer, format='PNG')
    return {'dataUrl': 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()}


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        service.ROOT = Path(self.temp.name)
        (service.ROOT / 'config.json').write_text(json.dumps({'code_sha256': hashlib.sha256(b'test-code').hexdigest()}))
        self.app = service.create_app()
        self.app.cleanup_ctx.clear()  # Test HTTP validation without touching a real GPU.
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        self.headers = {'Authorization': 'Bearer test-code', 'Origin': 'https://li3d.lilithgames.com'}
        self.payload = {'clientGenerationId': 'client-one', **{k: png() for k in service.FIELDS}}

    async def asyncTearDown(self):
        await self.client.close()
        self.temp.cleanup()

    async def test_waiting_for_comfy_is_queued_until_own_prompt_runs(self):
        response = await self.client.post('/jobs', json=self.payload, headers=self.headers)
        job = self.app['jobs'][(await response.json())['id']]
        (service.ROOT / 'workflow.json').write_text(json.dumps({node: {'inputs': {}} for node in [*service.FIELDS.values(), '14']}))
        observed = []
        async def fake_comfy(app, path, **kwargs):
            if path == '/upload/image': return {'name': 'test.png'}
            if path == '/prompt': return {'prompt_id': 'own-prompt'}
            if path.startswith('/history/'):
                observed.append(job['status'])
                if len(observed) == 3: raise asyncio.CancelledError()
                return {}
            if path == '/queue':
                return {'queue_running': [[0, 'other-prompt' if len(observed) == 1 else 'own-prompt']],
                        'queue_pending': [[1, 'own-prompt']] if len(observed) == 1 else []}
            raise AssertionError(path)
        async def no_sleep(_): pass
        with patch.object(service, 'comfy', fake_comfy), patch.object(service.asyncio, 'sleep', no_sleep):
            with self.assertRaises(asyncio.CancelledError): await service.run_job(self.app, job)
        self.assertEqual(observed, ['queued', 'queued', 'running'])

    async def test_auth_cors_and_arbitrary_routes(self):
        response = await self.client.post('/jobs', json=self.payload)
        self.assertEqual(response.status, 401)
        response = await self.client.options('/jobs', headers={'Origin': 'https://li3d.lilithgames.com'})
        self.assertEqual(response.status, 204)
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], 'https://li3d.lilithgames.com')
        response = await self.client.post('/jobs', json=self.payload, headers={**self.headers, 'Origin': 'https://evil.example'})
        self.assertEqual(response.status, 403)
        response = await self.client.post('/prompt', json={'prompt': {}}, headers=self.headers)
        self.assertEqual(response.status, 404)
        self.assertEqual(self.app['queue'].qsize(), 0)

    async def test_exact_replay_conflict_and_cancellation(self):
        first, replay = await asyncio.gather(*[self.client.post('/jobs', json=self.payload, headers=self.headers) for _ in range(2)])
        job = await first.json()
        self.assertEqual((await replay.json())['id'], job['id'])
        self.assertEqual(self.app['queue'].qsize(), 1)
        changed = {**self.payload, 'image': png(color='red')}
        self.assertEqual((await self.client.post('/jobs', json=changed, headers=self.headers)).status, 409)
        self.assertEqual((await self.client.get('/jobs/' + job['id'] + '/result', headers=self.headers)).status, 409)
        response = await self.client.delete('/jobs/' + job['id'], headers=self.headers)
        self.assertEqual((await response.json())['status'], 'cancelled')
        self.assertEqual((await self.client.get('/jobs/unknown', headers=self.headers)).status, 404)
        self.assertEqual(service.create_app()['jobs'][job['id']]['status'], 'cancelled')

    async def test_invalid_inputs_never_queue(self):
        variants = [
            {**self.payload, 'mask': png(color='black')},
            {**self.payload, 'normalImage': png(size=(8, 8))},
            {**self.payload, 'image': {'dataUrl': 'http://127.0.0.1/private'}},
            {**self.payload, 'mask': {'dataUrl': 'data:image/png;base64,aGVsbG8='}},
        ]
        for value in variants:
            self.assertEqual((await self.client.post('/jobs', json=value, headers=self.headers)).status, 422)
        self.assertEqual(self.app['queue'].qsize(), 0)

    async def test_restart_does_not_replay_gpu(self):
        job = await (await self.client.post('/jobs', json=self.payload, headers=self.headers)).json()
        restarted = service.create_app()
        self.assertEqual(restarted['jobs'][job['id']]['status'], 'failed')
        self.assertEqual(restarted['queue'].qsize(), 0)

    async def test_timings_are_public_and_persisted_without_secrets(self):
        job = await (await self.client.post('/jobs', json=self.payload, headers=self.headers)).json()
        self.assertGreaterEqual(job['timings']['acceptMs'], 0)
        self.assertGreaterEqual(job['timings']['validateAndStoreMs'], 0)
        self.assertNotIn('digest', job)
        saved = json.loads((service.ROOT / 'jobs' / job['id'] / 'job.json').read_text())
        self.assertEqual(saved['timings'], job['timings'])

    async def test_gzip_and_cached_reference_preserve_bytes_and_replay(self):
        headers = {**self.headers, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip'}
        response = await self.client.post('/jobs', data=gzip.compress(json.dumps(self.payload).encode()), headers=headers)
        self.assertEqual(response.status, 202)
        job = await response.json()
        cache_id = job['materialCacheId']
        cached = {**self.payload, 'materialImage': {'cacheId': cache_id}}
        replay = await self.client.post('/jobs', json=cached, headers=self.headers)
        self.assertEqual(replay.status, 200)
        self.assertEqual(self.app['queue'].qsize(), 1)
        cached['clientGenerationId'] = 'client-two'
        next_job = await (await self.client.post('/jobs', json=cached, headers=self.headers)).json()
        actual = (service.ROOT / 'jobs' / next_job['id'] / 'materialImage.png').read_bytes()
        self.assertEqual(actual, base64.b64decode(self.payload['materialImage']['dataUrl'].split(',')[1]))
        (service.ROOT / 'references' / (cache_id + '.txt')).unlink()
        cached['clientGenerationId'] = 'client-three'
        self.assertEqual((await self.client.post('/jobs', json=cached, headers=self.headers)).status, 428)
        self.assertEqual(self.app['queue'].qsize(), 2, 'Cache miss must be rejected before queuing')
        cached['materialImage'] = {'cacheId': '../config'}
        self.assertEqual((await self.client.post('/jobs', json=cached, headers=self.headers)).status, 422)
        preflight = await self.client.options('/jobs', headers=self.headers)
        self.assertIn('Content-Encoding', preflight.headers['Access-Control-Allow-Headers'])

    async def test_gzip_decompressed_size_limit(self):
        self.app._client_max_size = 1024
        response = await self.client.post('/jobs', data=gzip.compress(b' ' * 4096),
            headers={**self.headers, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip'})
        self.assertEqual(response.status, 413)
        self.assertEqual(self.app['queue'].qsize(), 0)

    async def test_corrupt_cache_rejected_and_full_upload_repairs_it(self):
        job = await (await self.client.post('/jobs', json=self.payload, headers=self.headers)).json()
        cached_file = service.ROOT / 'references' / (job['materialCacheId'] + '.txt')
        cached_file.write_text('damaged', encoding='utf-8')
        payload = {**self.payload, 'clientGenerationId': 'repair', 'materialImage': {'cacheId': job['materialCacheId']}}
        self.assertEqual((await self.client.post('/jobs', json=payload, headers=self.headers)).status, 428)
        self.assertEqual(self.app['queue'].qsize(), 1)
        payload['materialImage'] = self.payload['materialImage']
        self.assertEqual((await self.client.post('/jobs', json=payload, headers=self.headers)).status, 202)
        self.assertEqual(cached_file.read_text(encoding='utf-8'), self.payload['materialImage']['dataUrl'])


if __name__ == '__main__':
    unittest.main()
