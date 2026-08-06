import { getLocalTextureRuntimeApiBase } from './localTextureRuntimeClient';
import { getWorkspaceApiBase } from './workspaceApiBase';

export type NativePerformanceSnapshot = {
  schemaVersion: 1;
  sampledAtUnixMs: number;
  platform: string;
  arch: string;
  cpu: {
    model: string;
    logicalProcessorCount: number;
    overallUtilizationPercent: number;
    loadAverage: number[];
    topologySource: string;
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
    source: string;
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

const localBase = getLocalTextureRuntimeApiBase();
const workspaceBase = getWorkspaceApiBase(import.meta.env.VITE_LICLICK_WORKSPACE_API);

async function requestSnapshot(base: string, signal?: AbortSignal) {
  const response = await fetch(`${base}/api/performance/native-snapshot`, {
    cache: 'no-store',
    credentials: 'omit',
    signal,
  });
  if (!response.ok) throw new Error(`Native performance collector returned ${response.status}.`);
  return (await response.json()) as NativePerformanceSnapshot;
}

export async function getNativePerformanceSnapshot(signal?: AbortSignal) {
  try {
    return await requestSnapshot(localBase, signal);
  } catch (localError) {
    // Development commonly reuses an already-installed local component that
    // predates this endpoint. A loopback workspace server is the same machine
    // and provides the collector without exposing host metrics remotely.
    if (
      typeof window !== 'undefined' &&
      (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') &&
      workspaceBase !== localBase
    ) {
      return requestSnapshot(workspaceBase, signal);
    }
    throw localError;
  }
}
