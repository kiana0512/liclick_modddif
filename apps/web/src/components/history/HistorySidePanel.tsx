import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Download,
  History,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  downloadTaskHistoryOutput,
  getTaskHistory,
  type TaskHistoryModule,
  type TaskHistoryOutput,
  type TaskHistoryRecord,
} from '@/services/taskHistoryApiClient';
import { trackModuleAction, type TelemetryModule } from '@/services/telemetryClient';

const moduleTitles: Record<TaskHistoryModule, string> = {
  bake: '烘焙历史',
  uv: '展 UV 历史',
  retopology: '拓扑历史',
};

const telemetryModules: Record<TaskHistoryModule, TelemetryModule> = {
  bake: 'model_baking',
  uv: 'auto_uv',
  retopology: 'auto_retopology',
};

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function statusPresentation(status: string) {
  const normalized = status.toLowerCase();
  if (['succeeded', 'success', 'completed', 'complete'].includes(normalized)) {
    return {
      label: '已完成',
      className: 'border-emerald-300/16 bg-emerald-400/[0.07] text-emerald-100/72',
      Icon: CheckCircle2,
    };
  }
  if (['failed', 'error'].includes(normalized)) {
    return {
      label: '失败',
      className: 'border-rose-300/16 bg-rose-400/[0.07] text-rose-100/72',
      Icon: AlertTriangle,
    };
  }
  if (['cancelled', 'canceled'].includes(normalized)) {
    return {
      label: '已取消',
      className: 'border-white/10 bg-white/[0.04] text-white/42',
      Icon: X,
    };
  }
  if (['queued', 'claimed', 'waiting', 'pending'].includes(normalized)) {
    return {
      label: '等待中',
      className: 'border-amber-300/16 bg-amber-400/[0.07] text-amber-100/72',
      Icon: Clock3,
    };
  }
  return {
    label: '处理中',
    className: 'border-blue-300/16 bg-blue-400/[0.07] text-blue-100/72',
    Icon: LoaderCircle,
  };
}

