import { execFile } from 'node:child_process';
import os from 'node:os';

type CpuTimes = ReturnType<typeof os.cpus>[number]['times'];

type CpuBaseline = {
  idle: number;
  total: number;
};

export type NativePerformanceSnapshot = {
  schemaVersion: 1;
  sampledAtUnixMs: number;
  platform: NodeJS.Platform;
  arch: string;
  cpu: {
    model: string;
    logicalProcessorCount: number;
    overallUtilizationPercent: number;
    loadAverage: number[];
    topologySource: 'logical-processors' | 'windows-cpu-sets';
    efficiencyClassAvailable: boolean;
    cores: Array<{
      logicalIndex: number;
      utilizationPercent: number;
      speedMHz: number;
      efficiencyClass: number | null;
    }>;
  };
  memory: {
    totalMb: number;
    usedMb: number;
    freeMb: number;
    usedPercent: number;
  };
  collectorProcess: {
    pid: number;
    rssMb: number;
    heapUsedMb: number;
    externalMb: number;
  };
  gpu: {
    source: 'nvidia-smi' | 'windows-performance-counters' | 'unavailable';
    sampledAtUnixMs: number;
    adapters: Array<{
      index?: number;
      name: string;
      utilizationGpuPercent?: number;
      utilizationMemoryPercent?: number;
      memoryUsedMb?: number;
      memoryTotalMb?: number;
      temperatureC?: number;
      powerDrawW?: number;
      performanceState?: string;
    }>;
    unavailableReason?: string;
  };
};

function totalCpuTime(times: CpuTimes) {
  return times.user + times.nice + times.sys + times.idle + times.irq;
}

let previousCpuBaseline: CpuBaseline[] = os.cpus().map(({ times }) => ({
  idle: times.idle,
  total: totalCpuTime(times),
}));

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function toMb(bytes: number) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function sampleCpu(efficiencyClasses?: Map<number, number>) {
  const processors = os.cpus();
  const nextBaseline: CpuBaseline[] = [];
  const cores = processors.map((processor, logicalIndex) => {
    const total = totalCpuTime(processor.times);
    const baseline = previousCpuBaseline[logicalIndex] ?? {
      idle: processor.times.idle,
      total,
    };
    const totalDelta = Math.max(1, total - baseline.total);
    const idleDelta = Math.max(0, processor.times.idle - baseline.idle);
    nextBaseline.push({ idle: processor.times.idle, total });
    return {
      logicalIndex,
      utilizationPercent: Math.round(clampPercent((1 - idleDelta / totalDelta) * 1000)) / 10,
      speedMHz: processor.speed,
      efficiencyClass: efficiencyClasses?.get(logicalIndex) ?? null,
    };
  });
  previousCpuBaseline = nextBaseline;
  return {
    model: processors[0]?.model ?? 'Unknown CPU',
    logicalProcessorCount: processors.length,
    overallUtilizationPercent:
      cores.length > 0
        ? Math.round(
            (cores.reduce((sum, core) => sum + core.utilizationPercent, 0) / cores.length) * 10,
          ) / 10
        : 0,
    loadAverage: os.loadavg().map((value) => Math.round(value * 100) / 100),
    topologySource: efficiencyClasses?.size ? ('windows-cpu-sets' as const) : ('logical-processors' as const),
    efficiencyClassAvailable: Boolean(efficiencyClasses?.size),
    cores,
  };
}

let windowsCpuTopologyPromise: Promise<Map<number, number> | undefined> | undefined;

async function getWindowsCpuEfficiencyClasses() {
  if (process.platform !== 'win32') return undefined;
  if (windowsCpuTopologyPromise) return windowsCpuTopologyPromise;
  windowsCpuTopologyPromise = (async () => {
    const source = [
      'using System;',
      'using System.Collections.Generic;',
      'using System.Runtime.InteropServices;',
      'public static class CpuSetReader {',
      '[DllImport("kernel32.dll", SetLastError=true)]',
      'static extern bool GetSystemCpuSetInformation(IntPtr info, uint length, out uint returned, IntPtr process, uint flags);',
      'public static string Read() {',
      'uint length; GetSystemCpuSetInformation(IntPtr.Zero, 0, out length, IntPtr.Zero, 0);',
      'if (length == 0) return "";',
      'IntPtr buffer = Marshal.AllocHGlobal((int)length);',
      'try {',
      'if (!GetSystemCpuSetInformation(buffer, length, out length, IntPtr.Zero, 0)) return "";',
      'var rows = new List<string>(); int offset = 0;',
      'while (offset + 20 <= length) {',
      'IntPtr item = IntPtr.Add(buffer, offset); int size = Marshal.ReadInt32(item, 0); int type = Marshal.ReadInt32(item, 4);',
      'if (size <= 0 || offset + size > length) break;',
      'if (type == 0) { int logical = Marshal.ReadByte(item, 14); int efficiency = Marshal.ReadByte(item, 18); rows.Add(logical + ":" + efficiency); }',
      'offset += size;',
      '}',
      'return string.Join(",", rows);',
      '} finally { Marshal.FreeHGlobal(buffer); }',
      '}',
      '}',
    ].join(' ');
    const script = [
      "$ErrorActionPreference='Stop'",
      `Add-Type -TypeDefinition '${source.replaceAll("'", "''")}'`,
      '[CpuSetReader]::Read()',
    ].join(';');
    try {
      const output = await runCommand(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        3_000,
      );
      const result = new Map<number, number>();
      output.split(',').forEach((row) => {
        const [logical, efficiency] = row.split(':').map(Number);
        if (Number.isInteger(logical) && Number.isInteger(efficiency)) {
          result.set(logical, efficiency);
        }
      });
      return result.size > 0 ? result : undefined;
    } catch {
      // Older Windows editions and constrained service accounts may not expose
      // CPU-set metadata. Per-logical-processor utilization remains available.
      return undefined;
    }
  })();
  return windowsCpuTopologyPromise;
}

