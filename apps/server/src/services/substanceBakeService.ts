import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { deflateSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { serverConfig } from '../config.js';
import { gpuControlLanCa } from '../certs/gpuControlLanCa.js';
import {
  displayFilename,
  englishSafeFilename,
  englishSafeStem,
} from './modelFilenameService.js';
import {
  bakeArtifactChannel,
  selectBakeArtifactFileNames,
} from './bakeArtifactPlan.js';

export type BakeChannelId =
  | 'baseColor'
  | 'normal'
  | 'ambientOcclusion'
  | 'curvature'
  | 'worldNormal'
  | 'thickness'
  | 'position'
  | 'roughness'
  | 'metallic';

export type NormalBakeSettings = {
  resolution: 1024 | 2048 | 4096;
  padding: number;
  sampling: '1x1' | '2x2' | '4x4' | '8x8';
  normalOrientation: 'directx' | 'opengl';
  device: 'gpu' | 'cpu';
  udim: number;
  frontalDistance: number;
  rearDistance: number;
  matchMode: 'always' | 'by-name';
  projectionMode: 'distance' | 'cage';
  hitStrategy: 'inward' | 'closest-from-source';
  ignoreBackfaces: boolean;
  generateRoughnessFromBakedBaseColor?: boolean;
  channels: BakeChannelId[];
};

export type BakeUpload = { fileName: string; data: Buffer };

type BakeInputFileNames = {
  high: string;
  low: string;
  cage?: string;
  color?: string;
  roughness?: string;
  metallic?: string;
};

type RemoteBakeProfile = 'ao-self-v1' | 'normal-dx-v1' | 'pbr-core-v1' | 'li3d-pbr-full-v2';

type RemoteBakeStatus =
  | 'QUEUED'
  | 'CLAIMED'
  | 'RUNNING'
  | 'CANCELLING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | (string & {});

type RemoteTiming = {
  queue_position?: number;
  estimated_start_seconds?: number;
  elapsed_seconds?: number;
  estimated_remaining_seconds?: number;
};

type RemoteArtifact = {
  id: string;
  kind: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  download_url: string;
};

type RemoteJobPayload = {
  job_id: string;
  status?: RemoteBakeStatus;
  progress?: number;
  stage?: string;
  stage_message?: string;
  status_url?: string;
  events_url?: string;
  cancel_url?: string;
  worker_id?: string;
  delivery_ready?: boolean;
  timing?: RemoteTiming;
  artifacts?: RemoteArtifact[];
  error?: unknown;
};

export type NormalBakeJob = {
  id: string;
  ownerUserId: string;
  kind: 'bake-maps';
  projectId: string;
  objectId: string;
  status: 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';
  stage: 'waiting-for-worker' | 'baking-maps' | 'verifying-file' | 'finished';
  progress: number;
  settings: NormalBakeSettings;
  input: BakeInputFileNames;
  /** Original user-facing basenames. Never use these values as disk paths or multipart names. */
  displayInput?: BakeInputFileNames;
  output?: { fileName: string; width: number; height: number; url: string };
  outputs?: Partial<
    Record<BakeChannelId, { fileName: string; width: number; height: number; url: string }>
  >;
  remote?: {
    jobId: string;
    profile: RemoteBakeProfile;
    statusUrl: string;
    eventsUrl?: string;
    cancelUrl?: string;
    status?: RemoteBakeStatus;
    workerId?: string;
    stage?: string;
    stageMessage?: string;
    deliveryReady?: boolean;
    timing?: RemoteTiming;
  };
  error?: string;
  logs: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
};

type InternalJob = NormalBakeJob & {
  directory: string;
  outputPaths: Record<BakeChannelId, string>;
};

type RemoteResponse = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

class BakeRequestError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
  }
}

const jobs = new Map<string, InternalJob>();
const monitors = new Set<string>();
const maxLogLines = 400;
const outputFileNames: Record<BakeChannelId, string> = {
  baseColor: 'basecolor.png',
  normal: 'normal.png',
  ambientOcclusion: 'ao.png',
  curvature: 'curvature.png',
  worldNormal: 'world_normal.png',
  thickness: 'thickness.png',
  position: 'position.png',
  roughness: 'roughness.png',
  metallic: 'metallic.png',
};

const fullProfileArtifactFiles = [
  'asset_base_color.png',
  'asset_roughness.png',
  'asset_metallic.png',
  'asset_ao.png',
  'asset_normal_dx.png',
  'asset_normal_gl.png',
  'asset_world_normal.png',
  'asset_curvature.png',
  'asset_thickness.png',
  'asset_position.png',
  'baker_result.json',
  'baker.log',
] as const;

const artifactDownloadConcurrency = 3;

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<void>,
) {
  let nextIndex = 0;
  let firstError: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length && firstError === undefined) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          await worker(values[index], index);
        } catch (error) {
          firstError ??= error;
        }
      }
    }),
  );
  if (firstError !== undefined) throw firstError;
}

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBuffer.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return result;
}

function solidPng(red: number, green: number, blue: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, red, green, blue, 255]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function neutralMaterialUpload(channel: 'color' | 'roughness' | 'metallic'): BakeUpload {
  const value = channel === 'metallic' ? 0 : 128;
  return {
    fileName: `liclick_neutral_${channel}.png`,
    data: solidPng(value, value, value),
  };
}

function remoteUrl(value: string) {
  const baseUrl = new URL(`${serverConfig.substanceBakerBaseUrl}/`);
  const url = new URL(value, baseUrl);
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new BakeRequestError('远端 Substance Baker 必须使用 HTTPS。', 500);
  }
  if (url.origin !== baseUrl.origin) {
    throw new BakeRequestError('远端 Substance Baker 返回了不同源 URL，已拒绝访问。', 502);
  }
  return url;
}

