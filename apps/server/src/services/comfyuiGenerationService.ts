import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { serverConfig } from '../config.js';
import { saveBinaryAsset, saveUserRecoveryAsset } from './assetFileService.js';

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

export type ComfyMaterialRepaintInput = {
  clientGenerationId?: string;
  projectId?: string;
  captureId?: string;
  objectId?: string;
  materialReferenceId?: string;
  whiteModel: ComfyControlFile;
  materialReference: ComfyControlFile;
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
  userId: string;
  cancelled: boolean;
  promptId?: string;
  baseUrl?: string;
};

export class ComfyCancelError extends Error {
  constructor(
    message: string,
    readonly httpStatus: 400 | 404,
  ) {
    super(message);
    this.name = 'ComfyCancelError';
  }
}

export function comfyCancelErrorStatus(error: unknown) {
  return error instanceof ComfyCancelError ? error.httpStatus : 202;
}

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

const materialRepaintNodeIds = {
  whiteModel: 4,
  materialReference: 5,
  noise: 14,
  output: 20,
} as const;

const materialRepaintPrompt =
  'Transfer the material appearance of the corresponding asset in image 2 onto the untextured model in image 1. Image 1 is the absolute source of geometry, silhouette, internal structure, component count, camera view, perspective, pose, scale, position, framing, visible surfaces, occlusion relationships, and background. Preserve every existing small part, edge, opening, fastener, blade, rail, control, seam, and surface boundary from image 1 without simplification. Use image 2 only to infer the material appearance of the same asset. Map each corresponding material region to the matching existing part in image 1, preserving the exact color zoning, paint boundaries, bare-metal regions, rust, scratches, wear, labels, and fine surface texture shown on corresponding parts in image 2. Do not spread the most dominant color across unrelated parts. If image 2 contains multiple views, use them only to understand material continuity; never copy the multi-view layout and never import components visible only in another view. Do not add, remove, move, resize, rotate, replace, reshape, merge, or reconstruct any geometry. Do not invent text, logos, attachments, openings, controls, or mechanical details. The final result is the exact model and current view from image 1 with only its visible surfaces re-materialized from image 2.';

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
      `ComfyUI 后端未启动或无法连接：${baseUrl}。请确认服务地址和端口可访问。${error instanceof Error ? ` (${error.message})` : ''}`,
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

