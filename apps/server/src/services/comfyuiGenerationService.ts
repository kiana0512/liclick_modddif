import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { serverConfig } from '../config.js';
import { saveBinaryAsset } from './assetFileService.js';

type ComfyControlFile = {
  path: string;
  dataUrl: string;
};

export type ComfyTextureMapInput = {
  clientGenerationId?: string;
  projectId?: string;
  prompt: string;
  files: ComfyControlFile[];
  seed?: number;
};

export type ComfyInpaintInput = {
  clientGenerationId?: string;
  projectId?: string;
  prompt: string;
  image: ComfyControlFile;
  seed?: number;
};

type UiNodeInput = {
  name: string;
  type?: string;
  link?: number | null;
};

type UiNode = {
  id: number;
  type: string;
  mode?: number;
  title?: string;
  inputs?: UiNodeInput[];
  widgets_values?: unknown[];
};

type UiWorkflow = {
  nodes: UiNode[];
  links: Array<[number, number, number, number, number, string]>;
};

type ObjectInfo = Record<
  string,
  {
    input?: {
      required?: Record<string, unknown>;
      optional?: Record<string, unknown>;
    };
  }
>;

type ComfyImageOutput = {
  filename: string;
  subfolder?: string;
  type?: string;
};

type ActiveComfyJob = {
  cancelled: boolean;
  promptId?: string;
  baseUrl?: string;
  serviceUrl?: string;
  abort?: () => void;
};

const activeComfyJobs = new Map<string, ActiveComfyJob>();
const cancelledComfyJobIds = new Set<string>();

const comfyNodeIds = {
  whiteRender: 23,
  objectMask: 25,
  depth: 26,
  materialReference: 28,
  normalView: 30,
  normalScale: 70,
  normalControl: 47,
  modelSampling: 50,
  positivePrompt: 44,
  sampler: 51,
  finalAlphaSave: 63,
  finalRgbSave: 64,
};

const requiredInputPaths = {
  [comfyNodeIds.whiteRender]: 'render/01_white_render.png',
  [comfyNodeIds.objectMask]: 'masks/01_object_mask.png',
  [comfyNodeIds.depth]: 'controlnet_ready/control_depth.png',
  [comfyNodeIds.materialReference]: 'material/02_material_reference_cropped.png',
  [comfyNodeIds.normalView]: 'geometry/08_normal_view.png',
} as const;

function dataUrlToBuffer(dataUrl: string) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('Invalid ComfyUI input image data URL.');
  const mime = match[1] || 'image/png';
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? '';
  return {
    mime,
    buffer: isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8'),
  };
}

type InpaintServiceResponse = {
  statusCode: number;
  contentType: string;
  requestId?: string;
  buffer: Buffer;
};

function requestInpaintService(
  method: 'GET' | 'POST',
  options: {
    body?: Buffer;
    headers?: Record<string, string | number>;
    timeoutMs: number;
    onRequest?: (request: ClientRequest) => void;
  },
) {
  const serviceUrl = new URL(serverConfig.comfyuiInpaintServiceUrl);
  if (serviceUrl.protocol !== 'https:') {
    throw new Error(`局部重绘服务必须使用 HTTPS：${serviceUrl.toString()}`);
  }
  return new Promise<InpaintServiceResponse>((resolve, reject) => {
    const request = httpsRequest(
      serviceUrl,
      {
        method,
        headers: options.headers,
        rejectUnauthorized: serverConfig.comfyuiInpaintTlsRejectUnauthorized,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 128 * 1024 * 1024) {
            request.destroy(new Error('局部重绘服务返回内容超过 128 MB。'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          clearTimeout(timeout);
          const requestIdHeader = response.headers['x-request-id'];
          resolve({
            statusCode: response.statusCode ?? 0,
            contentType: String(response.headers['content-type'] ?? ''),
            requestId: Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader,
            buffer: Buffer.concat(chunks),
          });
        });
      },
    );
    const timeout = setTimeout(() => {
      request.destroy(new Error(`局部重绘服务请求超过 ${options.timeoutMs / 1000} 秒。`));
    }, options.timeoutMs);
    request.on('error', (error) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `无法连接局部重绘服务：${serverConfig.comfyuiInpaintServiceUrl}。${
            error instanceof Error ? ` (${error.message})` : ''
          }`,
        ),
      );
    });
    options.onRequest?.(request);
    request.end(options.body);
  });
}

