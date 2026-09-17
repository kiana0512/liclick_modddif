import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { corsHeaders, readBinaryBody, sendJson } from './httpUtils.js';
import { resolveBlenderExecutable, runProcess } from '../services/retopologyProjectPreparationService.js';
import { importUvRepairScript } from '../services/importUvRepairScript.js';

let active = false;
const maxBytes = 256 * 1024 * 1024;

export function validateRepairGlb(data: Buffer) {
  if (data.length < 20 || data.toString('ascii', 0, 4) !== 'glTF' || data.readUInt32LE(4) !== 2 ||
      data.readUInt32LE(8) !== data.length || data.readUInt32LE(16) !== 0x4e4f534a ||
      data.readUInt32LE(12) > data.length - 20) throw new Error('修复输入必须是完整 GLB 模型');
  const model = JSON.parse(data.toString('utf8', 20, 20 + data.readUInt32LE(12)));
  for (const asset of [...(model.buffers ?? []), ...(model.images ?? [])]) {
    if (asset.uri && !asset.uri.startsWith('data:')) throw new Error('修复模型必须内嵌所有资源');
  }
  if (model.skins?.length || model.animations?.length || model.meshes?.some((m: { primitives: Array<{ targets?: unknown[] }> }) =>
    m.primitives.some(p => p.targets?.length))) throw new Error('暂不支持自动修复带动画、骨骼或形态键的模型');
}

/** Called only after assetProcessing's authentication and origin gates. */
export async function handleImportUvRepair(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (request.method !== 'POST') { sendJson(response, 405, { error: 'Method not allowed.' }); return; }
  if (url.searchParams.get('consent') !== 'change-uv-v1') {
    sendJson(response, 400, { error: '必须先确认允许修改 UV' }); return;
  }
  if (active) { sendJson(response, 429, { error: 'UV 修复服务忙，请稍后重新导入' }); return; }
  active = true;
  const controller = new AbortController();
  const abort = () => { if (!response.writableEnded) controller.abort(); };
  response.once('close', abort);
  let directory: string | undefined;
  try {
    const blender = await resolveBlenderExecutable();
    const input = await readBinaryBody(request, maxBytes);
    validateRepairGlb(input);
    controller.signal.throwIfAborted();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'li3d-import-uv-'));
    const source = path.join(directory, 'input.glb'), output = path.join(directory, 'repaired.glb');
    const script = path.join(directory, 'repair.py');
    await fs.writeFile(source, input);
    await fs.writeFile(script, importUvRepairScript);
    const result = await runProcess(blender.executablePath, ['--background', '--factory-startup', '--disable-autoexec',
      '--python-exit-code', '1', '--python', script, '--', source, output], {
      cwd: directory, timeoutMs: 180_000, signal: controller.signal,
      environment: { ...process.env, PYTHONNOUSERSITE: '1', OMP_NUM_THREADS: '2' },
    });
    if (result.aborted) return;
    if (result.timedOut) throw new Error('UV 修复超时，模型未导入，请简化模型后重试');
    if (result.code !== 0 || !result.stdout.includes('IMPORT_UV_REPAIR_OK')) {
      throw new Error('Blender 未能修复此模型的 UV，模型未导入；请检查零面积几何或手动展 UV');
    }
    if ((await fs.stat(output)).size > maxBytes) throw new Error('修复后模型过大，未导入');
    const repaired = await fs.readFile(output);
    validateRepairGlb(repaired);
    if (response.destroyed) return;
    response.writeHead(200, { ...corsHeaders(response), 'content-type': 'model/gltf-binary',
      'content-length': repaired.length, 'cache-control': 'no-store' });
    response.end(repaired);
  } catch (error) {
    if (!response.destroyed) sendJson(response, 422, { error: error instanceof Error ? error.message : 'UV 修复失败，未导入模型' });
  } finally {
    response.off('close', abort);
    try { if (directory) await fs.rm(directory, { recursive: true, force: true }); }
    finally { active = false; }
  }
}
