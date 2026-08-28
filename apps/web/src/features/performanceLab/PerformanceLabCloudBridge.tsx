import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, RefreshCw, Server, X } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import {
  capturePerformanceLabClientContext,
  createPerformanceLabSessionId,
  PERFORMANCE_LAB_COLLECTOR_VERSION,
  PERFORMANCE_LAB_REPORT_SCHEMA_VERSION,
  PerformanceLabCollector,
  type PerformanceLabChunk,
} from './performanceLabCollector';
import {
  getPerformanceLabAdminSession,
  getPerformanceLabSession,
  listPerformanceLabAdminSessions,
  listPerformanceLabSessions,
  performanceLabApiUrl,
  type PerformanceLabSessionDetail,
  type PerformanceLabSessionListItem,
} from './performanceLabApiClient';

type UploadState = 'idle' | 'recording' | 'uploading' | 'saved' | 'retrying' | 'error';

type WorkerStatusMessage = {
  type: 'status' | 'queue-error';
  sessionId: string;
  kind?: 'start' | 'chunk' | 'complete';
  state?: 'uploaded' | 'retrying' | 'rejected';
  error?: string;
};

type ActiveRecording = {
  sessionId: string;
  collector: PerformanceLabCollector;
};

const manualReportStorageKey = 'liclick:performance:manual-report:v2';
const maintainerRoles = new Set(['admin', 'maintainer', 'owner', 'superadmin']);

function chunkSampleCount(chunk: PerformanceLabChunk) {
  return (
    chunk.frames.length +
    chunk.longTasks.length +
    chunk.longAnimationFrames.length +
    chunk.eventTimings.length +
    chunk.inputs.length +
    chunk.resources.length
  );
}

function readManualHudReport(startedAtUnixMs: number) {
  try {
    const value = window.sessionStorage.getItem(manualReportStorageKey);
    if (!value) return undefined;
    const report = JSON.parse(value) as Record<string, unknown>;
    const reportStartedAt = Number(report.startedAtUnixMs ?? 0);
    return Math.abs(reportStartedAt - startedAtUnixMs) <= 2_000 ? report : undefined;
  } catch {
    return undefined;
  }
}

function statusText(state: UploadState, sessionId?: string) {
  const shortId = sessionId?.slice(-8);
  if (state === 'recording') return `客户端录制中${shortId ? ` · ${shortId}` : ''}`;
  if (state === 'uploading') return '正在封存到服务器';
  if (state === 'saved') return '服务器已收到本次记录';
  if (state === 'retrying') return '网络中断，后台自动重试';
  if (state === 'error') return '服务器记录失败';
  return '等待人工录制';
}

function toneClass(state: UploadState) {
  if (state === 'recording') return 'border-red-400/60 bg-red-950/90 text-red-100';
  if (state === 'saved') return 'border-emerald-400/55 bg-emerald-950/90 text-emerald-100';
  if (state === 'error') return 'border-rose-400/70 bg-rose-950/95 text-rose-100';
  if (state === 'retrying') return 'border-amber-400/60 bg-amber-950/90 text-amber-100';
  return 'border-white/20 bg-black/88 text-white/75';
}