export async function checkComfyMaterialRepaintStatus() {
  await checkComfyuiStatus(serverConfig.comfyuiMaterialRepaintBaseUrl);
  return { ok: true, baseUrl: serverConfig.comfyuiMaterialRepaintBaseUrl };
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
  const job = activeComfyJobs.get(jobId);
  if (!job) throw new Error('ComfyUI texture generation job is not active.');
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

function buildMaterialRepaintApiPrompt(
  whiteModelPath: string,
  materialReferencePath: string,
  jobId: string,
  seed?: number,
) {
  const noiseSeed = Number.isFinite(seed)
    ? Math.floor(seed ?? 0)
    : Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  const link = (nodeId: number, output = 0): [string, number] => [String(nodeId), output];
  const node = (classType: string, inputs: Record<string, unknown>, title?: string) => ({
    class_type: classType,
    inputs,
    _meta: title ? { title } : undefined,
  });

  // API equivalent of “Flux2 Klein TrueV3-双图材质编辑-精简测试”.
  // The user prompt node remains present but intentionally empty; node 26
  // appends the workflow-owned material-transfer instruction above.
  return {
    '1': node(
      'UNETLoader',
      {
        unet_name: 'Flux2-Klein-9B-True-V3-int8mixedrow.safetensors',
        weight_dtype: 'default',
      },
      'TrueV3 主模型',
    ),
    '2': node(
      'CLIPLoader',
      {
        clip_name: 'qwen_3_8b_fp8mixed.safetensors',
        type: 'flux2',
        device: 'default',
      },
      'Flux2 文本编码器',
    ),
    '3': node('VAELoader', { vae_name: 'flux2-vae.safetensors' }, 'Flux2 VAE'),
    '4': node('LoadImage', { image: whiteModelPath }, '图1｜白模主图（锁定构图）'),
    '5': node('LoadImage', { image: materialReferencePath }, '图2｜六视图材质参考'),
    '7': node('VAEEncode', { pixels: link(23), vae: link(3) }, '编码图1'),
    '8': node('VAEEncode', { pixels: link(24), vae: link(3) }, '编码图2'),
    '10': node(
      'ReferenceLatent',
      { conditioning: link(27), latent: link(7) },
      '参考条件1｜白模主图',
    ),
    '11': node(
      'ReferenceLatent',
      { conditioning: link(10), latent: link(8) },
      '参考条件2｜材质六视图',
    ),
    '12': node('BasicGuider', { model: link(21), conditioning: link(11) }, 'TrueV3 引导'),
    '13': node(
      'EmptyFlux2LatentImage',
      { width: link(22, 2), height: link(22, 3), batch_size: 1 },
      '输出画布｜跟随图1',
    ),
    '14': node('RandomNoise', { noise_seed: noiseSeed }, '随机种子'),
    '15': node(
      'BasicScheduler',
      { model: link(21), scheduler: 'simple', steps: 12, denoise: 1 },
      '12步 Simple 调度',
    ),
    '16': node('KSamplerSelect', { sampler_name: 'euler' }, 'Euler 采样器'),
    '17': node(
      'SamplerCustomAdvanced',
      {
        noise: link(14),
        guider: link(12),
        sampler: link(16),
        sigmas: link(15),
        latent_image: link(13),
      },
      'TrueV3 双图采样',
    ),
    '18': node('VAEDecode', { samples: link(17), vae: link(3) }, '解码生成结果'),
    '20': node(
      'SaveImage',
      {
        images: link(25),
        filename_prefix: `li3d_material_repaint/${jobId}/KleinTrueV3_DualMaterial`,
      },
      '保存生成结果',
    ),
    '21': node(
      'LoraLoaderModelOnly',
      {
        model: link(1),
        lora_name: 'baimo_shangcaizhi_klein_v1_000005500.safetensors',
        strength_model: 0.8,
      },
      '白模上材质 LoRA｜0.8',
    ),
    '22': node(
      'CherryInferenceSizeBucket',
      { image: link(4), aspect_threshold: 1.2, square_size: 1024, long_size: 1536 },
      '图1｜选择推理尺寸并记录原始尺寸',
    ),
    '23': node(
      'ImageResize+',
      {
        image: link(4),
        width: link(22, 2),
        height: link(22, 3),
        interpolation: 'area',
        method: 'pad',
        condition: 'always',
        multiple_of: 0,
      },
      '图1｜等比适配并补边到推理尺寸',
    ),
    '24': node(
      'ImageResize+',
      {
        image: link(5),
        width: link(22, 2),
        height: link(22, 3),
        interpolation: 'area',
        method: 'pad',
        condition: 'always',
        multiple_of: 0,
      },
      '图2｜等比适配并补边到同一推理尺寸',
    ),
    '25': node(
      'ImageScale',
      {
        image: link(18),
        upscale_method: 'lanczos',
        width: link(22, 0),
        height: link(22, 1),
        crop: 'center',
      },
      '去补边并恢复图1原始尺寸',
    ),
    '26': node('StringFunction|pysssss', {
      action: 'append',
      tidy_tags: 'no',
      text_a: link(28),
      text_b: materialRepaintPrompt,
      text_c: '',
    }),
    '27': node(
      'CLIPTextEncode',
      { clip: link(2), text: link(26) },
      'CLIP Text Encode (Positive Prompt)',
    ),
    '28': node('CherryKleinTextBox', { text: '' }, '用户定义视角(可空)'),
  };
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

export async function cancelComfyTextureMap(jobId: string, userId: string) {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) {
    throw new ComfyCancelError('ComfyUI cancel requires a non-empty jobId.', 400);
  }
  const activeJob = activeComfyJobs.get(normalizedJobId);
  if (!activeJob || !activeJob.userId || activeJob.userId !== userId) {
    throw new ComfyCancelError('ComfyUI texture generation job was not found.', 404);
  }
  cancelledComfyJobIds.add(normalizedJobId);
  activeJob.cancelled = true;
  const interrupt = await comfyFetch(
    '/interrupt',
    { method: 'POST' },
    10_000,
    activeJob.baseUrl,
  ).catch((error: unknown) => {
    throw new Error(error instanceof Error ? error.message : 'ComfyUI interrupt failed.');
  });
  if (!interrupt.ok) throw new Error(`ComfyUI interrupt failed: ${interrupt.status}`);
  return { ok: true, cancelledJobId: normalizedJobId };
}

export async function generateComfyTextureMap(input: ComfyTextureMapInput, userId: string) {
  const projectId = input.projectId;
  if (!projectId) throw new Error('ComfyUI 生图需要当前项目 ID。');
  const ownerUserId = userId.trim();
  if (!ownerUserId) throw new Error('Authenticated user id is required.');
  const jobId = input.clientGenerationId?.trim() || `comfy-${randomUUID()}`;
  if (activeComfyJobs.has(jobId)) {
    throw new Error('A ComfyUI texture generation job with this id is already active.');
  }
  activeComfyJobs.set(jobId, {
    userId: ownerUserId,
    cancelled: cancelledComfyJobIds.has(jobId),
    baseUrl: serverConfig.comfyuiBaseUrl,
  });
  try {
    await checkComfyuiStatus();
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

export async function generateComfyMaterialRepaint(
  input: ComfyMaterialRepaintInput,
  userId: string,
) {
  const projectId = input.projectId;
  if (!projectId) throw new Error('局部重绘需要当前项目 ID。');
  const ownerUserId = userId.trim();
  if (!ownerUserId) throw new Error('Authenticated user id is required.');
  const jobId = input.clientGenerationId?.trim() || `material-repaint-${randomUUID()}`;
  if (activeComfyJobs.has(jobId)) {
    throw new Error('A ComfyUI generation job with this id is already active.');
  }
  const baseUrl = serverConfig.comfyuiMaterialRepaintBaseUrl;
  activeComfyJobs.set(jobId, {
    userId: ownerUserId,
    cancelled: cancelledComfyJobIds.has(jobId),
    baseUrl,
  });
  try {
    await checkComfyuiStatus(baseUrl);
    assertComfyJobActive(jobId);
    const subfolder = `li3d_material_repaint/${jobId}`;
    const [whiteModelPath, materialReferencePath] = await Promise.all([
      uploadImage(input.whiteModel, subfolder, baseUrl),
      uploadImage(input.materialReference, subfolder, baseUrl),
    ]);
    assertComfyJobActive(jobId);
    const prompt = buildMaterialRepaintApiPrompt(
      whiteModelPath,
      materialReferencePath,
      jobId,
      input.seed,
    );
    const promptId = await queuePrompt(prompt, `liclick-material-${jobId}`, baseUrl);
    getActiveComfyJob(jobId).promptId = promptId;
    const output = await waitForOutput(promptId, jobId, {
      baseUrl,
      preferredNodeIds: [materialRepaintNodeIds.output],
    });
    assertComfyJobActive(jobId);
    const image = await downloadComfyImage(output.image, baseUrl);
    assertComfyJobActive(jobId);
    const projectAsset = await saveBinaryAsset({
      userId,
      projectId,
      category: 'generations',
      mime: image.contentType,
      buffer: image.buffer,
      filename: `${jobId}-material-repaint.png`,
    });
    const saved =
      projectAsset ??
      (await saveUserRecoveryAsset({
        userId,
        mime: image.contentType,
        buffer: image.buffer,
        filename: `${jobId}-material-repaint.png`,
      }));
    if (!projectAsset) {
      console.warn(
        '[ComfyUI Material Repaint] project belongs to the local component; saved recovery asset',
        {
          userId,
          projectId,
          jobId,
          resultUrl: saved.url,
        },
      );
    }
    return {
      id: jobId,
      resultUrl: saved.url,
      resultUrls: [saved.url],
      promptId,
      output: {
        ...output.image,
        storage: projectAsset ? 'project' : 'user-recovery',
      },
    };
  } finally {
    activeComfyJobs.delete(jobId);
    cancelledComfyJobIds.delete(jobId);
  }
}
