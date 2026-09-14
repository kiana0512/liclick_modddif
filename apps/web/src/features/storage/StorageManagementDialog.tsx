import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  STORAGE_INVENTORY_RULE_VERSION,
  type StorageBucketId,
  type StorageCleanupJob,
  type StorageOverview,
  type StoragePurgeJob,
  type StorageQuarantineStatus,
} from '@liclick/contracts';
import {
  ArchiveRestore,
  CircleAlert,
  Clock3,
  Folder,
  HardDrive,
  History,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import {
  getStorageCleanupJob,
  getActiveStorageCleanupJob,
  getStorageOverview,
  getStoragePurgeJob,
  getStorageQuarantineStatus,
  startStorageCleanup,
  startStoragePurge,
  startStorageScan,
} from '@/services/workspaceApiClient';
import { useToastStore } from '@/stores/toastStore';
import { formatStorageBytes } from './storagePresentation';

type StorageManagementDialogProps = {
  initialOverview?: StorageOverview;
  onClose: () => void;
  onOverviewChange?: (overview: StorageOverview) => void;
};

const bucketPresentation: Record<
  StorageBucketId,
  { label: string; description: string; color: string; icon: typeof Folder }
> = {
  'project-resources': {
    label: '项目资源',
    description: '当前项目与生产资产（受保护）',
    color: 'bg-violet-500',
    icon: Folder,
  },
  history: {
    label: '历史版本',
    description: '保留的 Revision 与工程元数据（受保护）',
    color: 'bg-sky-500',
    icon: History,
  },
  temporary: {
    label: '未使用资源',
    description: '未被当前项目、保留历史或任务引用',
    color: 'bg-emerald-400',
    icon: ArchiveRestore,
  },
  trash: {
    label: '回收站与隔离区',
    description: '已删除工程或等待到期处理的资源',
    color: 'bg-amber-300',
    icon: Trash2,
  },
};

function readableScanTime(value?: string) {
  if (!value) return '尚未完成扫描';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '扫描时间不可用'
    : new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
}

function readableCount(value?: number) {
  return new Intl.NumberFormat('zh-CN').format(value ?? 0);
}

function readableDuration(value?: number) {
  if (value === undefined) return undefined;
  if (value < 1_000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function StorageMetric({
  icon: Icon,
  label,
  value,
  accent = false,
}: {
  icon: typeof HardDrive;
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-4 rounded-lg border border-white/10 bg-white/[0.025] p-4 sm:p-5">
      <span
        className={`grid h-12 w-12 shrink-0 place-items-center rounded-lg border ${
          accent
            ? 'border-fuchsia-300/22 bg-fuchsia-400/10 text-fuchsia-300'
            : 'border-white/10 bg-white/[0.045] text-white/74'
        }`}
      >
        <Icon className="h-6 w-6" />
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-medium text-white/52">{label}</span>
        <span
          className={`mt-1 block truncate text-2xl font-semibold tracking-[-0.035em] sm:text-[28px] ${
            accent ? 'text-fuchsia-300' : 'text-white'
          }`}
        >
          {value}
        </span>
      </span>
    </div>
  );
}

export function StorageManagementDialog({
  initialOverview,
  onClose,
  onOverviewChange,
}: StorageManagementDialogProps) {
  const [overview, setOverview] = useState<StorageOverview | undefined>(initialOverview);
  const [scanning, setScanning] = useState(false);
  const [confirmingCleanup, setConfirmingCleanup] = useState(false);
  const [cleanupSubmitting, setCleanupSubmitting] = useState(false);
  const [cleanupJob, setCleanupJob] = useState<StorageCleanupJob>();
  const [quarantine, setQuarantine] = useState<StorageQuarantineStatus>();
  const [confirmingPurge, setConfirmingPurge] = useState(false);
  const [purgeConfirmation, setPurgeConfirmation] = useState('');
  const [purgeSubmitting, setPurgeSubmitting] = useState(false);
  const [purgeJob, setPurgeJob] = useState<StoragePurgeJob>();
  const [error, setError] = useState('');
  const pushToast = useToastStore((state) => state.pushToast);

  const updateOverview = useCallback((next: StorageOverview) => {
    setOverview(next);
    onOverviewChange?.(next);
  }, [onOverviewChange]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (initialOverview) return;
    let cancelled = false;
    void getStorageOverview()
      .then(({ overview: next }) => {
        if (!cancelled) updateOverview(next);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '无法读取存储空间。');
      });
    return () => {
      cancelled = true;
    };
  }, [initialOverview, updateOverview]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getActiveStorageCleanupJob(), getStorageQuarantineStatus()])
      .then(([cleanupResult, quarantineResult]) => {
        if (!cancelled) {
          if (cleanupResult.job) setCleanupJob(cleanupResult.job);
          setQuarantine(quarantineResult.quarantine);
          if (quarantineResult.quarantine.activePurgeJob) {
            setPurgeJob(quarantineResult.quarantine.activePurgeJob);
          }
          setConfirmingCleanup(false);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (overview?.status !== 'scanning' || scanning) return;
    const timer = window.setTimeout(() => {
      void getStorageOverview()
        .then(({ overview: next }) => updateOverview(next))
        .catch(() => undefined);
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [
    overview?.scanPhase,
    overview?.scannedItemCount,
    overview?.status,
    scanning,
    updateOverview,
  ]);

  useEffect(() => {
    if (!cleanupJob || !['queued', 'running'].includes(cleanupJob.status)) return;
    const timer = window.setTimeout(() => {
      void getStorageCleanupJob(cleanupJob.jobId)
        .then(({ job }) => {
          setCleanupJob(job);
          if (job.status === 'completed') {
            setConfirmingCleanup(false);
            pushToast({
              tone: 'success',
              title: '无用资源已移入隔离区',
              description: `已处理 ${formatStorageBytes(job.processedBytes)}，当前只进入可恢复隔离区，尚未永久删除。`,
              dedupeKey: `storage-cleanup-${job.jobId}`,
            });
            return Promise.all([getStorageOverview(), getStorageQuarantineStatus()]).then(
              ([overviewResult, quarantineResult]) => {
                updateOverview(overviewResult.overview);
                setQuarantine(quarantineResult.quarantine);
              },
            );
          }
          if (job.status === 'failed') {
            setConfirmingCleanup(false);
            setError(job.error ?? '清理任务未执行，请重新扫描后再试。');
          }
          return undefined;
        })
        .catch((reason) => {
          setError(reason instanceof Error ? reason.message : '无法读取清理进度。');
        });
    }, 1_200);
    return () => window.clearTimeout(timer);
  }, [cleanupJob, overview?.quarantineDays, pushToast, updateOverview]);

  useEffect(() => {
    if (!purgeJob || !['queued', 'running'].includes(purgeJob.status)) return;
    const timer = window.setTimeout(() => {
      void getStoragePurgeJob(purgeJob.jobId)
        .then(({ job }) => {
          setPurgeJob(job);
          if (job.status === 'completed') {
            setConfirmingPurge(false);
            setPurgeConfirmation('');
            pushToast({
              tone: 'success',
              title: '隔离区已永久清空',
              description: `后台已释放 ${formatStorageBytes(job.targetBytes)}。`,
              dedupeKey: `storage-purge-${job.jobId}`,
            });
            return Promise.all([getStorageOverview(), getStorageQuarantineStatus()]).then(
              ([overviewResult, quarantineResult]) => {
                updateOverview(overviewResult.overview);
                setQuarantine(quarantineResult.quarantine);
              },
            );
          }
          if (job.status === 'failed') {
            setConfirmingPurge(false);
            setError(job.error ?? '隔离区永久清空失败，请重试。');
          }
          return undefined;
        })
        .catch((reason) => {
          setError(reason instanceof Error ? reason.message : '无法读取永久清空进度。');
        });
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [purgeJob, pushToast, updateOverview]);

  const usedBytes = overview?.usedBytes;
  const reclaimableBytes = overview?.reclaimableBytes;
  const inventoryIsCurrent = overview?.ruleVersion === STORAGE_INVENTORY_RULE_VERSION;
  const isCleanupActive =
    cleanupSubmitting || cleanupJob?.status === 'queued' || cleanupJob?.status === 'running';
  const isPurgeActive =
    purgeSubmitting || purgeJob?.status === 'queued' || purgeJob?.status === 'running';
  const canClean =
    overview?.status === 'ready' &&
    inventoryIsCurrent &&
    Boolean(overview.scanId) &&
    typeof reclaimableBytes === 'number' &&
    reclaimableBytes > 0 &&
    !cleanupJob &&
    !cleanupSubmitting &&
    !isPurgeActive;
  const canPurge =
    Boolean(quarantine?.purgeSupported) &&
    (quarantine?.bytes ?? 0) > 0 &&
    !isCleanupActive &&
    !isPurgeActive;
  const barSegments = useMemo(
    () =>
      (overview?.buckets ?? []).map((bucket) => ({
        ...bucket,
        width:
          usedBytes && usedBytes > 0 ? Math.max(0, (bucket.bytes / usedBytes) * 100) : 0,
      })),
    [overview?.buckets, usedBytes],
  );

  async function handleScan() {
    if (scanning) return;
    setScanning(true);
    setError('');
    setConfirmingCleanup(false);
    setCleanupJob(undefined);
    try {
      const result = await startStorageScan();
      updateOverview(result.overview);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '存储扫描失败。');
    } finally {
      setScanning(false);
    }
  }

  async function handleCleanup() {
    if (!overview?.scanId || !canClean) return;
    setCleanupSubmitting(true);
    setError('');
    try {
      const { job } = await startStorageCleanup({
        scanId: overview.scanId,
        idempotencyKey: `storage-cleanup-${crypto.randomUUID()}`,
      });
      setCleanupJob(job);
      if (job.status === 'completed') {
        setConfirmingCleanup(false);
        pushToast({
          tone: 'success',
          title: '无用资源已移入隔离区',
          description: `已处理 ${formatStorageBytes(job.processedBytes)}，当前只进入可恢复隔离区，尚未永久删除。`,
          dedupeKey: `storage-cleanup-${job.jobId}`,
        });
        const [overviewResult, quarantineResult] = await Promise.all([
          getStorageOverview(),
          getStorageQuarantineStatus(),
        ]);
        updateOverview(overviewResult.overview);
        setQuarantine(quarantineResult.quarantine);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法开始清理。');
    } finally {
      setCleanupSubmitting(false);
    }
  }

  async function handlePurge() {
    if (!canPurge || purgeConfirmation !== '永久删除') return;
    setPurgeSubmitting(true);
    setError('');
    try {
      const { job } = await startStoragePurge({
        idempotencyKey: `storage-purge-${crypto.randomUUID()}`,
      });
      setPurgeJob(job);
      setConfirmingPurge(false);
      setPurgeConfirmation('');
      setQuarantine((current) => current ? { ...current, bytes: 0, itemCount: 0, activePurgeJob: job } : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法开始永久清空。');
    } finally {
      setPurgeSubmitting(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-[#060712]/82 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="storage-management-title"
        className="max-h-[calc(100vh-2rem)] w-full max-w-[900px] overflow-y-auto rounded-xl border border-white/14 bg-[#11131c] shadow-[0_28px_100px_rgba(0,0,0,0.62)]"
      >
        <div className="flex items-start justify-between gap-6 border-b border-white/[0.07] px-5 py-5 sm:px-7">
          <div>
            <h2 id="storage-management-title" className="text-xl font-semibold tracking-[-0.025em] text-white sm:text-2xl">
              存储与清理
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-white/54">
              清理不再需要的资源，释放存储空间。当前项目、保留的历史版本和运行中任务会受到保护。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-white/52 transition hover:bg-white/10 hover:text-white"
            aria-label="关闭存储管理"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 px-5 py-5 sm:px-7 sm:py-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <StorageMetric
              icon={HardDrive}
              label={overview?.status === 'scanning' ? '已扫描空间' : '已用空间'}
              value={formatStorageBytes(usedBytes)}
            />
            <StorageMetric
              icon={Trash2}
              label={overview?.status === 'scanning' ? '暂识别可清理' : '可安全清理'}
              value={formatStorageBytes(reclaimableBytes)}
              accent
            />
          </div>

          {overview?.status === 'ready' && usedBytes !== undefined ? (
            <div>
              <div className="flex h-3 overflow-hidden rounded-full bg-white/8">
                {barSegments.map((bucket) => (
                  <span
                    key={bucket.id}
                    className={bucketPresentation[bucket.id].color}
                    style={{ width: `${bucket.width}%` }}
                    title={`${bucketPresentation[bucket.id].label} ${formatStorageBytes(bucket.bytes)}`}
                  />
                ))}
              </div>
              <div className="mt-3 grid gap-x-5 gap-y-2 text-xs text-white/60 sm:grid-cols-2 lg:grid-cols-4">
                {barSegments.map((bucket) => (
                  <span key={bucket.id} className="inline-flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${bucketPresentation[bucket.id].color}`} />
                    <span>{bucketPresentation[bucket.id].label}</span>
                    <span className="text-white/86">{formatStorageBytes(bucket.bytes)}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="divide-y divide-white/[0.075] border-y border-white/[0.075]">
            {(overview?.buckets ?? []).map((bucket) => {
              const presentation = bucketPresentation[bucket.id];
              const Icon = presentation.icon;
              return (
                <div key={bucket.id} className="grid min-h-[62px] grid-cols-[1fr_auto] items-center gap-4 py-3 sm:grid-cols-[180px_110px_1fr_auto]">
                  <span className="flex items-center gap-3 text-sm font-medium text-white/90">
                    <Icon className="h-[18px] w-[18px] text-white/64" />
                    {presentation.label}
                  </span>
                  <span className="text-right text-sm font-medium text-white/84 sm:text-left">
                    {formatStorageBytes(bucket.bytes)}
                  </span>
                  <span className="col-span-2 text-xs leading-5 text-white/42 sm:col-span-1">
                    {presentation.description}
                  </span>
                  <span className={`text-xs font-medium ${bucket.reclaimable || bucket.id === 'trash' ? 'text-emerald-300' : 'text-white/38'}`}>
                    {bucket.reclaimable ? '可清理' : bucket.id === 'trash' ? '可管理' : '受保护'}
                  </span>
                </div>
              );
            })}
          </div>

          {overview?.status === 'scanning' || scanning ? (
            <div className="flex items-center gap-3 rounded-md border border-sky-300/16 bg-sky-400/[0.07] px-4 py-3 text-sm text-sky-50/86">
              <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" />
              <span>
                {overview?.scanPhase === 'references'
                  ? '正在读取工程与历史引用'
                  : overview?.scanPhase === 'retention'
                    ? '正在核对回收站与恢复文件'
                    : overview?.scanPhase === 'persisting'
                      ? '正在保存扫描结果'
                      : '正在并发扫描资产'}
                {overview?.scannedItemCount !== undefined
                  ? ` · 已扫描 ${readableCount(overview.scannedItemCount)} 项`
                  : ''}
                ，扫描期间不会移动或修改文件。
              </span>
            </div>
          ) : null}
          {overview?.status === 'failed' || error ? (
            <div className="rounded-md border border-red-300/22 bg-red-400/[0.08] px-4 py-3 text-sm leading-6 text-red-50">
              {error || overview?.issue || '存储扫描失败。'}
            </div>
          ) : null}
          {confirmingCleanup ? (
            <div className="rounded-lg border border-fuchsia-300/22 bg-fuchsia-400/[0.07] p-4">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-fuchsia-200" />
                <div>
                  <div className="text-sm font-semibold text-white">确认清理 {formatStorageBytes(reclaimableBytes)}</div>
                  <p className="mt-1 text-xs leading-5 text-white/56">
                    仅处理本次扫描确认未被引用的资源。文件先移入隔离区并按 {overview?.quarantineDays ?? 7} 天恢复窗口标记；本次操作不会永久删除文件。
                  </p>
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmingCleanup(false)}
                  className="h-9 rounded-md border border-white/14 px-4 text-sm font-medium text-white/72 transition hover:bg-white/8 hover:text-white"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void handleCleanup()}
                  disabled={cleanupSubmitting}
                  className="h-9 rounded-md bg-gradient-to-r from-fuchsia-500 to-violet-500 px-4 text-sm font-semibold text-white shadow-[0_10px_28px_rgba(192,60,225,0.24)] transition hover:brightness-110"
                >
                  {cleanupSubmitting ? (
                    <span className="inline-flex items-center gap-2">
                      <LoaderCircle className="h-4 w-4 animate-spin" />正在创建任务
                    </span>
                  ) : (
                    '确认移入隔离区'
                  )}
                </button>
              </div>
            </div>
          ) : null}
          {confirmingPurge ? (
            <div className="rounded-lg border border-red-300/28 bg-red-400/[0.075] p-4">
              <div className="flex items-start gap-3">
                <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-200" />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white">
                    永久清空隔离区 {formatStorageBytes(quarantine?.bytes)}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-white/58">
                    此操作不可恢复。只删除已经进入隔离区的资源，不会删除当前项目或保留的历史版本。任务会在后台释放磁盘空间。
                  </p>
                  <label className="mt-3 block text-xs text-white/64" htmlFor="storage-purge-confirmation">
                    输入“永久删除”确认
                  </label>
                  <input
                    id="storage-purge-confirmation"
                    value={purgeConfirmation}
                    onChange={(event) => setPurgeConfirmation(event.target.value)}
                    autoComplete="off"
                    className="mt-2 h-9 w-full max-w-xs rounded-md border border-white/14 bg-black/20 px-3 text-sm text-white outline-none transition placeholder:text-white/28 focus:border-red-300/50"
                    placeholder="永久删除"
                  />
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setConfirmingPurge(false);
                    setPurgeConfirmation('');
                  }}
                  className="h-9 rounded-md border border-white/14 px-4 text-sm font-medium text-white/72 transition hover:bg-white/8 hover:text-white"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void handlePurge()}
                  disabled={purgeSubmitting || purgeConfirmation !== '永久删除'}
                  className="inline-flex h-9 items-center gap-2 rounded-md bg-red-500 px-4 text-sm font-semibold text-white transition hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {purgeSubmitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  永久清空
                </button>
              </div>
            </div>
          ) : null}
          {cleanupJob ? (
            <div
              className={`rounded-md border px-4 py-3 text-sm ${
                cleanupJob.status === 'failed'
                  ? 'border-red-300/20 bg-red-400/[0.055] text-red-200'
                  : 'border-white/10 bg-white/[0.035] text-white/72'
              }`}
            >
              <span className="inline-flex items-center gap-2">
                {isCleanupActive ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : cleanupJob.status === 'failed' ? (
                  <CircleAlert className="h-4 w-4" />
                ) : (
                  <ShieldCheck className="h-4 w-4 text-emerald-300" />
                )}
                {isCleanupActive
                  ? cleanupJob?.phase === 'verifying'
                    ? '正在读取最新项目引用，尚未移动文件'
                    : cleanupJob
                      ? `正在移入隔离区：${readableCount(cleanupJob.processedCount)}/${readableCount(cleanupJob.candidateCount)}`
                      : '正在创建清理任务'
                  : cleanupJob.status === 'failed'
                    ? `清理未执行：${cleanupJob.error ?? '请重新扫描后再试'}`
                  : `本次已处理 ${formatStorageBytes(cleanupJob.processedBytes)}`}
              </span>
            </div>
          ) : null}
          {purgeJob ? (
            <div
              className={`rounded-md border px-4 py-3 text-sm ${
                purgeJob.status === 'failed'
                  ? 'border-red-300/20 bg-red-400/[0.055] text-red-200'
                  : 'border-amber-300/16 bg-amber-400/[0.055] text-white/72'
              }`}
            >
              <span className="inline-flex items-center gap-2">
                {isPurgeActive ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : purgeJob.status === 'failed' ? (
                  <CircleAlert className="h-4 w-4" />
                ) : (
                  <ShieldCheck className="h-4 w-4 text-emerald-300" />
                )}
                {isPurgeActive
                  ? purgeJob.phase === 'detaching'
                    ? '正在从工作区摘除隔离区'
                    : `正在后台永久释放 ${formatStorageBytes(purgeJob.targetBytes)}`
                  : purgeJob.status === 'failed'
                    ? `永久清空失败：${purgeJob.error ?? '请重试'}`
                    : `已永久释放 ${formatStorageBytes(purgeJob.targetBytes)}`}
              </span>
            </div>
          ) : null}

          <div className="flex flex-col-reverse gap-3 border-t border-white/[0.075] pt-5 sm:flex-row sm:items-center sm:justify-between">
            <span className="inline-flex items-center gap-2 text-xs text-white/42">
              <Clock3 className="h-4 w-4" />
              上次扫描：{readableScanTime(overview?.lastScannedAt)}
              {overview?.backend ? ` · ${overview.backend === 'workspace-file' ? '4517 工作区' : 'Cloud 对象存储'}` : ''}
              {readableDuration(overview?.scanDurationMs)
                ? ` · 耗时 ${readableDuration(overview?.scanDurationMs)}`
                : ''}
            </span>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setConfirmingCleanup(false);
                  setConfirmingPurge(true);
                }}
                disabled={!canPurge || confirmingPurge}
                className="inline-flex h-10 items-center gap-2 rounded-md border border-red-300/24 px-4 text-sm font-medium text-red-100/86 transition hover:bg-red-400/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" />清空隔离区
              </button>
              <button
                type="button"
                onClick={() => void handleScan()}
                disabled={scanning || overview?.status === 'scanning' || isCleanupActive || isPurgeActive}
                className="inline-flex h-10 items-center gap-2 rounded-md border border-white/16 px-4 text-sm font-medium text-white/82 transition hover:bg-white/8 hover:text-white disabled:cursor-wait disabled:opacity-45"
              >
                <RefreshCw className={`h-4 w-4 ${scanning ? 'animate-spin' : ''}`} />重新扫描
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmingPurge(false);
                  setPurgeConfirmation('');
                  setConfirmingCleanup(true);
                }}
                disabled={!canClean || confirmingCleanup}
                className="inline-flex h-10 items-center gap-2 rounded-md bg-gradient-to-r from-fuchsia-500 to-violet-500 px-4 text-sm font-semibold text-white shadow-[0_12px_30px_rgba(192,60,225,0.25)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" />清理无用资源
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
