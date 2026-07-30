import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { serverConfig } from '../config.js';

const supportedExtensions = new Set(['.fbx', '.obj', '.glb', '.gltf', '.blend']);
const maxCapturedProcessOutputBytes = 1024 * 1024;
const maxConcurrentPreparations = 1;

export type RetopologyProjectSourceFiles = {
  highModelPath: string;
  targetFaces?: number;
};

type BlenderInfo = {
  executablePath: string;
  version: string;
};

type ProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
};

export type PreparedRetopologyProject = {
  filePath: string;
  filename: string;
  size: number;
  blender: BlenderInfo;
  cleanup: () => Promise<void>;
};

export class RetopologyPreparationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'RetopologyPreparationError';
  }
}

let activePreparations = 0;
let cachedBlender: BlenderInfo | undefined;

function preparationError(message: string, statusCode = 400) {
  return new RetopologyPreparationError(message, statusCode);
}

function appendCapturedText(current: string, chunk: Buffer | string) {
  if (Buffer.byteLength(current) >= maxCapturedProcessOutputBytes) return current;
  const next = current + chunk.toString();
  if (Buffer.byteLength(next) <= maxCapturedProcessOutputBytes) return next;
  return Buffer.from(next).subarray(0, maxCapturedProcessOutputBytes).toString('utf8');
}

function terminateProcessTree(child: ChildProcess) {
  if (!child.pid || child.killed) return;
  if (process.platform !== 'win32') {
    child.kill('SIGKILL');
    return;
  }

  const killer = spawn(
    'taskkill.exe',
    ['/pid', String(child.pid), '/t', '/f'],
    { shell: false, windowsHide: true, stdio: 'ignore' },
  );
  killer.on('error', () => child.kill('SIGKILL'));
  const fallback = setTimeout(() => child.kill('SIGKILL'), 1_500);
  fallback.unref();
  killer.on('close', () => clearTimeout(fallback));
}

function runProcess(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs: number;
    signal?: AbortSignal;
    environment?: NodeJS.ProcessEnv;
  },
) {
  return new Promise<ProcessResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forcedSettlement: NodeJS.Timeout | undefined;

    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.environment ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forcedSettlement) clearTimeout(forcedSettlement);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted });
    };

    const stop = (reason: 'timeout' | 'abort') => {
      if (settled || timedOut || aborted) return;
      timedOut = reason === 'timeout';
      aborted = reason === 'abort';
      terminateProcessTree(child);
      forcedSettlement = setTimeout(() => finish(null), 5_000);
      forcedSettlement.unref();
    };

    const onAbort = () => stop('abort');
    const timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
    timeout.unref();

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout = appendCapturedText(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = appendCapturedText(stderr, chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forcedSettlement) clearTimeout(forcedSettlement);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', finish);

    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseBlenderVersion(output: string) {
  const match = /\bBlender\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(output);
  if (!match) return undefined;
  return {
    label: `${match[1]}.${match[2]}.${match[3] ?? '0'}`,
    major: Number(match[1]),
    minor: Number(match[2]),
  };
}

function compatibleWithWorker(version: { major: number; minor: number }) {
  return version.major === 4 || (version.major === 5 && version.minor <= 1);
}

async function executableFile(filePath: string) {
  try {
    return (await fs.promises.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function candidateScore(filePath: string) {
  const match = /Blender[ /\\]+(\d+)\.(\d+)/i.exec(filePath);
  if (!match) return 0;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 5 && minor === 1) return 1_000_000;
  if (major === 4 || (major === 5 && minor <= 1)) return 500_000 + major * 1_000 + minor;
  return major * 1_000 + minor;
}

async function automaticBlenderCandidates() {
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const programRoots = [
      process.env.ProgramFiles,
      process.env['ProgramW6432'],
      'C:\\Program Files',
    ].filter((value): value is string => Boolean(value));
    for (const programRoot of programRoots) {
      const foundationRoot = path.join(programRoot, 'Blender Foundation');
      try {
        const entries = await fs.promises.readdir(foundationRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || !/^Blender(?:\s+\d+(?:\.\d+)*)?$/i.test(entry.name)) continue;
          candidates.push(path.join(foundationRoot, entry.name, 'blender.exe'));
        }
      } catch {
        // Blender is not installed in this standard root.
      }
    }
  } else {
    candidates.push(
      '/Applications/Blender.app/Contents/MacOS/Blender',
      '/usr/bin/blender',
      '/usr/local/bin/blender',
      '/snap/bin/blender',
    );
  }

  for (const pathEntry of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(pathEntry, process.platform === 'win32' ? 'blender.exe' : 'blender'));
  }

  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))]
    .sort((left, right) => candidateScore(right) - candidateScore(left));
}

