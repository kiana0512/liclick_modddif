"""AUTODL-DIRECT-REPAINT/1.0.0: one personal, fixed ComfyUI workflow."""
import asyncio
import base64
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import re
import secrets
import time
import threading

from aiohttp import ClientSession, ClientTimeout, web
from PIL import Image

ROOT = Path(os.environ.get('REPAINT_HOME', '/root/li3d-personal-repaint'))
COMFY = 'http://127.0.0.1:6006'
WORKFLOW = 'autodl-li3d-8-2-768-2step-20260921-v1'
FIELDS = {'image': '4', 'materialImage': '5', 'mask': '44', 'normalImage': '81'}
ORIGINS = {'https://li3d.lilithgames.com', 'http://127.0.0.1:4517'}
MAX_BODY = 160 * 1024 * 1024
SAVE_LOCK = threading.Lock()


def decode_inputs(payload):
    images, sizes = {}, {}
    for field in FIELDS:
        value = payload.get(field, {}).get('dataUrl', '')
        if not isinstance(value, str) or not re.fullmatch(r'data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+', value):
            raise ValueError('四张输入图必须是有效的 PNG/JPEG/WebP 图片。')
        raw = base64.b64decode(value.split(',', 1)[1], validate=True)
        with Image.open(io.BytesIO(raw)) as image:
            if image.width > 8192 or image.height > 8192 or image.width * image.height > 16_777_216:
                raise ValueError('输入图超过尺寸上限。')
            image.load()
            sizes[field] = image.size
            if field == 'mask' and image.convert('RGB').getchannel('R').getextrema()[1] == 0:
                raise ValueError('蒙版红通道为空。')
        images[field] = raw
    if any(sizes[x] != sizes['image'] for x in ['mask', 'normalImage']):
        raise ValueError('效果图、蒙版、法线图尺寸必须一致。')
    return images, sizes['image']


def save_job(job):
    with SAVE_LOCK:
        folder = ROOT / 'jobs' / job['id']
        folder.mkdir(parents=True, exist_ok=True)
        temporary = folder / 'job.json.tmp'
        temporary.write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
        temporary.replace(folder / 'job.json')


def public_job(job):
    return {k: job[k] for k in ['id', 'status', 'workflow', 'error', 'timings', 'materialCacheId'] if k in job}