function groupedSessions(sessions: PerformanceLabSessionListItem[]) {
  const groups = new Map<
    string,
    { user: PerformanceLabSessionListItem['user']; sessions: PerformanceLabSessionListItem[] }
  >();
  for (const session of sessions) {
    const existing = groups.get(session.user.id);
    if (existing) existing.sessions.push(session);
    else groups.set(session.user.id, { user: session.user, sessions: [session] });
  }
  return [...groups.values()].sort((left, right) =>
    left.user.displayName.localeCompare(right.user.displayName, 'zh-CN'),
  );
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function PerformanceRecordsDialog({
  onClose,
  adminOnly = false,
}: {
  onClose: () => void;
  adminOnly?: boolean;
}) {
  const [sessions, setSessions] = useState<PerformanceLabSessionListItem[]>([]);
  const [selected, setSelected] = useState<PerformanceLabSessionDetail>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = adminOnly
        ? await listPerformanceLabAdminSessions(200)
        : await listPerformanceLabSessions(200);
      setSessions(result.sessions);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [adminOnly]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const groups = useMemo(() => groupedSessions(sessions), [sessions]);

  const openSession = useCallback(async (sessionId: string) => {
    setError(undefined);
    try {
      const result = adminOnly
        ? await getPerformanceLabAdminSession(sessionId)
        : await getPerformanceLabSession(sessionId);
      setSelected(result.session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [adminOnly]);

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/72 p-5 backdrop-blur-sm">
      <section className="flex h-[min(86vh,860px)] w-[min(96vw,1380px)] flex-col overflow-hidden rounded-xl border border-white/15 bg-[#0b0b12] text-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">
              {adminOnly ? 'Performance Lab 管理员分析台' : '服务器性能记录'}
            </h2>
            <p className="mt-0.5 text-[11px] text-white/45">
              按可信飞书身份与录制时间分类；指标均来自用户浏览器和用户电脑。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded border border-white/12 p-2 text-white/65 hover:bg-white/8"
              aria-label="刷新性能记录"
            >
              <RefreshCw size={15} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-white/12 p-2 text-white/65 hover:bg-white/8"
              aria-label="关闭性能记录"
            >
              <X size={15} />
            </button>
          </div>
        </header>
        {error ? (
          <div className="border-b border-rose-400/20 bg-rose-950/45 px-4 py-2 text-xs text-rose-200">
            {error}
          </div>
        ) : null}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(360px,0.9fr)_minmax(0,1.6fr)]">
          <div className="overflow-auto border-r border-white/10 p-3">
            {loading ? <p className="p-3 text-xs text-white/45">正在读取服务器记录…</p> : null}
            {!loading && groups.length === 0 ? (
              <p className="p-3 text-xs text-white/45">服务器暂时没有性能录制。</p>
            ) : null}
            <div className="space-y-3">
              {groups.map((group) => (
                <article
                  key={group.user.id}
                  className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.035]"
                >
                  <div className="flex items-center gap-2 border-b border-white/8 px-3 py-2">
                    {group.user.avatarUrl ? (
                      <img
                        src={group.user.avatarUrl}
                        alt=""
                        className="h-8 w-8 rounded-full bg-white/8 object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-liclick-pink/25 text-xs font-semibold">
                        {group.user.displayName.slice(0, 1)}
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold">{group.user.displayName}</div>
                      <div className="truncate text-[10px] text-white/38">
                        {group.user.email ?? group.user.id}
                      </div>
                    </div>
                    <span className="ml-auto rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-white/55">
                      {group.sessions.length} 次
                    </span>
                  </div>
                  <div className="divide-y divide-white/7">
                    {group.sessions.map((session) => (
                      <button
                        key={session.sessionId}
                        type="button"
                        onClick={() => void openSession(session.sessionId)}
                        className="grid w-full grid-cols-[1fr_auto] gap-2 px-3 py-2 text-left hover:bg-white/[0.055]"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-mono text-[11px] text-white/78">
                            {session.sessionId.slice(-12)}
                          </span>
                          <span className="mt-0.5 block text-[10px] text-white/38">
                            {new Date(session.startedAt).toLocaleString()} · {session.chunkCount} 块
                            · {session.sampleCount} 样本
                          </span>
                        </span>
                        <span
                          className={
                            session.status === 'completed' ? 'text-emerald-300' : 'text-amber-300'
                          }
                        >
                          {session.status === 'completed' ? '已完成' : '中断/进行中'}
                        </span>
                      </button>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </div>
          <div className="min-w-0 overflow-auto p-4">
            {!selected ? (
              <div className="flex h-full items-center justify-center text-sm text-white/35">
                选择一次录制查看客户端帧、ANGLE/D3D、长任务和资源瀑布。
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="font-mono text-sm text-white/90">{selected.sessionId}</h3>
                    <p className="mt-1 text-[11px] text-white/45">
                      {selected.user.displayName} · {new Date(selected.startedAt).toLocaleString()}{' '}
                      · {selected.durationMs?.toFixed(0) ?? '—'} ms
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => downloadJson(`${selected.sessionId}.json`, selected)}
                    className="flex items-center gap-1.5 rounded border border-cyan-400/35 bg-cyan-400/10 px-3 py-2 text-xs text-cyan-100 hover:bg-cyan-400/15"
                  >
                    <Download size={14} /> 导出完整 JSON
                  </button>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {[
                    ['状态', selected.status],
                    ['数据块', String(selected.chunkCount)],
                    ['样本', String(selected.sampleCount)],
                    ['数据量', `${(selected.totalBytes / 1024).toFixed(1)} KB`],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="rounded border border-white/10 bg-white/[0.035] p-2.5"
                    >
                      <div className="text-[10px] text-white/38">{label}</div>
                      <div className="mt-1 font-mono text-xs text-white/82">{value}</div>
                    </div>
                  ))}
                </div>
                <div>
                  <h4 className="mb-2 text-xs font-semibold text-white/72">汇总</h4>
                  <pre className="max-h-64 overflow-auto rounded border border-white/10 bg-black/40 p-3 text-[10px] leading-5 text-emerald-200/85">
                    {JSON.stringify(selected.summary ?? {}, null, 2)}
                  </pre>
                </div>
                <div>
                  <h4 className="mb-2 text-xs font-semibold text-white/72">
                    客户端能力与 ANGLE/D3D
                  </h4>
                  <pre className="max-h-80 overflow-auto rounded border border-white/10 bg-black/40 p-3 text-[10px] leading-5 text-cyan-100/80">
                    {JSON.stringify(selected.clientContext, null, 2)}
                  </pre>
                </div>
                <div>
                  <h4 className="mb-2 text-xs font-semibold text-white/72">原始分块</h4>
                  <pre className="max-h-[460px] overflow-auto rounded border border-white/10 bg-black/40 p-3 text-[10px] leading-5 text-white/65">
                    {JSON.stringify(selected.chunks, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}

export function PerformanceLabCloudBridge({ projectId }: { projectId: string }) {
  const user = useAuthStore((state) => state.user);
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [sessionId, setSessionId] = useState<string>();
  const [lastError, setLastError] = useState<string>();
  const [recordsOpen, setRecordsOpen] = useState(false);
  const workerRef = useRef<Worker>();
  const activeRecordingRef = useRef<ActiveRecording>();
  const lastSessionIdRef = useRef<string>();
  const orderRef = useRef(0);
  const isMaintainer = maintainerRoles.has(user?.role.toLowerCase() ?? '');
  const recordingActive = uploadState === 'recording';
  const recordingBusy = uploadState === 'uploading' || uploadState === 'retrying';

  const ensureWorker = useCallback(() => {
    if (workerRef.current) return workerRef.current;
    const worker = new Worker(new URL('./performanceLabUpload.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.addEventListener('message', (event: MessageEvent<WorkerStatusMessage>) => {
      const message = event.data;
      if (message.type === 'queue-error' || message.state === 'rejected') {
        if (message.sessionId === lastSessionIdRef.current) {
          setLastError(message.error ?? 'Performance report upload failed.');
          setUploadState('error');
        }
        return;
      }
      if (message.state === 'retrying') {
        if (message.sessionId === lastSessionIdRef.current) setUploadState('retrying');
        return;
      }
      if (
        message.state === 'uploaded' &&
        message.kind === 'complete' &&
        message.sessionId === lastSessionIdRef.current
      ) {
        setUploadState('saved');
      }
    });
    workerRef.current = worker;
    worker.postMessage({ type: 'flush' });
    return worker;
  }, []);

  const enqueue = useCallback(
    (
      activeSessionId: string,
      kind: 'start' | 'chunk' | 'complete',
      path: string,
      body: Record<string, unknown>,
    ) => {
      const order = Date.now() * 1_000 + (orderRef.current++ % 1_000);
      ensureWorker().postMessage({
        type: 'enqueue',
        request: {
          id: `${activeSessionId}:${kind}:${order}`,
          sessionId: activeSessionId,
          kind,
          url: performanceLabApiUrl(path),
          body,
          order,
        },
      });
    },
    [ensureWorker],
  );

  const beginRecording = useCallback(() => {
    if (activeRecordingRef.current) return;
    const nextSessionId = createPerformanceLabSessionId();
    const context = capturePerformanceLabClientContext(projectId);
    const collector = new PerformanceLabCollector(nextSessionId, (chunk) => {
      enqueue(
        nextSessionId,
        'chunk',
        `/api/performance-lab/sessions/${encodeURIComponent(nextSessionId)}/chunks`,
        {
          sequence: chunk.sequence,
          startedAt: new Date(chunk.startedAtUnixMs).toISOString(),
          endedAt: new Date(chunk.endedAtUnixMs).toISOString(),
          sampleCount: chunkSampleCount(chunk),
          payload: chunk,
        },
      );
    });
    const startedAtUnixMs = collector.start();
    activeRecordingRef.current = { sessionId: nextSessionId, collector };
    lastSessionIdRef.current = nextSessionId;
    setSessionId(nextSessionId);
    setLastError(undefined);
    setUploadState('recording');
    enqueue(nextSessionId, 'start', '/api/performance-lab/sessions', {
      sessionId: nextSessionId,
      projectId,
      schemaVersion: PERFORMANCE_LAB_REPORT_SCHEMA_VERSION,
      collectorVersion: PERFORMANCE_LAB_COLLECTOR_VERSION,
      startedAt: new Date(startedAtUnixMs).toISOString(),
      clientContext: context,
    });
  }, [enqueue, projectId]);

  const endRecording = useCallback(() => {
    const active = activeRecordingRef.current;
    if (!active) return;
    activeRecordingRef.current = undefined;
    const summary = active.collector.stop();
    const manualHudReport = readManualHudReport(summary.startedAtUnixMs);
    setUploadState('uploading');
    enqueue(
      active.sessionId,
      'complete',
      `/api/performance-lab/sessions/${encodeURIComponent(active.sessionId)}/complete`,
      {
        endedAt: new Date(summary.endedAtUnixMs).toISOString(),
        summary,
        report: {
          manualHudReport,
          dataOrigin: 'client-browser',
          serverGpuMetricsIncluded: false,
          note: 'A100/Cloud stores this report but is not the measured GPU.',
        },
      },
    );
  }, [enqueue]);

  useEffect(() => {
    let previousRecording = document.body.dataset.perfManualLocalRepaintRecording === '1';
    if (previousRecording) beginRecording();
    const handleRecordingEvent = (event: Event) => {
      const recording = Boolean(
        (event as CustomEvent<{ recording?: boolean }>).detail?.recording,
      );
      previousRecording = recording;
      if (recording) beginRecording();
      else endRecording();
    };
    const observer = new MutationObserver(() => {
      const recording = document.body.dataset.perfManualLocalRepaintRecording === '1';
      if (recording === previousRecording) return;
      previousRecording = recording;
      if (recording) beginRecording();
      else endRecording();
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-perf-manual-local-repaint-recording'],
    });
    window.addEventListener('liclick-perf-manual-recording', handleRecordingEvent);
    return () => {
      observer.disconnect();
      window.removeEventListener('liclick-perf-manual-recording', handleRecordingEvent);
    };
  }, [beginRecording, endRecording]);

  useEffect(() => {
    ensureWorker();
    return () => {
      workerRef.current?.terminate();
      workerRef.current = undefined;
    };
  }, [ensureWorker]);

  return (
    <>
      <div
        className={`fixed left-1/2 top-2 z-[65] flex -translate-x-1/2 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] shadow-xl backdrop-blur-md ${toneClass(uploadState)}`}
        data-performance-cloud-state={uploadState}
        data-performance-session-id={sessionId}
      >
        <span className={uploadState === 'recording' ? 'animate-pulse' : ''}>●</span>
        <span>{statusText(uploadState, sessionId)}</span>
        {lastError ? <span className="max-w-64 truncate text-rose-200">· {lastError}</span> : null}
        <button
          type="button"
          disabled={recordingBusy}
          onClick={recordingActive ? endRecording : beginRecording}
          className={`ml-1 rounded border px-2 py-1 font-semibold disabled:cursor-wait disabled:opacity-55 ${
            recordingActive
              ? 'border-red-300/55 bg-red-500/85 text-white'
              : 'border-liclick-pink/55 bg-liclick-pink/22 text-pink-100 hover:bg-liclick-pink/32'
          }`}
          data-performance-cloud-recording-button
        >
          {recordingActive ? '■ 结束并保存' : '● 开始服务器录制'}
        </button>
        {isMaintainer ? (
          <button
            type="button"
            onClick={() => setRecordsOpen(true)}
            className="ml-1 flex items-center gap-1 rounded border border-white/15 bg-white/7 px-2 py-1 text-white/78 hover:bg-white/12"
          >
            <Server size={12} /> 服务器记录
          </button>
        ) : null}
      </div>
      {recordsOpen ? <PerformanceRecordsDialog onClose={() => setRecordsOpen(false)} /> : null}
    </>
  );
}
