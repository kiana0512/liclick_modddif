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
  memory: { totalMb: number; usedMb: number; freeMb: number; usedPercent: number };
  collectorProcess: { pid: number; rssMb: number; heapUsedMb: number; externalMb: number };
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