function runCommand(command: string, args: string[], timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
  });
}

type GpuSnapshot = NativePerformanceSnapshot['gpu'];

function parseOptionalNumber(value: string) {
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function sampleNvidiaGpu(): Promise<GpuSnapshot> {
  const output = await runCommand(
    'nvidia-smi',
    [
      '--query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,pstate',
      '--format=csv,noheader,nounits',
    ],
    1_500,
  );
  const adapters = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const fields = line.split(',').map((field) => field.trim());
      return {
        index: parseOptionalNumber(fields[0]),
        name: fields[1] || 'NVIDIA GPU',
        utilizationGpuPercent: parseOptionalNumber(fields[2]),
        utilizationMemoryPercent: parseOptionalNumber(fields[3]),
        memoryUsedMb: parseOptionalNumber(fields[4]),
        memoryTotalMb: parseOptionalNumber(fields[5]),
        temperatureC: parseOptionalNumber(fields[6]),
        powerDrawW: parseOptionalNumber(fields[7]),
        performanceState: fields[8] || undefined,
      };
    });
  if (adapters.length === 0) throw new Error('nvidia-smi returned no adapters.');
  return {
    source: 'nvidia-smi',
    sampledAtUnixMs: Date.now(),
    adapters,
  };
}

async function sampleWindowsGpuCounters(): Promise<GpuSnapshot> {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$gpu=(Get-Counter '\\GPU Engine(*)\\Utilization Percentage').CounterSamples",
    "$memory=(Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage').CounterSamples",
    '$util=($gpu | Measure-Object -Property CookedValue -Sum).Sum',
    '$bytes=($memory | Measure-Object -Property CookedValue -Sum).Sum',
    "[pscustomobject]@{utilization=[math]::Min(100,[math]::Max(0,$util));memoryMb=$bytes/1MB}|ConvertTo-Json -Compress",
  ].join(';');
  const output = await runCommand(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    2_500,
  );
  const parsed = JSON.parse(output) as { utilization?: number; memoryMb?: number };
  return {
    source: 'windows-performance-counters',
    sampledAtUnixMs: Date.now(),
    adapters: [
      {
        name: 'Windows GPU aggregate',
        utilizationGpuPercent: clampPercent(parsed.utilization ?? 0),
        memoryUsedMb: Number.isFinite(parsed.memoryMb) ? parsed.memoryMb : undefined,
      },
    ],
  };
}

let cachedGpu: GpuSnapshot | undefined;
let gpuRefresh: Promise<GpuSnapshot> | undefined;

async function sampleGpu() {
  if (cachedGpu && Date.now() - cachedGpu.sampledAtUnixMs < 900) return cachedGpu;
  if (gpuRefresh) return gpuRefresh;
  gpuRefresh = (async () => {
    try {
      cachedGpu = await sampleNvidiaGpu();
      return cachedGpu;
    } catch (nvidiaError) {
      if (process.platform === 'win32') {
        try {
          cachedGpu = await sampleWindowsGpuCounters();
          return cachedGpu;
        } catch (windowsError) {
          cachedGpu = {
            source: 'unavailable',
            sampledAtUnixMs: Date.now(),
            adapters: [],
            unavailableReason: `NVIDIA: ${String(nvidiaError)}; Windows counters: ${String(windowsError)}`,
          };
          return cachedGpu;
        }
      }
      cachedGpu = {
        source: 'unavailable',
        sampledAtUnixMs: Date.now(),
        adapters: [],
        unavailableReason: `No supported GPU telemetry provider: ${String(nvidiaError)}`,
      };
      return cachedGpu;
    }
  })().finally(() => {
    gpuRefresh = undefined;
  });
  return gpuRefresh;
}

export async function getNativePerformanceSnapshot(): Promise<NativePerformanceSnapshot> {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = Math.max(0, totalMemory - freeMemory);
  const processMemory = process.memoryUsage();
  const efficiencyClasses = await getWindowsCpuEfficiencyClasses();
  return {
    schemaVersion: 1,
    sampledAtUnixMs: Date.now(),
    platform: process.platform,
    arch: process.arch,
    cpu: sampleCpu(efficiencyClasses),
    memory: {
      totalMb: toMb(totalMemory),
      usedMb: toMb(usedMemory),
      freeMb: toMb(freeMemory),
      usedPercent: Math.round((usedMemory / Math.max(1, totalMemory)) * 1000) / 10,
    },
    collectorProcess: {
      pid: process.pid,
      rssMb: toMb(processMemory.rss),
      heapUsedMb: toMb(processMemory.heapUsed),
      externalMb: toMb(processMemory.external),
    },
    gpu: await sampleGpu(),
  };
}
