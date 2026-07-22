import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { serverConfig } from '../config.js';

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

const bakeChannelDefinitions: Record<
  BakeChannelId,
  { command: string; outputName: string; fileName: string }
> = {
  baseColor: {
    command: 'TextureTransfer.Raytraced',
    outputName: 'basecolor',
    fileName: 'basecolor.png',
  },
  normal: { command: 'Normal.Raytraced', outputName: 'normal', fileName: 'normal.png' },
  ambientOcclusion: {
    command: 'AmbientOcclusion.Raytraced',
    outputName: 'ao',
    fileName: 'ao.png',
  },
  curvature: {
    command: 'Curvature.Raytraced',
    outputName: 'curvature',
    fileName: 'curvature.png',
  },
  worldNormal: {
    command: 'Normal.Raytraced',
    outputName: 'world_normal',
    fileName: 'world_normal.png',
  },
  thickness: {
    command: 'Thickness.Raytraced',
    outputName: 'thickness',
    fileName: 'thickness.png',
  },
  position: {
    command: 'Position.Raytraced',
    outputName: 'position',
    fileName: 'position.png',
  },
  roughness: {
    command: 'TextureTransfer.Raytraced',
    outputName: 'roughness',
    fileName: 'roughness.png',
  },
  metallic: {
    command: 'TextureTransfer.Raytraced',
    outputName: 'metallic',
    fileName: 'metallic.png',
  },
};

export type NormalBakeSettings = {
  resolution: 1024 | 2048 | 4096 | 8192;
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
  channels: BakeChannelId[];
};

export type BakeUpload = { fileName: string; data: Buffer };

export type NormalBakeJob = {
  id: string;
  kind: 'bake-maps';
  projectId: string;
  objectId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  stage: 'waiting-for-worker' | 'baking-maps' | 'verifying-file' | 'finished';
  progress: number;
  settings: NormalBakeSettings;
  input: {
    high: string;
    low: string;
    cage?: string;
    color?: string;
    roughness?: string;
    metallic?: string;
  };
  output?: { fileName: string; width: number; height: number; url: string };
  outputs?: Partial<
    Record<BakeChannelId, { fileName: string; width: number; height: number; url: string }>
  >;
  error?: string;
  logs: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
};

type InternalJob = NormalBakeJob & {
  directory: string;
  highPath: string;
  lowPath: string;
  cagePath?: string;
  colorPath?: string;
  roughnessPath?: string;
  metallicPath?: string;
  outputPaths: Record<BakeChannelId, string>;
};

const jobs = new Map<string, InternalJob>();
const processes = new Map<string, ChildProcessWithoutNullStreams>();
const maxLogLines = 400;

function locateBaker() {
  const configured = process.env.LICLICK_SUBSTANCE_BAKER_PATH?.trim();
  const candidates = [
    configured,
    process.platform === 'win32'
      ? 'C:\\Program Files\\Adobe\\Adobe Substance 3D Designer\\substance3d_baker.exe'
      : undefined,
    'substance3d_baker',
  ].filter((value): value is string => Boolean(value));
  return candidates.find(
    (candidate) => candidate === 'substance3d_baker' || fs.existsSync(candidate),
  );
}

function publicJob(job: InternalJob): NormalBakeJob {
  const result: Partial<InternalJob> = { ...job };
  delete result.directory;
  delete result.highPath;
  delete result.lowPath;
  delete result.cagePath;
  delete result.colorPath;
  delete result.roughnessPath;
  delete result.metallicPath;
  delete result.outputPaths;
  return result as NormalBakeJob;
}

function persist(job: InternalJob) {
  job.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(job.directory, 'job.json'), JSON.stringify(publicJob(job), null, 2));
}

function appendLog(job: InternalJob, chunk: Buffer | string) {
  const lines = String(chunk)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  job.logs.push(...lines);
  if (job.logs.length > maxLogLines) job.logs.splice(0, job.logs.length - maxLogLines);
  persist(job);
}

function safeFileName(value: string, fallback: string) {
  const base = path.basename(value).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base || fallback;
}

function looksLikeHtml(data: Buffer) {
  const prefix = data.subarray(0, 1024).toString('utf8').trimStart().toLowerCase();
  return prefix.startsWith('<!doctype html') || prefix.startsWith('<html');
}