type RemoteTrust = {
  ca?: string[];
  source: 'configured-ca' | 'auto-discovered-ca' | 'embedded-ca' | 'system-ca' | 'node-default-ca';
  caPath?: string;
};

function remoteTrust(): RemoteTrust {
  const configuredPath =
    serverConfig.substanceBakerCaPath || process.env.NODE_EXTRA_CA_CERTS?.trim() || '';
  const candidates = configuredPath
    ? [path.resolve(configuredPath)]
    : [
        path.join(serverConfig.workspaceDir, 'config', 'GPU_CONTROL_LAN_CA.crt'),
        path.join(serverConfig.repoRoot, 'config', 'GPU_CONTROL_LAN_CA.crt'),
        path.join(serverConfig.repoRoot, 'secrets', 'GPU_CONTROL_LAN_CA.crt'),
        path.join(serverConfig.repoRoot, 'GPU_CONTROL_LAN_CA.crt'),
        ...(process.env.USERPROFILE
          ? [path.join(process.env.USERPROFILE, 'Downloads', 'GPU_CONTROL_LAN_CA.crt')]
          : []),
      ];
  const caPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (configuredPath && !caPath) {
    throw new BakeRequestError(`远端 Substance Baker LAN CA 不存在：${candidates[0]}`, 500);
  }
  if (caPath) {
    return {
      ca: [...tls.rootCertificates, fs.readFileSync(caPath, 'utf8')],
      source: configuredPath ? 'configured-ca' : 'auto-discovered-ca',
      caPath,
    };
  }

  const getCACertificates = (
    tls as typeof tls & {
      getCACertificates?: (type?: 'default' | 'system' | 'bundled' | 'extra') => string[];
    }
  ).getCACertificates;
  if (getCACertificates) {
    const certificates = Array.from(
      new Set([...getCACertificates('default'), ...getCACertificates('system'), gpuControlLanCa]),
    );
    return { ca: certificates, source: 'embedded-ca' };
  }
  return { ca: [...tls.rootCertificates, gpuControlLanCa], source: 'embedded-ca' };
}

function requestRemote(
  target: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    bodyChunks?: Buffer[];
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
) {
  const url = remoteUrl(target);
  const bodyChunks = options.bodyChunks ?? [];
  const headers = {
    accept: 'application/json',
    ...(serverConfig.substanceBakerApiKey
      ? { 'x-api-key': serverConfig.substanceBakerApiKey }
      : {}),
    ...options.headers,
  };
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise<RemoteResponse>((resolve, reject) => {
    const trust = url.protocol === 'https:' ? remoteTrust() : undefined;
    const request = transport.request(
      url,
      {
        method: options.method ?? 'GET',
        headers,
        ...(url.protocol === 'https:'
          ? { ...(trust?.ca ? { ca: trust.ca } : {}), rejectUnauthorized: true }
          : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
        response.on('data', (chunk: Buffer) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > maxBytes) {
            response.destroy(new Error('Remote Substance Baker response is too large.'));
            return;
          }
          chunks.push(buffer);
        });
        response.once('error', reject);
        response.once('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks, totalBytes),
          });
        });
      },
    );
    request.setTimeout(options.timeoutMs ?? 30_000, () => {
      request.destroy(new Error('连接远端 Substance Baker 超时。'));
    });
    request.once('error', reject);
    for (const chunk of bodyChunks) request.write(chunk);
    request.end();
  });
}

function parseJson<T>(response: RemoteResponse) {
  try {
    return JSON.parse(response.body.toString('utf8')) as T;
  } catch {
    throw new BakeRequestError(
      `远端 Substance Baker 返回了无效 JSON（HTTP ${response.statusCode}）。`,
      502,
    );
  }
}

function readableRemoteError(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(readableRemoteError).filter(Boolean).join('; ');
  }
  if (!value || typeof value !== 'object') return '';

  const record = value as Record<string, unknown>;
  const location = Array.isArray(record.loc)
    ? record.loc.map((part) => String(part)).join('.')
    : '';
  const code = readableRemoteError(record.code ?? record.type);
  const message = readableRemoteError(record.message ?? record.msg);
  const detail = readableRemoteError(record.detail);
  const primary = [location, code, message || detail].filter(Boolean).join(': ');
  if (primary) return primary;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function remoteErrorMessage(response: RemoteResponse) {
  let detail = response.body.toString('utf8').trim();
  try {
    const payload = JSON.parse(detail) as Record<string, unknown>;
    detail =
      readableRemoteError(payload.error) ||
      readableRemoteError(payload.detail) ||
      readableRemoteError({
        code: payload.code,
        message: payload.message,
      }) ||
      readableRemoteError(payload);
  } catch {
    // Preserve a plain-text upstream error.
  }
  return `远端 Substance Baker 请求失败（HTTP ${response.statusCode}）${detail ? `：${detail}` : ''}`;
}

function ensureRemoteSuccess(response: RemoteResponse, acceptedStatuses = [200]) {
  if (!acceptedStatuses.includes(response.statusCode)) {
    const upstreamStatus =
      response.statusCode >= 400 && response.statusCode < 500 ? response.statusCode : 502;
    throw new BakeRequestError(remoteErrorMessage(response), upstreamStatus);
  }
}

function safeFileName(value: string, fallback: string) {
  return englishSafeFilename(value, fallback);
}