async function inspectBlender(executablePath: string) {
  if (!(await executableFile(executablePath))) return undefined;
  let result: ProcessResult;
  try {
    result = await runProcess(executablePath, ['--version'], { timeoutMs: 15_000 });
  } catch {
    return undefined;
  }
  if (result.code !== 0 || result.timedOut) return undefined;
  const parsed = parseBlenderVersion(`${result.stdout}\n${result.stderr}`);
  if (!parsed) return undefined;
  return {
    compatible: compatibleWithWorker(parsed),
    info: {
      executablePath,
      version: parsed.label,
    },
  };
}

async function resolveBlenderExecutable() {
  if (cachedBlender && await executableFile(cachedBlender.executablePath)) {
    return cachedBlender;
  }

  if (serverConfig.blenderExecutablePath) {
    const explicitPath = path.resolve(serverConfig.blenderExecutablePath);
    const inspected = await inspectBlender(explicitPath);
    if (!inspected) {
      throw preparationError(
        'Configured Blender executable was not found or could not be started.',
        503,
      );
    }
    if (!inspected.compatible) {
      throw preparationError(
        `Blender ${inspected.info.version} cannot safely create a project for the Blender 5.1 worker. Configure Blender 4.x or 5.1.x.`,
        503,
      );
    }
    cachedBlender = inspected.info;
    return cachedBlender;
  }

  let incompatibleVersion = '';
  for (const candidate of await automaticBlenderCandidates()) {
    const inspected = await inspectBlender(candidate);
    if (!inspected) continue;
    if (!inspected.compatible) {
      incompatibleVersion ||= inspected.info.version;
      continue;
    }
    cachedBlender = inspected.info;
    return cachedBlender;
  }

  throw preparationError(
    incompatibleVersion
      ? `Only Blender ${incompatibleVersion} was found. Install Blender 5.1.x or configure a compatible Blender 4.x/5.1.x executable.`
      : 'Blender was not found. Install Blender 5.1.x or configure BLENDER_EXECUTABLE_PATH.',
    503,
  );
}

function blenderFailureMessage(stderr: string) {
  const marker = [...stderr.matchAll(/^LI3D_PREP_ERROR:(.+)$/gm)].at(-1)?.[1]?.trim();
  if (!marker) return 'Blender could not assemble the retopology project.';
  return marker.replaceAll(/[\r\n]+/g, ' ').slice(0, 500);
}

async function verifyPreparedBlend(filePath: string) {
  const stat = await fs.promises.stat(filePath).catch(() => undefined);
  if (!stat?.isFile() || stat.size === 0) {
    throw preparationError('Blender did not create a retopology project.', 500);
  }
  if (stat.size > serverConfig.assetServiceMaxUploadBytes) {
    throw preparationError('Prepared BLEND project exceeds the Asset V4 upload limit.', 413);
  }
  const file = await fs.promises.open(filePath, 'r');
  try {
    const signature = Buffer.alloc(7);
    await file.read(signature, 0, signature.length, 0);
    if (signature.toString('ascii') !== 'BLENDER') {
      throw preparationError('Prepared project is not a valid BLEND file.', 500);
    }
  } finally {
    await file.close();
  }
  return stat.size;
}