function validateBakeUpload(upload: BakeUpload, label: string, kind: 'model' | 'image') {
  if (upload.data.length < 16) throw new Error(`${label} 文件为空或已损坏，请重新导入。`);
  if (looksLikeHtml(upload.data)) {
    throw new Error(`${label} 读取到了网页而不是资源文件，请刷新页面后重新导入。`);
  }
  if (kind !== 'image') return;
  const extension = path.extname(upload.fileName).toLowerCase();
  const isPng = upload.data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = upload.data[0] === 0xff && upload.data[1] === 0xd8 && upload.data[2] === 0xff;
  const isWebp =
    upload.data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    upload.data.subarray(8, 12).toString('ascii') === 'WEBP';
  const valid =
    (extension === '.png' && isPng) ||
    ((extension === '.jpg' || extension === '.jpeg') && isJpeg) ||
    (extension === '.webp' && isWebp) ||
    extension === '.tga';
  if (!valid) throw new Error(`${label} 不是有效的 PNG、JPG、WebP 或 TGA 图片。`);
}

function validateSettings(input: NormalBakeSettings): NormalBakeSettings {
  const resolutions = new Set([1024, 2048, 4096, 8192]);
  const samplings = new Set(['1x1', '2x2', '4x4', '8x8']);
  if (!resolutions.has(input.resolution)) throw new Error('Unsupported bake resolution.');
  if (!samplings.has(input.sampling)) throw new Error('Unsupported sampling rate.');
  if (!Number.isInteger(input.padding) || input.padding < 0 || input.padding > 256)
    throw new Error('Invalid padding.');
  if (!Number.isInteger(input.udim) || input.udim < 1001 || input.udim > 9999)
    throw new Error('Invalid UDIM.');
  const normalOrientation = input.normalOrientation === 'opengl' ? 'opengl' : 'directx';
  if (
    !Number.isFinite(input.frontalDistance) ||
    input.frontalDistance < 0 ||
    input.frontalDistance > 10
  )
    throw new Error('Invalid frontal distance.');
  if (!Number.isFinite(input.rearDistance) || input.rearDistance < 0 || input.rearDistance > 10)
    throw new Error('Invalid rear distance.');
  const validChannels = new Set<BakeChannelId>(
    Object.keys(bakeChannelDefinitions) as BakeChannelId[],
  );
  const channels = Array.from(
    new Set(input.channels?.filter((channel) => validChannels.has(channel)) ?? []),
  );
  if (channels.length === 0) throw new Error('Select at least one bake channel.');
  return { ...input, normalOrientation, channels };
}