function uniqueInputFileName(
  value: string,
  fallback: string,
  usedNames: Set<string>,
) {
  let candidate = englishSafeFilename(value, fallback);
  let counter = 1;
  while (usedNames.has(candidate.toLowerCase())) {
    const role = englishSafeStem(fallback, 'asset');
    candidate = englishSafeFilename(`${role}-${counter}-${candidate}`, fallback);
    counter += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function renamedUpload(upload: BakeUpload | undefined, fileName: string | undefined) {
  return upload && fileName ? { ...upload, fileName } : undefined;
}

function looksLikeHtml(data: Buffer) {
  const prefix = data.subarray(0, 1024).toString('utf8').trimStart().toLowerCase();
  return prefix.startsWith('<!doctype html') || prefix.startsWith('<html');
}

function validateBakeUpload(upload: BakeUpload, label: string, kind: 'model' | 'image') {
  if (upload.data.length < 16)
    throw new BakeRequestError(`${label} 文件为空或已损坏，请重新导入。`);
  if (looksLikeHtml(upload.data)) {
    throw new BakeRequestError(`${label} 读取到网页而不是资源文件，请刷新页面后重新导入。`);
  }
  if (kind === 'image') {
    const extension = path.extname(upload.fileName).toLowerCase();
    const supportedExtensions = new Set([
      '.png',
      '.jpg',
      '.jpeg',
      '.webp',
      '.tga',
      '.tif',
      '.tiff',
      '.exr',
    ]);
    if (!supportedExtensions.has(extension)) {
      throw new BakeRequestError(
        `${label} 格式不受支持；请使用 PNG、JPEG、WebP、TGA、TIFF 或 EXR。`,
      );
    }
  }
}

function profileForChannels(
  channels: BakeChannelId[],
  normalOrientation: NormalBakeSettings['normalOrientation'],
): RemoteBakeProfile {
  const fullProfile =
    channels.some((channel) => channel !== 'normal' && channel !== 'ambientOcclusion') ||
    (channels.includes('normal') && normalOrientation === 'opengl');
  if (fullProfile) return 'li3d-pbr-full-v2';
  const normal = channels.includes('normal');
  const ao = channels.includes('ambientOcclusion');
  if (normal && ao) return 'pbr-core-v1' as const;
  if (normal) return 'normal-dx-v1' as const;
  if (ao) return 'ao-self-v1' as const;
  throw new BakeRequestError('请至少选择一张烘焙输出贴图。');
}

function validateSettings(input: NormalBakeSettings) {
  if (![1024, 2048, 4096].includes(input.resolution)) {
    throw new BakeRequestError('远端 Substance Baker 仅支持 1K、2K 和 4K 输出。');
  }
  const generateRoughnessFromBakedBaseColor = input.generateRoughnessFromBakedBaseColor === true;
  const channels = Array.from(
    new Set([
      ...(input.channels ?? []),
      ...(generateRoughnessFromBakedBaseColor
        ? (['baseColor', 'roughness'] satisfies BakeChannelId[])
        : []),
    ]),
  );
  const knownChannels = new Set<BakeChannelId>(Object.keys(outputFileNames) as BakeChannelId[]);
  const unsupported = channels.filter((channel) => !knownChannels.has(channel));
  if (unsupported.length > 0) {
    throw new BakeRequestError(`未知烘焙输出：${unsupported.join(', ')}。`);
  }
  const profile = profileForChannels(channels, input.normalOrientation);
  const textureCacheMb = serverConfig.substanceBakerTextureCacheMb;
  if (![8192, 16384, 32768].includes(textureCacheMb)) {
    throw new BakeRequestError(
      'LICLICK_SUBSTANCE_BAKER_TEXTURE_CACHE_MB 必须是 8192、16384 或 32768。',
      500,
    );
  }
  return {
    settings: {
      ...input,
      device: 'gpu' as const,
      channels,
      generateRoughnessFromBakedBaseColor,
    },
    profile,
    textureCacheMb,
  };
}

function outputPaths(directory: string) {
  return Object.fromEntries(
    Object.entries(outputFileNames).map(([channel, fileName]) => [
      channel,
      path.join(directory, 'output', fileName),
    ]),
  ) as Record<BakeChannelId, string>;
}

function publicJob(job: InternalJob): NormalBakeJob {
  const result: Partial<InternalJob> = { ...job };
  delete result.directory;
  delete result.outputPaths;
  return result as NormalBakeJob;
}

function persist(job: InternalJob) {
  job.updatedAt = new Date().toISOString();
  fs.mkdirSync(job.directory, { recursive: true });
  fs.writeFileSync(path.join(job.directory, 'job.json'), JSON.stringify(publicJob(job), null, 2));
}

function appendLog(job: InternalJob, message: string) {
  const clean = message.trim();
  if (!clean) return;
  job.logs.push(clean);
  if (job.logs.length > maxLogLines) job.logs.splice(0, job.logs.length - maxLogLines);
  persist(job);
}

function pngSize(filePath: string) {
  const header = Buffer.alloc(24);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      throw new Error('PNG output is truncated.');
    }
  } finally {
    fs.closeSync(descriptor);
  }
  if (!header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('Remote bake output is not a readable PNG.');
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function multipartFileHeader(boundary: string, name: string, fileName: string) {
  const safeName = safeFileName(fileName, `${name}.bin`).replace(/"/g, '_');
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
}

function multipartField(boundary: string, name: string, value: string) {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${value}\r\n`,
  );
}

function buildMultipart(input: {
  boundary: string;
  low: BakeUpload;
  high?: BakeUpload;
  cage?: BakeUpload;
  color?: BakeUpload;
  roughness?: BakeUpload;
  metallic?: BakeUpload;
  metadata: string;
}) {
  const chunks: Buffer[] = [];
  const addFile = (name: string, upload: BakeUpload) => {
    chunks.push(
      multipartFileHeader(input.boundary, name, upload.fileName),
      upload.data,
      Buffer.from('\r\n'),
    );
  };
  addFile('low_mesh', input.low);
  if (input.high) addFile('high_mesh', input.high);
  if (input.cage) addFile('cage_mesh', input.cage);
  if (input.color) addFile('base_color_texture', input.color);
  if (input.roughness) addFile('roughness_texture', input.roughness);
  if (input.metallic) addFile('metallic_texture', input.metallic);
  chunks.push(
    multipartField(input.boundary, 'metadata', input.metadata),
    Buffer.from(`--${input.boundary}--\r\n`),
  );
  return chunks;
}

function mapRemoteError(error: unknown) {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const value = error as { code?: string; message?: string; detail?: string };
    return [value.code, value.message ?? value.detail].filter(Boolean).join(': ');
  }
  return '';
}

function applyRemoteStatus(job: InternalJob, payload: RemoteJobPayload) {
  if (!job.remote) return;
  const previousRemoteStatus = job.remote.status;
  const status = payload.status ?? job.remote.status ?? 'QUEUED';
  job.remote = {
    ...job.remote,
    status,
    workerId: payload.worker_id ?? job.remote.workerId,
    stage: payload.stage ?? job.remote.stage,
    stageMessage: payload.stage_message ?? job.remote.stageMessage,
    timing: payload.timing ?? job.remote.timing,
    deliveryReady: payload.delivery_ready ?? job.remote.deliveryReady,
  };
  job.progress = Math.max(0, Math.min(100, Math.round(payload.progress ?? job.progress)));
  if (status === 'QUEUED') {
    job.status = 'queued';
    job.stage = 'waiting-for-worker';
  } else if (status === 'CLAIMED' || status === 'RUNNING') {
    job.status = 'running';
    job.stage = 'baking-maps';
    job.startedAt ??= new Date().toISOString();
  } else if (status === 'CANCELLING') {
    job.status = 'cancelling';
    job.stage = 'baking-maps';
  } else if (status === 'SUCCEEDED') {
    job.status = 'running';
    job.stage = 'verifying-file';
    job.progress = Math.max(job.progress, 95);
  } else if (status === 'FAILED') {
    job.status = 'failed';
    job.stage = 'finished';
    job.error = mapRemoteError(payload.error) || '远端 Substance Baker 执行失败。';
    job.finishedAt = new Date().toISOString();
  } else if (status === 'CANCELLED') {
    job.status = 'cancelled';
    job.stage = 'finished';
    job.error = undefined;
    job.finishedAt = new Date().toISOString();
  } else if (status !== previousRemoteStatus) {
    const safeStatus = String(status)
      .replace(/[\r\n]/g, ' ')
      .slice(0, 80);
    job.logs.push(`[Remote] 收到非终态 ${safeStatus}，继续等待远端任务。`);
    if (job.logs.length > maxLogLines) job.logs.splice(0, job.logs.length - maxLogLines);
  }
  persist(job);
}

async function downloadArtifacts(job: InternalJob, payload: RemoteJobPayload) {
  if (payload.delivery_ready !== true) {
    throw new Error('远端任务已成功，但 delivery_ready 尚未发布。');
  }
  const artifacts = payload.artifacts ?? [];
  const expected =
    job.remote?.profile === 'li3d-pbr-full-v2'
      ? new Set<string>(fullProfileArtifactFiles)
      : new Set(
          job.settings.channels.map((channel) =>
            channel === 'normal' ? 'asset_normal_dx.png' : 'asset_ao.png',
          ),
        );
  for (const fileName of expected) {
    if (!artifacts.some((artifact) => artifact.filename === fileName)) {
      throw new Error(`远端原子产物缺少 ${fileName}。`);
    }
  }

  const selectedArtifactNames = new Set(
    selectBakeArtifactFileNames({
      availableFileNames: artifacts.map((artifact) => artifact.filename),
      channels: job.settings.channels,
      normalOrientation: job.settings.normalOrientation,
      generateRoughnessFromBakedBaseColor:
        job.settings.generateRoughnessFromBakedBaseColor,
    }),
  );
  const artifactsToDownload = artifacts.filter((artifact) =>
    selectedArtifactNames.has(artifact.filename),
  );
  const outputDirectory = path.join(job.directory, 'output');
  await fs.promises.mkdir(outputDirectory, { recursive: true });
  const outputs: NonNullable<NormalBakeJob['outputs']> = {};
  const saveDownloadedArtifact = async (
    artifact: RemoteArtifact,
    data: Buffer,
    alreadyPersisted = false,
  ) => {
    const safeName = safeFileName(artifact.filename, `artifact-${artifact.id}`);
    const channel = bakeArtifactChannel(artifact.filename, job.settings.normalOrientation);
    if (!channel || !job.settings.channels.includes(channel)) {
      if (!alreadyPersisted && !artifact.filename.startsWith('asset_')) {
        await fs.promises.writeFile(path.join(outputDirectory, safeName), data);
      }
      return;
    }
    const localPath = job.outputPaths[channel];
    if (!alreadyPersisted) await fs.promises.writeFile(localPath, data);
    const dimensions = pngSize(localPath);
    if (
      dimensions.width !== job.settings.resolution ||
      dimensions.height !== job.settings.resolution
    ) {
      throw new Error(
        `${artifact.filename} 尺寸为 ${dimensions.width}x${dimensions.height}，预期 ${job.settings.resolution}x${job.settings.resolution}。`,
      );
    }
    outputs[channel] = {
      fileName: path.basename(localPath),
      ...dimensions,
      url: `/api/bake/jobs/${job.id}/output/${channel}`,
    };
  };
  let completedDownloads = 0;
  const recordCompletedDownload = () => {
    completedDownloads += 1;
    job.progress = Math.max(
      job.progress,
      95 + Math.floor((completedDownloads / Math.max(1, artifactsToDownload.length)) * 2),
    );
    if (job.remote) {
      job.remote.stageMessage = `正在下载所需产物 ${completedDownloads}/${artifactsToDownload.length}`;
    }
    persist(job);
  };
  if (job.remote) {
    job.remote.stage = 'downloading-artifacts';
    job.remote.stageMessage = `正在下载所需产物 0/${artifactsToDownload.length}`;
  }
  persist(job);
  await mapWithConcurrency(
    artifactsToDownload,
    artifactDownloadConcurrency,
    async (artifact) => {
      const safeName = safeFileName(artifact.filename, `artifact-${artifact.id}`);
      const cachedChannel = bakeArtifactChannel(
        artifact.filename,
        job.settings.normalOrientation,
      );
      const cachedPath =
        cachedChannel && job.settings.channels.includes(cachedChannel)
          ? job.outputPaths[cachedChannel]
          : path.join(outputDirectory, safeName);
      if (fs.existsSync(cachedPath) && fs.statSync(cachedPath).size === artifact.size_bytes) {
        const cachedData = await fs.promises.readFile(cachedPath);
        const cachedSha = createHash('sha256').update(cachedData).digest('hex');
        if (cachedSha === artifact.sha256.toLowerCase()) {
          await saveDownloadedArtifact(artifact, cachedData, true);
          recordCompletedDownload();
          return;
        }
      }
      const response = await requestRemote(artifact.download_url, {
        timeoutMs: 300_000,
        maxBytes: 512 * 1024 * 1024,
        headers: { accept: artifact.content_type || 'application/octet-stream' },
      });
      ensureRemoteSuccess(response);
      const declaredSha = artifact.sha256.toLowerCase();
      const headerValue = response.headers['x-artifact-sha256'];
      const headerSha = (
        Array.isArray(headerValue) ? headerValue[0] : (headerValue ?? '')
      ).toLowerCase();
      const actualSha = createHash('sha256').update(response.body).digest('hex');
      if (!/^[a-f0-9]{64}$/.test(declaredSha)) {
        throw new Error(`${artifact.filename} 的远端 SHA-256 格式无效。`);
      }
      if ((headerSha && headerSha !== declaredSha) || actualSha !== declaredSha) {
        throw new Error(`${artifact.filename} 的 SHA-256 校验失败。`);
      }
      if (response.body.length !== artifact.size_bytes) {
        throw new Error(`${artifact.filename} 的下载尺寸与 artifacts 清单不一致。`);
      }
      await saveDownloadedArtifact(artifact, response.body);
      recordCompletedDownload();
    },
  );

  if (job.settings.generateRoughnessFromBakedBaseColor) {
    const bakedBaseColorPath = job.outputPaths.baseColor;
    if (!outputs.baseColor || !fs.existsSync(bakedBaseColorPath)) {
      throw new Error('自动生成 Roughness 需要烘焙后的 Base Color，但该产物不存在。');
    }
    job.progress = 98;
    if (job.remote) {
      job.remote.stage = 'generating-roughness';
      job.remote.stageMessage = '正在用烘焙后的 Base Color 生成最终 Roughness';
    }
    appendLog(job, '[ComfyUI] 正在提交烘焙后的 Base Color 生成最终 Roughness。');
    persist(job);

    const roughnessResult = await generateRemoteRoughness(
      {
        fileName: path.basename(bakedBaseColorPath),
        data: fs.readFileSync(bakedBaseColorPath),
      },
      `baked_roughness_${job.id}`,
    );
    if (!roughnessResult.contentType.toLowerCase().startsWith('image/png')) {
      throw new Error(
        `Roughness 服务返回 ${roughnessResult.contentType}，最终烘焙产物必须是 PNG。`,
      );
    }
    const finalRoughnessPath = job.outputPaths.roughness;
    fs.writeFileSync(finalRoughnessPath, roughnessResult.data);
    const roughnessDimensions = pngSize(finalRoughnessPath);
    if (
      roughnessDimensions.width !== job.settings.resolution ||
      roughnessDimensions.height !== job.settings.resolution
    ) {
      throw new Error(
        `ComfyUI Roughness 尺寸为 ${roughnessDimensions.width}x${roughnessDimensions.height}，预期 ${job.settings.resolution}x${job.settings.resolution}。`,
      );
    }
    outputs.roughness = {
      fileName: path.basename(finalRoughnessPath),
      ...roughnessDimensions,
      url: `/api/bake/jobs/${job.id}/output/roughness`,
    };
    if (job.remote) {
      job.remote.stage = 'roughness-finished';
      job.remote.stageMessage = '最终 Roughness 已生成';
    }
    appendLog(
      job,
      `[ComfyUI] 最终 Roughness 已生成${
        roughnessResult.jobId ? `，GPU 任务 ${roughnessResult.jobId}` : ''
      }。`,
    );
  }

  job.outputs = outputs;
  job.output = outputs.normal;
  job.status = 'succeeded';
  job.stage = 'finished';
  job.progress = 100;
  job.finishedAt = new Date().toISOString();
  job.error = undefined;
  persist(job);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function monitorRemoteJob(job: InternalJob) {
  if (!job.remote || monitors.has(job.id)) return;
  monitors.add(job.id);
  let consecutivePollErrors = 0;
  let consecutivePostprocessErrors = 0;
  try {
    while (job.remote && !['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      try {
        const response = await requestRemote(job.remote.statusUrl, { timeoutMs: 30_000 });
        ensureRemoteSuccess(response);
        const payload = parseJson<RemoteJobPayload>(response);
        if (payload.job_id !== job.remote.jobId) {
          throw new Error('远端状态响应的 job_id 与提交响应不一致。');
        }
        consecutivePollErrors = 0;
        applyRemoteStatus(job, payload);
        if (payload.status === 'SUCCEEDED') {
          try {
            await downloadArtifacts(job, payload);
            return;
          } catch (error) {
            consecutivePostprocessErrors += 1;
            const message = error instanceof Error ? error.message : String(error);
            appendLog(
              job,
              `[Postprocess] 后处理失败（${consecutivePostprocessErrors}/3）：${message}`,
            );
            const permanentClientError =
              error instanceof BakeRequestError &&
              error.httpStatus >= 400 &&
              error.httpStatus < 500;
            if (permanentClientError || consecutivePostprocessErrors >= 3) throw error;
          }
        } else {
          consecutivePostprocessErrors = 0;
        }
        if (payload.status === 'FAILED' || payload.status === 'CANCELLED') return;
      } catch (error) {
        if (job.remote?.status === 'SUCCEEDED') throw error;
        consecutivePollErrors += 1;
        appendLog(
          job,
          `[Remote] 状态同步失败（${consecutivePollErrors}/10）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (consecutivePollErrors >= 10) throw error;
      }
      await delay(3000);
    }
  } catch (error) {
    job.status = 'failed';
    job.stage = 'finished';
    job.error = error instanceof Error ? error.message : '远端 Substance Baker 状态同步失败。';
    job.finishedAt = new Date().toISOString();
    appendLog(job, `[Remote] ${job.error}`);
  } finally {
    monitors.delete(job.id);
  }
}