function HistoryRecordCard({
  module,
  record,
  onContinue,
}: {
  module: TaskHistoryModule;
  record: TaskHistoryRecord;
  onContinue?: (record: TaskHistoryRecord, output: TaskHistoryOutput) => Promise<void>;
}) {
  const [downloading, setDownloading] = useState<string>();
  const [continuing, setContinuing] = useState(false);
  const [downloadError, setDownloadError] = useState<string>();
  const presentation = statusPresentation(record.status);
  const StatusIcon = presentation.Icon;
  const progress = Math.min(100, Math.max(0, Number(record.progress) || 0));
  const terminal = ['succeeded', 'success', 'completed', 'complete', 'failed', 'error', 'cancelled', 'canceled'].includes(
    record.status.toLowerCase(),
  );
  const completed = ['succeeded', 'success', 'completed', 'complete'].includes(
    record.status.toLowerCase(),
  );
  const transferableOutput = record.outputs?.find((output) => /\.fbx$/i.test(output.filename));

  async function download(output: TaskHistoryOutput) {
    if (!output.downloadUrl || downloading) return;
    const key = `${record.id}:${output.id}`;
    setDownloading(key);
    setDownloadError(undefined);
    try {
      await downloadTaskHistoryOutput(output);
      trackModuleAction(telemetryModules[module], 'download');
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : '历史文件下载失败。');
    } finally {
      setDownloading(undefined);
    }
  }

  async function continueToNextStage() {
    if (!onContinue || !transferableOutput || continuing) return;
    setContinuing(true);
    setDownloadError(undefined);
    try {
      await onContinue(record, transferableOutput);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : '历史任务传入下一流程失败。');
    } finally {
      setContinuing(false);
    }
  }

  return (
    <details className="group overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.025] open:bg-white/[0.035]">
      <summary className="cursor-pointer list-none px-3.5 py-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-white/76" title={record.sourceName}>
              {record.sourceName || '未命名模型'}
            </p>
            <p className="mt-1 text-[10px] tabular-nums text-white/28">
              {formatDate(record.finishedAt ?? record.createdAt)}
            </p>
          </div>
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[9px] font-medium ${presentation.className}`}
          >
            <StatusIcon
              className={`h-3 w-3 ${!terminal && record.status.toLowerCase() !== 'queued' ? 'animate-spin' : ''}`}
            />
            {presentation.label}
          </span>
        </div>
        {!terminal ? (
          <div className="mt-3">
            <div className="h-1 overflow-hidden rounded-full bg-white/[0.07]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-fuchsia-400 to-violet-400 transition-[width]"
                style={{ width: `${Math.max(3, progress)}%` }}
              />
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[9px] text-white/24">
              <span>任务处理中</span>
              <span>{Math.round(progress)}%</span>
            </div>
          </div>
        ) : null}
        <div className="mt-2.5 flex items-center justify-between text-[10px] text-white/25">
          <span>{record.outputs?.length ?? 0} 个可交付文件</span>
          <span className="inline-flex items-center gap-1 transition group-open:text-white/48">
            查看参数
            <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
          </span>
        </div>
      </summary>

      <div className="space-y-3 border-t border-white/[0.055] px-3.5 py-3.5">
        {record.parameters?.length ? (
          <dl className="space-y-1.5">
            {record.parameters.map((parameter, index) => (
              <div
                key={`${parameter.label}-${index}`}
                className="flex min-w-0 items-start justify-between gap-3 text-[10px]"
              >
                <dt className="shrink-0 text-white/28">{parameter.label}</dt>
                <dd className="min-w-0 break-words text-right text-white/58">{parameter.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-[10px] text-white/25">此任务没有额外参数。</p>
        )}

        {record.error ? (
          <div className="rounded-lg border border-rose-300/12 bg-rose-400/[0.045] px-3 py-2 text-[10px] leading-4 text-rose-100/62">
            {record.error}
          </div>
        ) : null}

        {record.outputs?.length ? (
          <div className="space-y-1.5 border-t border-white/[0.05] pt-3">
            {record.outputs.map((output) => {
              const key = `${record.id}:${output.id}`;
              const busy = downloading === key;
              return (
                <button
                  key={output.id}
                  type="button"
                  disabled={!output.downloadUrl || Boolean(downloading)}
                  onClick={() => void download(output)}
                  className="flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-white/[0.06] bg-black/15 px-2.5 py-2 text-left transition hover:border-white/14 hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-white/[0.045] text-white/45">
                    {busy ? (
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[10px] font-medium text-white/62" title={output.filename}>
                      {output.label || output.filename}
                    </span>
                    <span className="mt-0.5 block truncate text-[9px] text-white/24">
                      {[output.filename, formatBytes(output.sizeBytes)].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        {completed && transferableOutput && onContinue ? (
          <button
            type="button"
            disabled={continuing || Boolean(downloading)}
            onClick={() => void continueToNextStage()}
            className={`inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg text-[10px] font-semibold text-white shadow-lg transition hover:brightness-110 disabled:cursor-wait disabled:opacity-45 ${
              module === 'uv'
                ? 'bg-gradient-to-r from-emerald-500 to-teal-500'
                : 'bg-gradient-to-r from-blue-600 to-violet-500'
            }`}
          >
            {continuing ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {continuing ? '正在传入…' : module === 'uv' ? '传入烘焙' : '传入 UV'}
          </button>
        ) : null}

        {downloadError ? (
          <div className="rounded-lg border border-rose-300/12 bg-rose-400/[0.045] px-3 py-2 text-[10px] leading-4 text-rose-100/62">
            {downloadError}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function PanelContent({
  module,
  records,
  loading,
  error,
  onRefresh,
  onContinue,
  onClose,
}: {
  module: TaskHistoryModule;
  records: TaskHistoryRecord[];
  loading: boolean;
  error?: string;
  onRefresh: () => void;
  onContinue?: (record: TaskHistoryRecord, output: TaskHistoryOutput) => Promise<void>;
  onClose?: () => void;
}) {
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#101220]/94 text-white shadow-[0_28px_80px_rgba(0,0,0,.46)] backdrop-blur-2xl">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-violet-300/14 bg-violet-400/[0.07] text-violet-100/72">
            <History className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-white/82">{moduleTitles[module]}</h2>
            <p className="mt-0.5 text-[10px] text-white/27">最近 {records.length} 条任务</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="刷新历史记录"
            title="刷新历史记录"
            disabled={loading}
            onClick={onRefresh}
            className="grid h-8 w-8 place-items-center rounded-lg text-white/38 transition hover:bg-white/[0.07] hover:text-white disabled:cursor-wait disabled:opacity-45"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {onClose ? (
            <button
              type="button"
              aria-label="关闭历史记录"
              onClick={onClose}
              className="grid h-8 w-8 place-items-center rounded-lg text-white/38 transition hover:bg-white/[0.07] hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </header>

      <div className="workflow-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
        {loading && records.length === 0 ? (
          <div className="grid min-h-52 place-items-center rounded-xl border border-dashed border-white/[0.07]">
            <div className="text-center text-white/30">
              <LoaderCircle className="mx-auto h-5 w-5 animate-spin" />
              <p className="mt-3 text-xs">正在读取历史记录…</p>
            </div>
          </div>
        ) : error && records.length === 0 ? (
          <div className="rounded-xl border border-rose-300/12 bg-rose-400/[0.045] p-4 text-xs leading-5 text-rose-100/62">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
            <button
              type="button"
              onClick={onRefresh}
              className="mt-3 inline-flex h-8 items-center gap-2 rounded-lg border border-rose-200/14 px-3 text-[10px] transition hover:bg-rose-100/[0.06]"
            >
              <RefreshCw className="h-3 w-3" />
              重新加载
            </button>
          </div>
        ) : records.length === 0 ? (
          <div className="grid min-h-52 place-items-center rounded-xl border border-dashed border-white/[0.07] px-5">
            <div className="text-center">
              <History className="mx-auto h-6 w-6 text-white/18" />
              <p className="mt-3 text-xs font-medium text-white/42">还没有历史记录</p>
              <p className="mt-1 text-[10px] leading-4 text-white/23">完成一次任务后，模型、参数和下载文件会保存在这里。</p>
            </div>
          </div>
        ) : (
          <div className="space-y-2.5">
            {error ? (
              <div className="rounded-lg border border-amber-300/12 bg-amber-400/[0.04] px-3 py-2 text-[10px] text-amber-100/55">
                刷新失败，当前显示上次读取的记录。
              </div>
            ) : null}
            {records.map((record) => (
              <HistoryRecordCard
                key={record.id}
                module={module}
                record={record}
                onContinue={onContinue}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function HistorySidePanel({
  module,
  refreshKey,
  onContinue,
}: {
  module: TaskHistoryModule;
  refreshKey?: string;
  onContinue?: (record: TaskHistoryRecord, output: TaskHistoryOutput) => Promise<void>;
}) {
  const [records, setRecords] = useState<TaskHistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [reload, setReload] = useState(0);

  const refresh = useCallback(() => setReload((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void getTaskHistory(module, 30)
      .then((nextRecords) => {
        if (!active) return;
        setRecords(nextRecords);
        setError(undefined);
      })
      .catch((historyError) => {
        if (!active) return;
        setError(historyError instanceof Error ? historyError.message : '无法读取历史记录。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [module, refreshKey, reload]);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  const completedCount = useMemo(
    () =>
      records.filter((record) =>
        ['succeeded', 'success', 'completed', 'complete'].includes(record.status.toLowerCase()),
      ).length,
    [records],
  );

  return (
    <>
      <div className="fixed bottom-4 right-4 top-20 z-40 hidden w-60 2xl:block min-[1720px]:w-80">
        <PanelContent
          module={module}
          records={records}
          loading={loading}
          error={error}
          onRefresh={refresh}
          onContinue={onContinue}
        />
      </div>

      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        className="fixed right-4 top-[76px] z-40 inline-flex h-10 items-center gap-2 rounded-xl border border-white/12 bg-[#111321]/92 px-3 text-xs font-semibold text-white/72 shadow-[0_16px_40px_rgba(0,0,0,.36)] backdrop-blur-xl transition hover:border-violet-300/25 hover:bg-[#17192a] hover:text-white 2xl:hidden"
      >
        <History className="h-4 w-4 text-violet-200/72" />
        历史记录
        {completedCount > 0 ? (
          <span className="rounded-full bg-violet-400/14 px-1.5 py-0.5 text-[9px] text-violet-100/72">
            {completedCount}
          </span>
        ) : null}
      </button>

      {drawerOpen ? (
        <div
          className="fixed inset-0 z-[170] bg-black/62 backdrop-blur-sm 2xl:hidden"
          role="dialog"
          aria-modal="true"
          aria-label={moduleTitles[module]}
          onPointerDown={() => setDrawerOpen(false)}
        >
          <div
            className="absolute bottom-3 right-3 top-3 w-[min(380px,calc(100vw-24px))]"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <PanelContent
              module={module}
              records={records}
              loading={loading}
              error={error}
              onRefresh={refresh}
              onContinue={onContinue}
              onClose={() => setDrawerOpen(false)}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