export async function checkComfyInpaintServiceStatus() {
  const response = await requestInpaintService('GET', { timeoutMs: 5000 });
  // The service exposes only POST. A 405 response confirms that HTTPS, routing,
  // and the service process are all reachable without starting an inpaint job.
  if (response.statusCode !== 200 && response.statusCode !== 405) {
    throw new Error(`局部重绘服务状态检查失败：${response.statusCode}`);
  }
  return {
    statusCode: response.statusCode,
    requestId: response.requestId,
  };
}

function createInpaintServiceMultipart(file: ComfyControlFile) {
  const { mime, buffer } = dataUrlToBuffer(file.dataUrl);
  const filename = safeFilename(file.path);
  const boundary = `----li3d-${randomUUID()}`;
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
    'utf8',
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    body: Buffer.concat([prefix, buffer, suffix]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function normalizeRelativePath(value: string) {
  return value.replaceAll('\\', '/').replace(/^\/+/, '');
}

function safeFilename(value: string) {
  const parsed = path.posix.parse(normalizeRelativePath(value));
  const base = parsed.name.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'input';
  const ext = parsed.ext && /^[.a-z0-9]+$/i.test(parsed.ext) ? parsed.ext.toLowerCase() : '.png';
  return `${base}${ext}`;
}

function comfyUrl(
  pathname: string,
  params?: Record<string, string>,
  baseUrl = serverConfig.comfyuiBaseUrl,
) {
  const url = new URL(pathname, `${baseUrl}/`);
  if (params) {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  }
  return url;
}

async function comfyFetch(
  pathname: string,
  init?: RequestInit,
  timeoutMs = 30_000,
  baseUrl = serverConfig.comfyuiBaseUrl,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(comfyUrl(pathname, undefined, baseUrl), {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(
      `ComfyUI 后端未启动或无法连接：${baseUrl}。请先启动 8188 端口的 ComfyUI。${error instanceof Error ? ` (${error.message})` : ''}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkComfyuiStatus(baseUrl = serverConfig.comfyuiBaseUrl) {
  const response = await comfyFetch('/system_stats', { method: 'GET' }, 3000, baseUrl);
  if (!response.ok) throw new Error(`ComfyUI status failed: ${response.status}`);
  return response.json() as Promise<unknown>;
}

async function getObjectInfo(baseUrl = serverConfig.comfyuiBaseUrl) {
  const response = await comfyFetch('/object_info', { method: 'GET' }, 30_000, baseUrl);
  if (!response.ok) throw new Error(`ComfyUI object_info failed: ${response.status}`);
  return response.json() as Promise<ObjectInfo>;
}

async function uploadImage(
  file: ComfyControlFile,
  subfolder: string,
  baseUrl = serverConfig.comfyuiBaseUrl,
) {
  const { mime, buffer } = dataUrlToBuffer(file.dataUrl);
  const filename = safeFilename(file.path);
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(buffer)], { type: mime }), filename);
  form.append('type', 'input');
  form.append('subfolder', subfolder);
  form.append('overwrite', 'true');
  const response = await comfyFetch(
    '/upload/image',
    { method: 'POST', body: form },
    2 * 60 * 1000,
    baseUrl,
  );
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : `ComfyUI upload failed: ${response.status}`;
    throw new Error(message);
  }
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const name = typeof record.name === 'string' ? record.name : filename;
  const returnedSubfolder = typeof record.subfolder === 'string' ? record.subfolder : subfolder;
  return `${returnedSubfolder}/${name}`.replaceAll('\\', '/');
}

async function uploadControlFiles(files: ComfyControlFile[], jobId: string) {
  const byPath = new Map(files.map((file) => [normalizeRelativePath(file.path), file]));
  const subfolder = `li3d_zimage_web3d/${jobId}`;
  const uploaded = new Map<number, string>();
  for (const [nodeIdText, requiredPath] of Object.entries(requiredInputPaths)) {
    const file = byPath.get(requiredPath);
    if (!file) throw new Error(`ComfyUI 控制图缺失：${requiredPath}`);
    uploaded.set(Number(nodeIdText), await uploadImage(file, subfolder));
  }
  return uploaded;
}

function getActiveComfyJob(jobId: string) {
  let job = activeComfyJobs.get(jobId);
  if (!job) {
    job = { cancelled: cancelledComfyJobIds.has(jobId) };
    activeComfyJobs.set(jobId, job);
  }
  return job;
}

function assertComfyJobActive(jobId: string) {
  if (cancelledComfyJobIds.has(jobId) || activeComfyJobs.get(jobId)?.cancelled) {
    throw new Error('ComfyUI 纹理贴图任务已取消。');
  }
}

async function loadWorkflowTemplate() {
  const content = await fs
    .readFile(serverConfig.comfyuiTextureWorkflowPath, 'utf8')
    .catch((error: unknown) => {
      throw new Error(
        `无法读取 ComfyUI workflow：${serverConfig.comfyuiTextureWorkflowPath}。${error instanceof Error ? error.message : ''}`,
      );
    });
  return JSON.parse(content) as UiWorkflow;
}

function composeComfyPositivePrompt(userPrompt: string) {
  const materialPrompt = userPrompt.trim() || '根据所选材质参考图生成真实、连续、干净的物体材质。';
  return [
    'Generate a projection-aligned albedo/base-color texture for the visible surface of the current 3D model view.',
    `User material prompt: ${materialPrompt}`,
    'The user material prompt and uploaded material reference image are the source of truth for material intent. The material reference image is the primary visual constraint for color, roughness impression, grain scale, label/detail style, and surface pattern. Do not replace it with another material category.',
    'Use the uploaded white render, object mask, depth control, full normal control, and material reference to preserve the exact silhouette, proportions, surface orientation, camera projection, cap/rim/profile details, and visible area.',
    'The output must stay pixel-aligned with the 4096 x 4096 object mask and must be suitable for projection back to the Web3D model.',
    'If the prompt or reference indicates metal, keep the surface as smooth continuous metal with subtle fine grain or micro-scratches only; do not turn it into stone, ceramic, tiles, scales, bricks, mosaic, fabric, wood, or repeated square patterns.',
    'Flat albedo/base color only: no background, no scene, no extra object, no text unless it exists in the material reference, no baked shadows, no strong highlights, no mirror reflections, no environment lighting, no watermark.',
  ].join('\n');
}

function enableNormalControl(workflow: UiWorkflow, nodes: Map<number, UiNode>) {
  const normalControl = nodes.get(comfyNodeIds.normalControl);
  if (normalControl) {
    normalControl.mode = 0;
    normalControl.widgets_values = [0.28];
  }
  const normalScale = nodes.get(comfyNodeIds.normalScale);
  if (normalScale) normalScale.widgets_values = ['lanczos', 1024, 1024, 'disabled'];
  const modelSampling = nodes.get(comfyNodeIds.modelSampling);
  const modelInput = modelSampling?.inputs?.find((input) => input.name === 'model');
  if (modelInput) modelInput.link = 26;
  workflow.links = workflow.links.filter((link) => link[0] !== 34);
}

function patchWorkflow(
  workflow: UiWorkflow,
  input: ComfyTextureMapInput,
  uploadedImages: Map<number, string>,
  jobId: string,
) {
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  for (const [nodeId, imagePath] of uploadedImages) {
    const node = nodes.get(nodeId);
    if (!node) throw new Error(`ComfyUI workflow 缺少 LoadImage 节点：${nodeId}`);
    node.widgets_values = [imagePath, 'image'];
  }
  enableNormalControl(workflow, nodes);
  const promptNode = nodes.get(comfyNodeIds.positivePrompt);
  if (promptNode) promptNode.widgets_values = [composeComfyPositivePrompt(input.prompt)];
  const samplerNode = nodes.get(comfyNodeIds.sampler);
  if (samplerNode?.widgets_values?.length) {
    const seed = Number.isFinite(input.seed)
      ? Math.floor(input.seed ?? 0)
      : Math.floor(Math.random() * 1_000_000_000);
    samplerNode.widgets_values = [
      seed,
      samplerNode.widgets_values[1] ?? 'fixed',
      samplerNode.widgets_values[2] ?? 5,
      samplerNode.widgets_values[3] ?? 1,
      samplerNode.widgets_values[4] ?? 'res_multistep',
      samplerNode.widgets_values[5] ?? 'simple',
      0.54,
    ];
  }
  for (const nodeId of [comfyNodeIds.finalRgbSave, comfyNodeIds.finalAlphaSave]) {
    const node = nodes.get(nodeId);
    if (node)
      node.widgets_values = [
        `li3d_zimage/web3d_${jobId}/${nodeId === comfyNodeIds.finalRgbSave ? 'final_rgb_4096' : 'final_alpha_4096'}`,
      ];
  }
}

function isBypassed(node: UiNode) {
  return node.mode === 4;
}

function linkedInputs(
  node: UiNode,
  linksByTarget: Map<string, [number, number, number, number, number, string]>,
  activeNodeIds: Set<number>,
) {
  const inputs: Record<string, unknown> = {};
  const nodeInputs = node.inputs ?? [];
  for (let slotIndex = 0; slotIndex < nodeInputs.length; slotIndex += 1) {
    const input = nodeInputs[slotIndex];
    const link = linksByTarget.get(`${node.id}:${slotIndex}`);
    if (!link) continue;
    if (!activeNodeIds.has(link[1])) continue;
    inputs[input.name] = [String(link[1]), link[2]];
  }
  return inputs;
}

function applyKSamplerWidgets(inputs: Record<string, unknown>, widgets: unknown[]) {
  const keys = ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'];
  const values = [widgets[0], widgets[2], widgets[3], widgets[4], widgets[5], widgets[6]];
  keys.forEach((key, index) => {
    if (inputs[key] === undefined && values[index] !== undefined) inputs[key] = values[index];
  });
}

function convertWorkflowToApiPrompt(workflow: UiWorkflow, objectInfo: ObjectInfo) {
  const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const activeNodes = workflow.nodes.filter((node) => !isBypassed(node));
  const activeNodeIds = new Set(activeNodes.map((node) => node.id));
  const linksByTarget = new Map<string, [number, number, number, number, number, string]>();
  for (const link of workflow.links) {
    if (!activeNodeIds.has(link[1]) || !activeNodeIds.has(link[3])) continue;
    linksByTarget.set(`${link[3]}:${link[4]}`, link);
  }
  const prompt: Record<
    string,
    { class_type: string; inputs: Record<string, unknown>; _meta?: Record<string, unknown> }
  > = {};

  for (const node of activeNodes) {
    const info = objectInfo[node.type];
    if (!info) throw new Error(`ComfyUI 当前环境缺少节点：${node.type}`);
    const inputs = linkedInputs(node, linksByTarget, activeNodeIds);
    const widgets = node.widgets_values ?? [];
    if (node.type === 'KSampler') {
      applyKSamplerWidgets(inputs, widgets);
    } else {
      let widgetIndex = 0;
      for (const inputName of Object.keys(info.input?.required ?? {})) {
        if (inputs[inputName] !== undefined) continue;
        while (widgetIndex < widgets.length && widgets[widgetIndex] === undefined) widgetIndex += 1;
        if (widgetIndex < widgets.length) {
          inputs[inputName] = widgets[widgetIndex];
          widgetIndex += 1;
        }
      }
    }
    const missingLinkedSource = Object.values(inputs).some((value) => {
      if (!Array.isArray(value)) return false;
      const source = Number(value[0]);
      return !nodesById.has(source) || !activeNodeIds.has(source);
    });
    if (missingLinkedSource) continue;
    prompt[String(node.id)] = {
      class_type: node.type,
      inputs,
      _meta: node.title ? { title: node.title } : undefined,
    };
  }

  return prompt;
}

async function queuePrompt(
  prompt: Record<string, unknown>,
  clientId: string,
  baseUrl = serverConfig.comfyuiBaseUrl,
) {
  const response = await comfyFetch(
    '/prompt',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, prompt }),
    },
    60_000,
    baseUrl,
  );
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = formatComfyPromptError(payload, response.status);
    throw new Error(message);
  }
  const promptId =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>).prompt_id
      : undefined;
  if (typeof promptId !== 'string') throw new Error('ComfyUI 没有返回 prompt_id。');
  return promptId;
}

function formatComfyPromptError(payload: unknown, status: number) {
  if (!payload || typeof payload !== 'object') return `ComfyUI prompt failed: ${status}`;
  const record = payload as Record<string, unknown>;
  const error = record.error;
  const nodeErrors = record.node_errors;
  const parts: string[] = [];
  if (error && typeof error === 'object') {
    const errorRecord = error as Record<string, unknown>;
    const message = typeof errorRecord.message === 'string' ? errorRecord.message : undefined;
    const type = typeof errorRecord.type === 'string' ? errorRecord.type : undefined;
    parts.push([type, message].filter(Boolean).join(': ') || JSON.stringify(errorRecord));
  } else if (typeof error === 'string') {
    parts.push(error);
  }
  if (nodeErrors && typeof nodeErrors === 'object') {
    for (const [nodeId, nodeError] of Object.entries(nodeErrors as Record<string, unknown>)) {
      parts.push(`node ${nodeId}: ${JSON.stringify(nodeError)}`);
    }
  }
  return parts.filter(Boolean).join('\n') || JSON.stringify(payload);
}

async function getHistory(promptId: string, baseUrl = serverConfig.comfyuiBaseUrl) {
  const response = await comfyFetch(
    `/history/${encodeURIComponent(promptId)}`,
    { method: 'GET' },
    30_000,
    baseUrl,
  );
  if (!response.ok) throw new Error(`ComfyUI history failed: ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}

function extractImageOutput(
  history: Record<string, unknown>,
  promptId: string,
  preferredNodeIds: number[] = [comfyNodeIds.finalRgbSave, comfyNodeIds.finalAlphaSave],
) {
  const item = history[promptId];
  if (!item || typeof item !== 'object') return undefined;
  const outputs = (item as Record<string, unknown>).outputs;
  if (!outputs || typeof outputs !== 'object') return undefined;
  const byNode = outputs as Record<string, unknown>;
  const preferred = preferredNodeIds.map((nodeId) => byNode[String(nodeId)]).filter(Boolean);
  const candidates = [...preferred, ...Object.values(byNode)];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const images = (candidate as Record<string, unknown>).images;
    if (!Array.isArray(images) || images.length === 0) continue;
    const first = images[0] as Partial<ComfyImageOutput>;
    if (typeof first.filename === 'string') return first as ComfyImageOutput;
  }
  return undefined;
}

async function waitForOutput(
  promptId: string,
  jobId: string,
  options: { baseUrl?: string; preferredNodeIds?: number[] } = {},
) {
  const startedAt = Date.now();
  let lastHistory: Record<string, unknown> | undefined;
  while (Date.now() - startedAt < 30 * 60 * 1000) {
    assertComfyJobActive(jobId);
    lastHistory = await getHistory(promptId, options.baseUrl);
    const image = extractImageOutput(lastHistory, promptId, options.preferredNodeIds);
    if (image) return { image, history: lastHistory };
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  throw new Error('等待 ComfyUI 生成超时。');
}

async function downloadComfyImage(image: ComfyImageOutput, baseUrl = serverConfig.comfyuiBaseUrl) {
  const url = comfyUrl(
    '/view',
    {
      filename: image.filename,
      subfolder: image.subfolder ?? '',
      type: image.type ?? 'output',
    },
    baseUrl,
  );
  const response = await fetch(url);
  if (!response.ok) throw new Error(`无法读取 ComfyUI 输出图片：${response.status}`);
  const contentType = response.headers.get('content-type')?.split(';')[0] ?? 'image/png';
  const buffer = Buffer.from(await response.arrayBuffer());
  return { contentType, buffer };
}

export async function cancelComfyTextureMap(jobId?: string) {
  const activeJob = jobId ? activeComfyJobs.get(jobId) : undefined;
  const baseUrl = activeJob?.baseUrl;
  if (jobId) {
    cancelledComfyJobIds.add(jobId);
    getActiveComfyJob(jobId).cancelled = true;
  }
  if (activeJob?.abort) {
    activeJob.abort();
    return { ok: true, cancelledJobId: jobId };
  }
  const interrupt = await comfyFetch('/interrupt', { method: 'POST' }, 10_000, baseUrl).catch(
    (error: unknown) => {
      throw new Error(error instanceof Error ? error.message : 'ComfyUI interrupt failed.');
    },
  );
  if (!interrupt.ok) throw new Error(`ComfyUI interrupt failed: ${interrupt.status}`);
  return { ok: true, cancelledJobId: jobId };
}

export async function generateComfyTextureMap(input: ComfyTextureMapInput, userId: string) {
  const projectId = input.projectId;
  if (!projectId) throw new Error('ComfyUI 生图需要当前项目 ID。');
  await checkComfyuiStatus();
  const jobId = input.clientGenerationId || `comfy-${randomUUID()}`;
  activeComfyJobs.set(jobId, {
    cancelled: cancelledComfyJobIds.has(jobId),
    baseUrl: serverConfig.comfyuiBaseUrl,
  });
  try {
    assertComfyJobActive(jobId);
    const [workflow, objectInfo] = await Promise.all([loadWorkflowTemplate(), getObjectInfo()]);
    assertComfyJobActive(jobId);
    const uploadedImages = await uploadControlFiles(input.files, jobId);
    assertComfyJobActive(jobId);
    patchWorkflow(workflow, input, uploadedImages, jobId);
    const prompt = convertWorkflowToApiPrompt(workflow, objectInfo);
    const promptId = await queuePrompt(prompt, `liclick-${jobId}`);
    getActiveComfyJob(jobId).promptId = promptId;
    const output = await waitForOutput(promptId, jobId);
    assertComfyJobActive(jobId);
    const image = await downloadComfyImage(output.image);
    assertComfyJobActive(jobId);
    const saved = await saveBinaryAsset({
      userId,
      projectId,
      category: 'generations',
      mime: image.contentType,
      buffer: image.buffer,
      filename: `${jobId}-comfy-final-rgb.png`,
    });
    if (!saved) throw new Error('当前项目不存在，无法保存 ComfyUI 输出。');
    return {
      id: jobId,
      resultUrl: saved.url,
      resultUrls: [saved.url],
      promptId,
      output: output.image,
    };
  } finally {
    activeComfyJobs.delete(jobId);
    cancelledComfyJobIds.delete(jobId);
  }
}

export async function generateComfyInpaint(input: ComfyInpaintInput, userId: string) {
  const projectId = input.projectId;
  if (!projectId) throw new Error('ComfyUI 局部重绘需要当前项目 ID。');
  if (!input.image?.dataUrl) throw new Error('ComfyUI 局部重绘输入图不能为空。');
  await checkComfyInpaintServiceStatus();
  const jobId = input.clientGenerationId || `comfy-inpaint-${randomUUID()}`;
  activeComfyJobs.set(jobId, {
    cancelled: cancelledComfyJobIds.has(jobId),
    serviceUrl: serverConfig.comfyuiInpaintServiceUrl,
  });
  try {
    assertComfyJobActive(jobId);
    const multipart = createInpaintServiceMultipart(input.image);
    const response = await requestInpaintService('POST', {
      body: multipart.body,
      timeoutMs: 30 * 60 * 1000,
      headers: {
        Accept: 'image/*',
        'Content-Type': multipart.contentType,
        'Content-Length': multipart.body.length,
        'Idempotency-Key': jobId,
      },
      onRequest: (request) => {
        getActiveComfyJob(jobId).abort = () =>
          request.destroy(new Error('局部重绘任务已取消。'));
      },
    });
    assertComfyJobActive(jobId);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const detail = response.buffer.toString('utf8').slice(0, 1000);
      throw new Error(
        `局部重绘服务请求失败：${response.statusCode}${detail ? ` (${detail})` : ''}`,
      );
    }
    const mime = response.contentType.split(';', 1)[0]?.trim().toLowerCase();
    if (!mime?.startsWith('image/')) {
      throw new Error(
        `局部重绘服务没有返回图片：${response.contentType || 'unknown content type'}`,
      );
    }
    const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
    const saved = await saveBinaryAsset({
      userId,
      projectId,
      category: 'generations',
      mime,
      buffer: response.buffer,
      filename: `${jobId}-modelview-inpaint.${extension}`,
    });
    if (!saved) throw new Error('当前项目不存在，无法保存 ComfyUI 局部重绘输出。');
    return {
      id: jobId,
      resultUrl: saved.url,
      resultUrls: [saved.url],
      output: {
        provider: 'modelview-inpaint',
        requestId: response.requestId,
        contentType: mime,
      },
    };
  } finally {
    activeComfyJobs.delete(jobId);
    cancelledComfyJobIds.delete(jobId);
  }
}