function internalJobFromPersisted(job: NormalBakeJob) {
  const directory = path.join(serverConfig.workspaceDir, 'bake-jobs', job.id);
  return { ...job, directory, outputPaths: outputPaths(directory) } satisfies InternalJob;
}

function loadJob(id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return undefined;
  const persistedPath = path.join(serverConfig.workspaceDir, 'bake-jobs', id, 'job.json');
  if (!fs.existsSync(persistedPath)) return undefined;
  try {
    const job = internalJobFromPersisted(
      JSON.parse(fs.readFileSync(persistedPath, 'utf8')) as NormalBakeJob,
    );
    jobs.set(id, job);
    return job;
  } catch {
    return undefined;
  }
}

function resumePrematurelyCancelledRemoteJob(job: InternalJob) {
  if (
    job.status !== 'cancelled' ||
    !job.remote ||
    job.remote.status === 'CANCELLED' ||
    job.outputs
  ) {
    return false;
  }
  job.status = 'queued';
  job.stage = 'waiting-for-worker';
  job.finishedAt = undefined;
  job.error = undefined;
  appendLog(job, '[Remote] 恢复此前被过早终止的远端任务状态同步。');
  return true;
}

export async function generateRemoteRoughness(input: BakeUpload, idempotencyKey?: string) {
  validateBakeUpload(input, 'Base Color', 'image');
  const sourceMetadata = await sharp(input.data).metadata();
  const sourceWidth = sourceMetadata.width;
  const sourceHeight = sourceMetadata.height;
  if (!sourceWidth || !sourceHeight) {
    throw new BakeRequestError('Base Color 图像尺寸无效。');
  }

  const serviceMaxDimension = 2048;
  const needsServiceResize =
    Math.max(sourceWidth, sourceHeight) > serviceMaxDimension ||
    input.data.length > 60 * 1024 * 1024;
  const serviceData = needsServiceResize
    ? await sharp(input.data)
        .resize({
          width: serviceMaxDimension,
          height: serviceMaxDimension,
          fit: 'inside',
          withoutEnlargement: true,
          kernel: sharp.kernel.lanczos3,
        })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer()
    : input.data;
  const serviceHash = createHash('sha256').update(serviceData).digest('hex').slice(0, 16);
  const stableKey = idempotencyKey?.trim()
    ? `${idempotencyKey.trim().slice(0, 80)}_${serviceHash}`
    : `roughness_${serviceHash}`;
  const boundary = `----liclick-roughness-${randomUUID()}`;
  const bodyChunks = [
    multipartFileHeader(boundary, 'image', safeFileName(input.fileName, 'basecolor.png')),
    serviceData,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  const response = await requestRemote('/api/v1/services/modelview-roughness', {
    method: 'POST',
    timeoutMs: 1_900_000,
    maxBytes: 128 * 1024 * 1024,
    headers: {
      accept: 'image/*',
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(bodyChunks.reduce((total, chunk) => total + chunk.length, 0)),
      'idempotency-key': stableKey,
    },
    bodyChunks,
  });
  ensureRemoteSuccess(response);
  const contentTypeValue = response.headers['content-type'];
  const contentType = Array.isArray(contentTypeValue)
    ? contentTypeValue[0]
    : (contentTypeValue ?? 'application/octet-stream');
  if (!contentType.toLowerCase().startsWith('image/') || looksLikeHtml(response.body)) {
    throw new BakeRequestError('粗糙度服务返回的不是有效图片。', 502);
  }
  const resultMetadata = await sharp(response.body).metadata();
  const shouldRestoreSourceSize =
    resultMetadata.width !== sourceWidth || resultMetadata.height !== sourceHeight;
  const resultData = shouldRestoreSourceSize
    ? await sharp(response.body)
        .resize({
          width: sourceWidth,
          height: sourceHeight,
          fit: 'fill',
          kernel: sharp.kernel.lanczos3,
        })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer()
    : response.body;
  const jobIdValue = response.headers['x-job-id'];
  return {
    data: resultData,
    contentType: shouldRestoreSourceSize ? 'image/png' : contentType,
    jobId: Array.isArray(jobIdValue) ? jobIdValue[0] : jobIdValue,
    resizedForService: needsServiceResize,
  };
}

export async function createNormalBakeJob(input: {
  userId: string;
  projectId: string;
  objectId: string;
  settings: NormalBakeSettings;
  high: BakeUpload;
  low: BakeUpload;
  cage?: BakeUpload;
  color?: BakeUpload;
  roughness?: BakeUpload;
  metallic?: BakeUpload;
}) {
  const ownerUserId = input.userId.trim();
  if (!ownerUserId) throw new BakeRequestError('Authenticated user id is required.');
  validateBakeUpload(input.high, '高模', 'model');
  validateBakeUpload(input.low, '低模', 'model');
  if (input.cage) validateBakeUpload(input.cage, 'Cage', 'model');
  if (input.color) validateBakeUpload(input.color, 'Base Color', 'image');
  if (input.roughness) validateBakeUpload(input.roughness, 'Roughness', 'image');
  if (input.metallic) validateBakeUpload(input.metallic, 'Metallic', 'image');
  const { settings, profile, textureCacheMb } = validateSettings(input.settings);
  const colorUpload =
    profile === 'li3d-pbr-full-v2' ? (input.color ?? neutralMaterialUpload('color')) : input.color;
  const roughnessUpload =
    profile === 'li3d-pbr-full-v2'
      ? (input.roughness ?? neutralMaterialUpload('roughness'))
      : input.roughness;
  const metallicUpload =
    profile === 'li3d-pbr-full-v2'
      ? (input.metallic ?? neutralMaterialUpload('metallic'))
      : input.metallic;
  if (settings.projectionMode === 'cage' && !input.cage) {
    throw new BakeRequestError('Cage 模式需要上传 Cage 模型。');
  }

  const id = `bake_${randomUUID()}`;
  const directory = path.join(serverConfig.workspaceDir, 'bake-jobs', id);
  const now = new Date().toISOString();
  const usedInputNames = new Set<string>();
  const highName = uniqueInputFileName(input.high.fileName, 'high_mesh.fbx', usedInputNames);
  const lowName = uniqueInputFileName(input.low.fileName, 'low_mesh.fbx', usedInputNames);
  const cageName = input.cage
    ? uniqueInputFileName(input.cage.fileName, 'cage_mesh.fbx', usedInputNames)
    : undefined;
  const colorName = colorUpload
    ? uniqueInputFileName(colorUpload.fileName, 'base_color_texture.png', usedInputNames)
    : undefined;
  const roughnessName = roughnessUpload
    ? uniqueInputFileName(
        roughnessUpload.fileName,
        'roughness_texture.png',
        usedInputNames,
      )
    : undefined;
  const metallicName = metallicUpload
    ? uniqueInputFileName(metallicUpload.fileName, 'metallic_texture.png', usedInputNames)
    : undefined;
  const statusUrl = `/api/v1/assets/jobs/pending`;
  const job: InternalJob = {
    id,
    ownerUserId,
    kind: 'bake-maps',
    projectId: input.projectId,
    objectId: input.objectId,
    status: 'queued',
    stage: 'waiting-for-worker',
    progress: 0,
    settings,
    input: {
      high: highName,
      low: lowName,
      ...(cageName ? { cage: cageName } : {}),
      ...(colorName ? { color: colorName } : {}),
      ...(roughnessName ? { roughness: roughnessName } : {}),
      ...(metallicName ? { metallic: metallicName } : {}),
    },
    displayInput: {
      high: displayFilename(input.high.fileName, 'high.fbx'),
      low: displayFilename(input.low.fileName, 'low.fbx'),
      ...(input.cage
        ? { cage: displayFilename(input.cage.fileName, 'cage.fbx') }
        : {}),
      ...(input.color
        ? { color: displayFilename(input.color.fileName, 'base_color.png') }
        : {}),
      ...(input.roughness
        ? { roughness: displayFilename(input.roughness.fileName, 'roughness.png') }
        : {}),
      ...(input.metallic
        ? { metallic: displayFilename(input.metallic.fileName, 'metallic.png') }
        : {}),
    },
    logs: [],
    createdAt: now,
    updatedAt: now,
    directory,
    outputPaths: outputPaths(directory),
    remote: {
      jobId: 'pending',
      profile,
      statusUrl,
    },
  };
  jobs.set(id, job);
  persist(job);

  const boundary = `----liclick-substance-${randomUUID()}`;
  const metadata = JSON.stringify({
    external_asset_id: id,
    options: {
      profile,
      resolution: settings.resolution,
      texture_cache_mb: textureCacheMb,
    },
  });
  const bodyChunks = buildMultipart({
    boundary,
    low: { ...input.low, fileName: lowName },
    high:
      profile === 'ao-self-v1' ? undefined : { ...input.high, fileName: highName },
    cage: renamedUpload(input.cage, cageName),
    color:
      profile === 'li3d-pbr-full-v2'
        ? renamedUpload(colorUpload, colorName)
        : undefined,
    roughness:
      profile === 'li3d-pbr-full-v2'
        ? renamedUpload(roughnessUpload, roughnessName)
        : undefined,
    metallic:
      profile === 'li3d-pbr-full-v2'
        ? renamedUpload(metallicUpload, metallicName)
        : undefined,
    metadata,
  });
  const contentLength = bodyChunks.reduce((total, chunk) => total + chunk.length, 0);
  try {
    const response = await requestRemote('/api/v1/assets/bake/process', {
      method: 'POST',
      timeoutMs: 300_000,
      maxBytes: 8 * 1024 * 1024,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(contentLength),
        'idempotency-key': id,
      },
      bodyChunks,
    });
    ensureRemoteSuccess(response, [200, 202]);
    const payload = parseJson<RemoteJobPayload>(response);
    if (!payload.job_id || !payload.status_url) {
      throw new BakeRequestError('远端提交响应缺少 job_id 或 status_url。', 502);
    }
    job.remote = {
      jobId: payload.job_id,
      profile,
      statusUrl: payload.status_url,
      eventsUrl: payload.events_url,
      cancelUrl: payload.cancel_url,
      status: payload.status,
      workerId: payload.worker_id,
      stage: payload.stage,
      stageMessage: payload.stage_message,
      deliveryReady: payload.delivery_ready,
      timing: payload.timing,
    };
    applyRemoteStatus(job, payload);
    appendLog(job, `[Remote] 已提交 ${profile}，远端任务 ${payload.job_id}。`);
    void monitorRemoteJob(job);
    return publicJob(job);
  } catch (error) {
    job.status = 'failed';
    job.stage = 'finished';
    job.error = error instanceof Error ? error.message : '提交远端 Substance Baker 失败。';
    job.finishedAt = new Date().toISOString();
    appendLog(job, `[Remote] ${job.error}`);
    throw error;
  }
}

