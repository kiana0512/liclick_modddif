import './performanceLab.css';
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
  const [nextCursor, setNextCursor] = useState<string>();
  const listRequestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = adminOnly
        ? await listPerformanceLabAdminSessions(200)
        : await listPerformanceLabSessions(200);
      if (requestId !== listRequestRef.current) return;
      setSessions(result.sessions);
      setNextCursor('nextCursor' in result ? result.nextCursor as string | undefined : undefined);
    } catch (cause) {
      if (requestId === listRequestRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestId === listRequestRef.current) setLoading(false);
    }
  }, [adminOnly]);

  const loadMore = async () => {
    if (!adminOnly || !nextCursor || loading) return;
    const requestId = ++listRequestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await listPerformanceLabAdminSessions(200, nextCursor);
      if (requestId !== listRequestRef.current) return;
      setSessions((previous) => {
        const existing = new Set(previous.map((session) => session.sessionId));
        return [...previous, ...result.sessions.filter((session) => !existing.has(session.sessionId))];
      });
      setNextCursor(result.nextCursor);
    } catch (cause) {
      if (requestId === listRequestRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestId === listRequestRef.current) setLoading(false);
    }
  };

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
    <div className="perf-dialog">
      <section className="perf-panel">
        <header className="perf-header">
          <div><h2>{adminOnly ? '日志监测 · 性能录制' : '服务器性能记录'}</h2>
            <p>新服务器 · 用户浏览器实测 · 已加载 {sessions.length} 条</p></div>
          <div className="flex gap-3">
            <button disabled={loading} onClick={() => void refresh()} aria-label="刷新性能记录"><RefreshCw size={18} /></button>
            <button onClick={onClose} aria-label="关闭性能记录"><X size={18} /></button>
          </div>
        </header>
        {error ? <p role="alert" className="perf-error">{error}</p> : null}
        <div className="perf-columns">
          <aside className="perf-list">
            {loading ? <p>正在读取服务器记录…</p> : null}
            {!loading && !error && !groups.length ? <p>服务器暂时没有性能录制。</p> : null}
            {groups.map((group) => <article key={group.user.id}>
              <header className="flex items-center gap-2">
                {group.user.avatarUrl ? <img src={group.user.avatarUrl} alt="" className="h-8 w-8 rounded-full" referrerPolicy="no-referrer" /> : null}
                <div><strong>{group.user.displayName}</strong><p>{group.user.email ?? group.user.id}</p></div>
              </header>
              {group.sessions.map((session) => <button key={session.sessionId}
                onClick={() => void openSession(session.sessionId)}
                aria-pressed={selected?.sessionId === session.sessionId} className="perf-session">
                <span>{new Date(session.startedAt).toLocaleString()}</span>
                <p>{session.sessionId.slice(-12)} · {session.status === 'completed' ? '已完成' : '进行中 / 中断'}</p>
                <p>{session.chunkCount} 块 · {session.sampleCount} 样本</p>
              </button>)}
            </article>)}
            {adminOnly && nextCursor ? <button disabled={loading} onClick={() => void loadMore()} className="perf-more">加载更早的记录</button> : null}
          </aside>
          <div className="perf-detail">
            {!selected ? <p>选择一次录制查看设备能力、帧耗时、长任务与操作时间线。</p> : <>
              <header className="perf-header">
                <div><h3>{selected.user.displayName}</h3><p>{new Date(selected.startedAt).toLocaleString()} · {selected.durationMs?.toFixed(0) ?? '—'} ms</p></div>
                <button onClick={() => downloadJson(selected.sessionId + '.json', selected)} className="flex items-center gap-2"><Download size={15} />导出完整 JSON</button>
              </header>
              <p className="break-all">{selected.sessionId}</p>
              <div className="perf-stats">{[
                ['状态', selected.status], ['数据块', selected.chunkCount],
                ['样本', selected.sampleCount], ['数据量', (selected.totalBytes / 1024).toFixed(1) + ' KB'],
              ].map(([label, value]) => <div key={label}><p>{label}</p><strong>{value}</strong></div>)}</div>
              {[
                ['慢帧定位与优化线索', selected.analysis ?? { 说明: '此记录没有分析结果' }],
                ['性能汇总', selected.summary ?? {}],
                ['设备能力 · ANGLE / D3D', selected.clientContext],
                ['操作分析报告', selected.report ?? {}],
                ['原始时间线与分块', selected.chunks],
              ].map(([label, value]) => <details key={String(label)} open={label === '慢帧定位与优化线索'}>
                <summary>{String(label)}</summary><pre>{JSON.stringify(value, null, 2)}</pre>
              </details>)}
            </>}
          </div>
        </div>
      </section>
    </div>, document.body,
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
        className="perf-cloud-status"
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