function pngSize(filePath: string) {
  const header = Buffer.alloc(24);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length)
      throw new Error('Normal output is truncated.');
  } finally {
    fs.closeSync(descriptor);
  }
  if (!header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('Normal output is not a readable PNG.');
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function buildArguments(job: InternalJob, channel: BakeChannelId) {
  const settings = job.settings;
  const sampling = settings.sampling === '1x1' ? 'none' : settings.sampling;
  const definition = bakeChannelDefinitions[channel];
  const args = [
    '--verbose',
    definition.command,
    '--inputs',
    job.lowPath,
    '--high_scene_paths',
    job.highPath,
    '--output_path',
    path.dirname(job.outputPaths[channel]),
    '--output_name',
    definition.outputName,
    '--output_format',
    'png',
    '--output_size',
    `${settings.resolution},${settings.resolution}`,
    '--padding_radius',
    String(settings.padding),
    '--base.uv_set',
    '0',
    '--udim',
    String(settings.udim),
    '--projection.max_depth',
    String(settings.rearDistance),
    '--projection.max_height',
    String(settings.frontalDistance),
    '--projection.normalized_distance',
    'true',
    '--projection.cull_backfaces',
    String(settings.ignoreBackfaces),
    '--projection.hit_strategy',
    settings.hitStrategy === 'closest-from-source' ? 'closest_from_source' : 'inward',
    '--projection.smooth_normals',
    'true',
    '--projection.mesh_match_mode',
    settings.matchMode === 'by-name' ? 'match_mesh_name' : 'match_all',
    '--projection.sampling_rate',
    sampling,
    '--recompute_tangents',
    'true',
    '--enable_mip_diffusion',
    'true',
  ];
  if (channel === 'baseColor' || channel === 'roughness' || channel === 'metallic') {
    const sourcePath =
      channel === 'baseColor'
        ? job.colorPath
        : channel === 'roughness'
          ? job.roughnessPath
          : job.metallicPath;
    if (!sourcePath) throw new Error(`${channel} bake requires a matching high-poly texture.`);
    args.push(
      '--source_texture_path',
      sourcePath,
      '--highpoly_uv_set',
      '0',
      '--filtering_mode',
      'bilinear',
    );
  }
  if (channel === 'normal') {
    args.push(
      '--output_texture_orientation',
      settings.normalOrientation,
      '--output_texture_space',
      'tangent_space',
    );
  }
  if (channel === 'worldNormal') {
    args.push('--output_texture_orientation', 'opengl', '--output_texture_space', 'world_space');
  }
  if (channel === 'position') {
    args.push(
      '--mode',
      'all_axes',
      '--normalization',
      'bbox',
      '--normalization_scale',
      'full_scene',
    );
  }
  if (settings.device === 'cpu') args.push('--cpu');
  if (settings.projectionMode === 'cage') {
    if (!job.cagePath) throw new Error('Cage mode requires a cage file.');
    args.push('--use_cage', 'true', '--cage_scene_path', job.cagePath);
  }
  return args;
}

async function runJob(job: InternalJob) {
  const baker = locateBaker();
  job.startedAt = new Date().toISOString();
  if (!baker) {
    job.status = 'failed';
    job.stage = 'finished';
    job.error = '未找到 Substance 3D Designer 命令行 Baker。';
    job.finishedAt = new Date().toISOString();
    persist(job);
    return;
  }
  try {
    job.status = 'running';
    job.stage = 'baking-maps';
    job.progress = 10;
    const outputs: NonNullable<NormalBakeJob['outputs']> = {};
    for (let index = 0; index < job.settings.channels.length; index += 1) {
      const channel = job.settings.channels[index];
      const args = buildArguments(job, channel);
      appendLog(job, `[LI3D] ${channel} · ${path.basename(baker)} ${args.join(' ')}`);
      const child = spawn(baker, args, { cwd: job.directory, windowsHide: true });
      processes.set(job.id, child);
      child.stdout.on('data', (chunk: Buffer) => appendLog(job, chunk));
      child.stderr.on('data', (chunk: Buffer) => appendLog(job, chunk));
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? -1));
      });
      processes.delete(job.id);
      const outputPath = job.outputPaths[channel];
      if (!fs.existsSync(outputPath)) {
        const bakerError = [...job.logs]
          .reverse()
          .find((line) => line.includes('[ERROR]'))
          ?.replace(/^.*?\[ERROR\]/, '')
          .trim();
        throw new Error(
          bakerError
            ? `Substance ${channel} 烘焙失败：${bakerError}`
            : `Substance 未生成 ${path.basename(outputPath)}，请检查模型匹配和输入贴图。`,
        );
      }
      const dimensions = pngSize(outputPath);
      if (
        dimensions.width !== job.settings.resolution ||
        dimensions.height !== job.settings.resolution
      ) {
        throw new Error(
          `${channel} output size is ${dimensions.width}x${dimensions.height}, expected ${job.settings.resolution}x${job.settings.resolution}.`,
        );
      }
      if (exitCode !== 0)
        appendLog(
          job,
          `[LI3D] ${channel} baker returned ${exitCode}, but the PNG passed validation; keeping the valid result.`,
        );
      outputs[channel] = {
        fileName: path.basename(outputPath),
        ...dimensions,
        url: `/api/bake/jobs/${job.id}/output/${channel}`,
      };
      job.progress = 10 + Math.round(((index + 1) / job.settings.channels.length) * 75);
      persist(job);
    }
    job.stage = 'verifying-file';
    job.progress = 90;
    persist(job);
    job.outputs = outputs;
    job.output = outputs.normal;
    job.status = 'succeeded';
    job.stage = 'finished';
    job.progress = 100;
    job.finishedAt = new Date().toISOString();
    persist(job);
  } catch (error) {
    processes.delete(job.id);
    job.status = 'failed';
    job.stage = 'finished';
    job.error = error instanceof Error ? error.message : 'Normal bake failed.';
    job.finishedAt = new Date().toISOString();
    appendLog(job, `[LI3D] ${job.error}`);
  }
}