export function getNormalBakeJob(id: string, userId: string) {
  const job = jobs.get(id) ?? loadJob(id);
  if (!job || job.ownerUserId !== userId) return undefined;
  resumePrematurelyCancelledRemoteJob(job);
  if (!['succeeded', 'failed', 'cancelled'].includes(job.status)) void monitorRemoteJob(job);
  return publicJob(job);
}

export function listNormalBakeJobs(userId: string, limit = 30) {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) return [];
  const jobsDirectory = path.join(serverConfig.workspaceDir, 'bake-jobs');
  if (!fs.existsSync(jobsDirectory)) return [];

  const candidates: NormalBakeJob[] = [];
  for (const entry of fs.readdirSync(jobsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
    const job = getNormalBakeJob(entry.name, normalizedUserId);
    // Missing owner ids deliberately remain orphaned. Never infer ownership
    // from a project name or expose an old job to the current employee.
    if (job) candidates.push(job);
  }

  return candidates
    .sort((left, right) => {
      const timeDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      return Number.isFinite(timeDelta) && timeDelta !== 0
        ? timeDelta
        : right.id.localeCompare(left.id);
    })
    .slice(0, Math.min(100, Math.max(1, Math.trunc(limit) || 30)));
}

export async function recoverNormalBakeJobArtifacts(id: string) {
  const job = jobs.get(id) ?? loadJob(id);
  if (!job?.remote) throw new BakeRequestError('Bake job or its remote task was not found.', 404);
  const response = await requestRemote(job.remote.statusUrl, { timeoutMs: 30_000 });
  ensureRemoteSuccess(response);
  const payload = parseJson<RemoteJobPayload>(response);
  if (payload.job_id !== job.remote.jobId) {
    throw new BakeRequestError('远端状态响应的 job_id 与本地任务不一致。', 502);
  }
  if (payload.status !== 'SUCCEEDED') {
    throw new BakeRequestError(`远端任务尚未完成（${payload.status ?? 'UNKNOWN'}）。`, 409);
  }
  applyRemoteStatus(job, payload);
  await downloadArtifacts(job, payload);
  return publicJob(job);
}

