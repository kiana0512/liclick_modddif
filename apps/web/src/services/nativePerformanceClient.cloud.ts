import type { NativePerformanceSnapshot } from './nativePerformanceClient';

export type { NativePerformanceSnapshot } from './nativePerformanceClient';

type NavigatorWithDeviceMemory = Navigator & { deviceMemory?: number };

/** Browser-safe capability snapshot; browsers intentionally do not expose host utilization. */
export async function getNativePerformanceSnapshot(
  signal?: AbortSignal,
): Promise<NativePerformanceSnapshot> {
  signal?.throwIfAborted();
  const logicalProcessorCount = Math.max(1, navigator.hardwareConcurrency || 1);
  const memoryMb = Math.max(0, (navigator as NavigatorWithDeviceMemory).deviceMemory ?? 0) * 1024;
  return {
    schemaVersion: 1,
    sampledAtUnixMs: Date.now(),
    platform: navigator.platform || 'browser',
    arch: 'browser-managed',
    cpu: {
      model: 'Browser local CPU',
      logicalProcessorCount,
      overallUtilizationPercent: 0,
      loadAverage: [],
      topologySource: 'navigator.hardwareConcurrency',
      efficiencyClassAvailable: false,
      cores: [],
    },
    memory: {
      totalMb: memoryMb,
      usedMb: 0,
      freeMb: memoryMb,
      usedPercent: 0,
    },
    collectorProcess: { pid: 0, rssMb: 0, heapUsedMb: 0, externalMb: 0 },
    gpu: {
      source: 'browser-capability',
      sampledAtUnixMs: Date.now(),
      adapters: [],
      unavailableReason: 'Browser security model does not expose host GPU utilization.',
    },
  };
}