@web.middleware
async def guard(request, handler):
    origin = request.headers.get('Origin')
    headers = {'Cache-Control': 'no-store', 'Vary': 'Origin'}
    if origin and origin not in ORIGINS:
        return web.json_response({'error': 'Origin not allowed'}, status=403, headers=headers)
    if origin:
        headers.update({'Access-Control-Allow-Origin': origin,
                        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
                        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Content-Encoding'})
    if request.method == 'OPTIONS':
        return web.Response(status=204, headers=headers)
    supplied = request.headers.get('Authorization', '').removeprefix('Bearer ')
    if not hmac.compare_digest(hashlib.sha256(supplied.encode()).hexdigest(), request.app['config']['code_sha256']):
        return web.json_response({'error': '个人访问码无效。'}, status=401, headers=headers)
    try:
        response = await handler(request)
    except web.HTTPException as exc:
        response = web.json_response({'error': exc.reason}, status=exc.status)
    except (ValueError, KeyError, TypeError, AttributeError, Image.UnidentifiedImageError):
        response = web.json_response({'error': '请求参数或图片无效。'}, status=422)
    response.headers.update(headers)
    return response


async def comfy(app, path, **kwargs):
    async with app['http'].request(kwargs.pop('method', 'GET'), COMFY + path, **kwargs) as response:
        if response.status != 200:
            raise RuntimeError('ComfyUI 请求失败：' + str(response.status))
        return await response.json()


async def health(request):
    await comfy(request.app, '/system_stats')
    return web.json_response({'ready': True, 'workflow': WORKFLOW})


async def submit(request):
    accepted_at = time.perf_counter()
    payload = await request.json()
    body_read_at = time.perf_counter()
    client_id = payload.get('clientGenerationId', '')
    if not isinstance(client_id, str) or not 1 <= len(client_id) <= 256:
        raise web.HTTPBadRequest(reason='缺少有效任务 ID。')
    if payload.get('promptPolishEnabled'):
        raise web.HTTPBadRequest(reason='个人模式使用云端工作流内置提示词。')
    reference = payload.get('materialImage', {})
    cache_id = reference.get('cacheId')
    if cache_id is not None:
        if not isinstance(cache_id, str) or not re.fullmatch('[a-f0-9]{64}', cache_id) or 'dataUrl' in reference:
            raise ValueError('Invalid reference cache ID')
        cached = ROOT / 'references' / (cache_id + '.txt')
        try:
            value = await asyncio.to_thread(cached.read_text, encoding='utf-8')
        except FileNotFoundError:
            raise web.HTTPPreconditionRequired(reason='reference_cache_miss')
        if hashlib.sha256(value.encode()).hexdigest() != cache_id:
            raise web.HTTPPreconditionRequired(reason='reference_cache_miss')
        payload['materialImage'] = {k: v for k, v in reference.items() if k != 'cacheId'}
        payload['materialImage']['dataUrl'] = value
    # Only the four image bytes affect a fixed-workflow request's identity.
    identity = {field: payload.get(field) for field in FIELDS}
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    job_id = hashlib.sha256(client_id.encode()).hexdigest()
    async with request.app['lock']:
        existing = request.app['jobs'].get(job_id)
        if existing:
            if existing['digest'] != digest:
                raise web.HTTPConflict(reason='同一任务 ID 的输入已经改变。')
            return web.json_response(public_job(existing))
        if sum(j['status'] in ('queued', 'running') for j in request.app['jobs'].values()) >= 4:
            raise web.HTTPTooManyRequests(reason='个人队列已满，请稍后再试。')
        images, size = await asyncio.to_thread(decode_inputs, payload)
        reference_value = payload['materialImage']['dataUrl']
        cache_id = hashlib.sha256(reference_value.encode()).hexdigest()
        cache_dir = ROOT / 'references'
        cache_dir.mkdir(exist_ok=True)
        cache_path = cache_dir / (cache_id + '.txt')
        if 'cacheId' not in reference or not cache_path.exists():
            temporary = cache_path.with_suffix('.tmp')
            await asyncio.to_thread(temporary.write_text, reference_value, encoding='utf-8')
            temporary.replace(cache_path)
        job = {'id': job_id, 'digest': digest, 'size': list(size), 'status': 'queued', 'workflow': WORKFLOW,
               'materialCacheId': cache_id,
               'timings': {'bodyReadMs': (body_read_at - accepted_at) * 1000}}
        await asyncio.to_thread(save_job, job)
        for field, raw in images.items():
            await asyncio.to_thread((ROOT / 'jobs' / job_id / (field + '.png')).write_bytes, raw)
        job['timings']['validateAndStoreMs'] = (time.perf_counter() - body_read_at) * 1000
        job['timings']['acceptMs'] = (time.perf_counter() - accepted_at) * 1000
        job['queued_at'] = time.perf_counter()
        await asyncio.to_thread(save_job, job)
        request.app['jobs'][job_id] = job
        await request.app['queue'].put(job_id)
    return web.json_response(public_job(job), status=202)


def get_job(request):
    job = request.app['jobs'].get(request.match_info['id'])
    if job is None:
        raise web.HTTPNotFound()
    return job


async def status(request):
    return web.json_response(public_job(get_job(request)))


async def cancel(request):
    job = get_job(request)
    if job['status'] in ('queued', 'running'):
        job['status'] = 'cancelled'
        await asyncio.to_thread(save_job, job)
    # Do not use ComfyUI's global interrupt: the owner may be running another workflow.
    return web.json_response(public_job(job))


async def result(request):
    job = get_job(request)
    if job['status'] != 'succeeded':
        raise web.HTTPConflict(reason='结果尚未就绪。')
    raw = await asyncio.to_thread((ROOT / 'jobs' / job['id'] / 'result.png').read_bytes)
    return web.Response(body=raw, content_type='image/png')


async def run_job(app, job):
    started_at = time.perf_counter()
    timing = job.setdefault('timings', {})
    timing['serviceQueueMs'] = (started_at - job.get('queued_at', started_at)) * 1000
    prompt = json.loads((ROOT / 'workflow.json').read_text(encoding='utf-8'))
    from aiohttp import FormData
    for field, node in FIELDS.items():
        data = FormData()
        raw = await asyncio.to_thread((ROOT / 'jobs' / job['id'] / (field + '.png')).read_bytes)
        data.add_field('image', raw, filename=job['id'] + '-' + field + '.png', content_type='application/octet-stream')
        uploaded = await comfy(app, '/upload/image', method='POST', data=data)
        prompt[node]['inputs']['image'] = (uploaded.get('subfolder', '') + '/' + uploaded['name']).lstrip('/')
    prompt['14']['inputs']['noise_seed'] = secrets.randbits(48)
    timing['comfyInputUploadMs'] = (time.perf_counter() - started_at) * 1000
    if job['status'] == 'cancelled':
        return
    # Persist intent before POST. On ambiguous failure this job fails; it is never replayed.
    await asyncio.to_thread(save_job, job)
    submitted_at = time.time() * 1000
    submit_clock = time.perf_counter()
    submitted = await comfy(app, '/prompt', method='POST', json={'prompt': prompt, 'client_id': 'li3d-personal-' + job['id']})
    timing['comfySubmitMs'] = (time.perf_counter() - submit_clock) * 1000
    job['prompt_id'] = submitted['prompt_id']
    await asyncio.to_thread(save_job, job)
    deadline = time.monotonic() + 2700
    while time.monotonic() < deadline:
        history = await comfy(app, '/history/' + job['prompt_id'])
        record = history.get(job['prompt_id'])
        if record:
            events = {name: info.get('timestamp') for name, info in record.get('status', {}).get('messages', [])}
            execution_start, execution_end = events.get('execution_start'), events.get('execution_success')
            if execution_start is not None and execution_end is not None:
                timing['executionMs'] = execution_end - execution_start
                # Both timestamps originate on this host. Queue includes prompt HTTP submission.
                timing['comfySubmitAndQueueMs'] = max(0, execution_start - submitted_at)
                timing['completionDetectionMs'] = max(0, time.time() * 1000 - execution_end)
            if record.get('status', {}).get('status_str') == 'error':
                raise RuntimeError('ComfyUI 工作流执行失败，请检查云端日志。')
            images = record.get('outputs', {}).get('29', {}).get('images', [])
            if not images:
                raise RuntimeError('ComfyUI 未返回节点 29 的结果。')
            if job['status'] == 'cancelled':
                return
            params = {k: images[0][k] for k in ('filename', 'subfolder', 'type')}
            result_started_at = time.perf_counter()
            async with app['http'].get(COMFY + '/view', params=params) as response:
                response.raise_for_status()
                raw = await response.read()
            timing['comfyResultReadMs'] = (time.perf_counter() - result_started_at) * 1000
            validate_started_at = time.perf_counter()
            with Image.open(io.BytesIO(raw)) as image:
                image.load()
                if image.format != 'PNG' or list(image.size) != job['size']:
                    raise RuntimeError('输出格式或尺寸与输入不一致，未发布结果。')
            await asyncio.to_thread((ROOT / 'jobs' / job['id'] / 'result.png').write_bytes, raw)
            timing['resultValidateAndStoreMs'] = (time.perf_counter() - validate_started_at) * 1000
            timing['workerTotalMs'] = (time.perf_counter() - started_at) * 1000
            if job['status'] != 'cancelled':
                job['status'] = 'succeeded'
            return
        if job['status'] == 'queued':
            queue = await comfy(app, '/queue')
            if any(item[1] == job['prompt_id'] for item in queue.get('queue_running', [])) and job['status'] != 'cancelled':
                job['status'] = 'running'
                await asyncio.to_thread(save_job, job)
        await asyncio.sleep(1.5)
    raise RuntimeError('云端任务超时；未自动重新提交。')


async def worker(app):
    while True:
        job = app['jobs'][await app['queue'].get()]
        try:
            if job['status'] != 'cancelled':
                await run_job(app, job)
        except Exception as exc:
            if job['status'] != 'cancelled':
                job.update(status='failed', error=str(exc))
        finally:
            await asyncio.to_thread(save_job, job)
            app['queue'].task_done()


async def lifespan(app):
    app['http'] = ClientSession(timeout=ClientTimeout(total=60))
    task = asyncio.create_task(worker(app))
    yield
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    await app['http'].close()


def create_app():
    app = web.Application(middlewares=[guard], client_max_size=MAX_BODY)
    app['config'] = json.loads((ROOT / 'config.json').read_text())
    app['jobs'], app['queue'], app['lock'] = {}, asyncio.Queue(), asyncio.Lock()
    for path in (ROOT / 'jobs').glob('*/job.json'):
        job = json.loads(path.read_text())
        if job['status'] in ('queued', 'running'):
            job.update(status='failed', error='服务已重启，任务状态未知；未自动重新提交。')
            save_job(job)
        app['jobs'][job['id']] = job
    app.router.add_get('/health', health)
    app.router.add_post('/jobs', submit)
    app.router.add_get('/jobs/{id}', status)
    app.router.add_delete('/jobs/{id}', cancel)
    app.router.add_get('/jobs/{id}/result', result)
    app.cleanup_ctx.append(lifespan)
    return app


if __name__ == '__main__':
    web.run_app(create_app(), host='0.0.0.0', port=6008, access_log=None)