export function getNormalBakeOutputPath(
  id: string,
  userId: string,
  channel: BakeChannelId = 'normal',
) {
  const job = jobs.get(id) ?? loadJob(id);
  if (
    !job ||
    job.ownerUserId !== userId ||
    job.status !== 'succeeded' ||
    !job.settings.channels.includes(channel)
  ) {
    return undefined;
  }
  const outputPath = job.outputPaths[channel];
  return fs.existsSync(outputPath) ? outputPath : undefined;
}

export async function cancelNormalBakeJob(id: string, userId: string) {
  const job = jobs.get(id) ?? loadJob(id);
  if (!job || job.ownerUserId !== userId) return undefined;
  if (!job.remote?.cancelUrl || ['succeeded', 'failed', 'cancelled'].includes(job.status)) {
    return publicJob(job);
  }
  const response = await requestRemote(job.remote.cancelUrl, {
    method: 'POST',
    timeoutMs: 30_000,
  });
  ensureRemoteSuccess(response);
  applyRemoteStatus(job, parseJson<RemoteJobPayload>(response));
  return publicJob(job);
}

export async function getSubstanceBakerStatus() {
  const endpoint = serverConfig.substanceBakerBaseUrl;
  try {
    const trust = remoteTrust();
    const response = await requestRemote('/api/v1/assets/jobs/liclick-connection-probe', {
      timeoutMs: 5000,
      maxBytes: 1024 * 1024,
    });
    const connected = response.statusCode > 0 && response.statusCode < 500;
    const authorized = ![401, 403].includes(response.statusCode);
    return {
      available: connected && authorized,
      connected,
      endpoint,
      workerId: 'asset-worker-3090-b-windows',
      tlsVerified: true,
      trustSource: trust.source,
      ...(trust.caPath ? { caPath: trust.caPath } : {}),
      ...(connected && authorized ? {} : { error: remoteErrorMessage(response) }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法连接远端 Substance Baker。';
    const certificateError = /certificate|self[- ]signed|unable to verify|issuer|ca\b/i.test(
      message,
    );
    return {
      available: false,
      connected: false,
      endpoint,
      tlsVerified: false,
      error: certificateError
        ? `${message} 请安装 GPU_CONTROL_LAN_CA.crt 到系统信任库，或配置 LICLICK_SUBSTANCE_BAKER_CA_PATH。`
        : message,
    };
  }
}

export function bakeRequestErrorStatus(error: unknown) {
  return error instanceof BakeRequestError ? error.httpStatus : 500;
}