async function validateSourceFiles(sources: RetopologyProjectSourceFiles) {
  const extension = path.extname(sources.highModelPath).toLowerCase();
  if (!supportedExtensions.has(extension)) {
    throw preparationError(
      'high_model must be FBX, OBJ, or GLB. Use direct upload for an existing BLEND project.',
      415,
    );
  }
  const stat = await fs.promises.stat(sources.highModelPath).catch(() => undefined);
  if (!stat?.isFile() || stat.size === 0) {
    throw preparationError('high_model must be a non-empty model file.', 400);
  }
  if (stat.size > serverConfig.retopologyPrepareMaxFileBytes) {
    throw preparationError('high_model is too large.', 413);
  }
}

async function prepareRetopologyProjectFromFilesWithinSlot(
  sources: RetopologyProjectSourceFiles,
  signal?: AbortSignal,
): Promise<PreparedRetopologyProject> {
  let tempDirectory = '';
  let preserveTempDirectory = false;
  try {
    tempDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'li3d-retopology-prepare-'),
    );
    await validateSourceFiles(sources);
    const blender = await resolveBlenderExecutable();
    if (signal?.aborted) throw preparationError('Request aborted.', 400);

    const scriptPath = path.join(
      serverConfig.repoRoot,
      'scripts',
      'asset-processing',
      'assemble-retopology-project.py',
    );
    if (!(await executableFile(scriptPath))) {
      throw preparationError('Retopology project preparation script is missing.', 500);
    }

    const outputPath = path.join(tempDirectory, 'retopology-project.blend');
    const manifestPath = path.join(tempDirectory, 'retopology-project.manifest.json');
    const targetFaces = sources.targetFaces ?? 500;
    if (!Number.isInteger(targetFaces) || targetFaces < 50 || targetFaces > 5_000) {
      throw preparationError('Target faces must be an integer from 50 to 5000.', 400);
    }
    const scriptArguments = [
      '--background',
      '--factory-startup',
      '--disable-autoexec',
      '--python-exit-code',
      '1',
      '--python',
      scriptPath,
      '--',
      '--high',
      sources.highModelPath,
      '--target-faces',
      String(targetFaces),
      '--output',
      outputPath,
      '--manifest',
      manifestPath,
    ];
    const result = await runProcess(
      blender.executablePath,
      scriptArguments,
      {
        cwd: tempDirectory,
        timeoutMs: serverConfig.retopologyPrepareTimeoutMs,
        signal,
        environment: {
          ...process.env,
          PYTHONNOUSERSITE: '1',
        },
      },
    );

    if (result.aborted) throw preparationError('Request aborted.', 400);
    if (result.timedOut) {
      throw preparationError('Blender timed out while preparing the retopology project.', 504);
    }
    if (result.code !== 0) {
      throw preparationError(blenderFailureMessage(result.stderr), 422);
    }

    const size = await verifyPreparedBlend(outputPath);
    preserveTempDirectory = true;
    let cleaned = false;
    return {
      filePath: outputPath,
      filename: 'li3d-retopology-project.blend',
      size,
      blender,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await fs.promises.rm(tempDirectory, { recursive: true, force: true });
      },
    };
  } finally {
    if (tempDirectory && !preserveTempDirectory) {
      await fs.promises.rm(tempDirectory, { recursive: true, force: true });
    }
  }
}

function acquirePreparationSlot() {
  if (activePreparations >= maxConcurrentPreparations) {
    throw preparationError(
      'Another retopology project is being prepared. Try again after it finishes.',
      429,
    );
  }
  activePreparations += 1;
}

export async function prepareRetopologyProjectFromFiles(
  sources: RetopologyProjectSourceFiles,
  signal?: AbortSignal,
): Promise<PreparedRetopologyProject> {
  acquirePreparationSlot();
  try {
    return await prepareRetopologyProjectFromFilesWithinSlot(sources, signal);
  } finally {
    activePreparations -= 1;
  }
}