export function createNormalBakeJob(input: {
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
  validateBakeUpload(input.high, '高模', 'model');
  validateBakeUpload(input.low, '低模', 'model');
  if (input.cage) validateBakeUpload(input.cage, 'Cage', 'model');
  if (input.color) validateBakeUpload(input.color, '颜色贴图', 'image');
  if (input.roughness) validateBakeUpload(input.roughness, 'Roughness', 'image');
  if (input.metallic) validateBakeUpload(input.metallic, 'Metallic', 'image');
  const id = `bake_${randomUUID()}`;
  const directory = path.join(serverConfig.workspaceDir, 'bake-jobs', id);
  const inputDirectory = path.join(directory, 'input');
  const outputDirectory = path.join(directory, 'output');
  fs.mkdirSync(inputDirectory, { recursive: true });
  fs.mkdirSync(outputDirectory, { recursive: true });
  const highName = safeFileName(input.high.fileName, 'high.fbx');
  const lowName = safeFileName(input.low.fileName, 'low.fbx');
  const cageName = input.cage ? safeFileName(input.cage.fileName, 'cage.fbx') : undefined;
  const colorName = input.color ? safeFileName(input.color.fileName, 'high-color.png') : undefined;
  const roughnessName = input.roughness
    ? safeFileName(input.roughness.fileName, 'high-roughness.png')
    : undefined;
  const metallicName = input.metallic
    ? safeFileName(input.metallic.fileName, 'high-metallic.png')
    : undefined;
  const highPath = path.join(inputDirectory, `high-${highName}`);
  const lowPath = path.join(inputDirectory, `low-${lowName}`);
  const cagePath = cageName ? path.join(inputDirectory, `cage-${cageName}`) : undefined;
  const colorPath = colorName ? path.join(inputDirectory, `color-${colorName}`) : undefined;
  const roughnessPath = roughnessName
    ? path.join(inputDirectory, `roughness-${roughnessName}`)
    : undefined;
  const metallicPath = metallicName
    ? path.join(inputDirectory, `metallic-${metallicName}`)
    : undefined;
  fs.writeFileSync(highPath, input.high.data);
  fs.writeFileSync(lowPath, input.low.data);
  if (input.cage && cagePath) fs.writeFileSync(cagePath, input.cage.data);
  if (input.color && colorPath) fs.writeFileSync(colorPath, input.color.data);
  if (input.roughness && roughnessPath) fs.writeFileSync(roughnessPath, input.roughness.data);
  if (input.metallic && metallicPath) fs.writeFileSync(metallicPath, input.metallic.data);
  const settings = validateSettings(input.settings);
  if (settings.channels.includes('baseColor') && !colorPath)
    throw new Error('Base Color bake requires a high-poly color image.');
  if (settings.channels.includes('roughness') && !roughnessPath)
    throw new Error('Roughness bake requires a high-poly roughness image.');
  if (settings.channels.includes('metallic') && !metallicPath)
    throw new Error('Metallic bake requires a high-poly metallic image.');
  const now = new Date().toISOString();
  const job: InternalJob = {
    id,
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
    logs: [],
    createdAt: now,
    updatedAt: now,
    directory,
    highPath,
    lowPath,
    cagePath,
    colorPath,
    roughnessPath,
    metallicPath,
    outputPaths: {
      baseColor: path.join(outputDirectory, 'basecolor.png'),
      normal: path.join(outputDirectory, 'normal.png'),
      ambientOcclusion: path.join(outputDirectory, 'ao.png'),
      curvature: path.join(outputDirectory, 'curvature.png'),
      worldNormal: path.join(outputDirectory, 'world_normal.png'),
      thickness: path.join(outputDirectory, 'thickness.png'),
      position: path.join(outputDirectory, 'position.png'),
      roughness: path.join(outputDirectory, 'roughness.png'),
      metallic: path.join(outputDirectory, 'metallic.png'),
    },
  };
  jobs.set(id, job);
  persist(job);
  setImmediate(() => void runJob(job));
  return publicJob(job);
}

export function getNormalBakeJob(id: string) {
  const job = jobs.get(id);
  if (job) return publicJob(job);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return undefined;
  const persistedPath = path.join(serverConfig.workspaceDir, 'bake-jobs', id, 'job.json');
  if (!fs.existsSync(persistedPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(persistedPath, 'utf8')) as NormalBakeJob;
  } catch {
    return undefined;
  }
}

export function getNormalBakeOutputPath(id: string, channel: BakeChannelId = 'normal') {
  const job = jobs.get(id);
  if (job?.status === 'succeeded' && job.settings.channels.includes(channel))
    return job.outputPaths[channel];
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return undefined;
  const persistedOutput = path.join(
    serverConfig.workspaceDir,
    'bake-jobs',
    id,
    'output',
    bakeChannelDefinitions[channel].fileName,
  );
  return fs.existsSync(persistedOutput) ? persistedOutput : undefined;
}

export function getSubstanceBakerStatus() {
  const executablePath = locateBaker();
  if (!executablePath) return { available: false };
  const result = spawnSync(executablePath, ['--version'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    available: result.status === 0,
    executablePath,
    version: (result.stdout || result.stderr || '').trim(),
  };
}
