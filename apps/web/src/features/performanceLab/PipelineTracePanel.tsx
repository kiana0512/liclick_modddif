import { useEffect, useRef, useState } from 'react';
import type { PipelineTraceReport } from '@/engine/performance/tracing/types';
import { startPipelineTrace, stopPipelineTrace, clearPipelineTrace, getPipelineTrace, getPipelineTraceReports, bindPipelineTraceProject } from '@/engine/performance/tracing/pipelineTrace';
import { useAuthStore } from '@/stores/authStore';
import { PipelineTraceView } from './PipelineTraceView';
import styles from './PipelineTraceView.module.css';

declare global {
  interface Window {
    __li3dPipelineTrace?: {
      start: () => Promise<boolean>;
      stop: () => PipelineTraceReport | undefined;
      reports: () => PipelineTraceReport[];
      recording: () => boolean;
    };
  }
}
export default function PipelineTracePanel({ projectId }: { projectId?: string }) {
  const ownerId = useAuthStore(state => state.user?.id);
  const [recording, setRecording] = useState(false);
  const [report, setReport] = useState<PipelineTraceReport>();
  const [error, setError] = useState('');
  const project = useRef(projectId); project.current = projectId;
  const previous = useRef(projectId);
  useEffect(() => {
    let disposed = false;
    clearPipelineTrace(); setRecording(false); setReport(undefined);
    const api = {
      async start() {
        if (disposed || !ownerId) return false;
        try {
          const session = await startPipelineTrace({ ownerId, projectId: project.current });
          if (!disposed) { setRecording(Boolean(session)); setReport(undefined); setError(''); }
          return !disposed && Boolean(session);
        } catch { if (!disposed) setError('计时启动失败，业务操作不受影响。'); return false; }
      },
      stop() {
        if (disposed) return;
        const result = stopPipelineTrace();
        setRecording(false); setReport(result?.report);
        return result?.report;
      },
      reports: () => disposed ? [] : getPipelineTraceReports(),
      recording: () => !disposed && Boolean(getPipelineTrace()),
    };
    window.__li3dPipelineTrace = api;
    return () => { disposed = true; if (window.__li3dPipelineTrace === api) delete window.__li3dPipelineTrace; clearPipelineTrace(); };
  }, [ownerId]);
  useEffect(() => {
    const prior = previous.current; previous.current = projectId;
    if (prior === projectId) return;
    if (!prior && projectId) { bindPipelineTraceProject(projectId); return; }
    clearPipelineTrace(); setRecording(false); setReport(undefined);
  }, [projectId]);
  return <details className={styles.dock} data-pipeline-trace-state={recording ? 'recording' : 'off'}>
    <summary>函数计时<span>{recording ? '● 录制中' : '○ 未录制'}</span></summary>
    <div className={styles.controls}>
      <button className={`${styles.button} ${styles.primary}`} disabled={!ownerId || recording} onClick={() => void window.__li3dPipelineTrace?.start()}>开始录制</button>
      <button className={styles.button} disabled={!recording} onClick={() => window.__li3dPipelineTrace?.stop()}>停止录制</button>
      <button className={styles.button} disabled={!recording} onClick={() => setReport(getPipelineTrace()?.snapshot())}>查看当前记录</button>
      <p>刷新或切换工程后关闭，未导出记录不保留。</p>
    </div>
    {error && <p role="alert">{error}</p>}
    {report && <PipelineTraceView report={report} />}
  </details>;
}
