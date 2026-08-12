import { useCallback, useEffect, useRef, useState } from 'react';
import {
  checkLocalTextureRuntime,
  type LocalTextureRuntimeState,
} from '@/services/localTextureRuntimeClient';
import { trackModuleActionOnce } from '@/services/telemetryClient';
import {
  applyLocalTextureRuntimeProbe,
  beginLocalTextureRuntimeProbeCycle,
  createLocalTextureRuntimeMonitorState,
  createSingleFlightProbe,
  getLocalTextureRuntimeRetryDelay,
  type LocalTextureRuntimeMonitorState,
} from './localTextureRuntimePolicy';

export function useLocalTextureRuntime(enabled = true) {
  const [monitor, setMonitor] = useState(createLocalTextureRuntimeMonitorState);
  const monitorRef = useRef(monitor);
  const enabledRef = useRef(enabled);
  const sessionRevisionRef = useRef(0);
  const retryTimerRef = useRef<number>();
  const probeRef = useRef<() => Promise<LocalTextureRuntimeState>>();
  const singleFlightRef = useRef<() => Promise<LocalTextureRuntimeState>>();

  enabledRef.current = enabled;

  const commitMonitor = useCallback((next: LocalTextureRuntimeMonitorState) => {
    monitorRef.current = next;
    setMonitor(next);
  }, []);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current === undefined) return;
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = undefined;
  }, []);

  const scheduleRetry = useCallback(
    (delay: number, sessionRevision: number) => {
      clearRetryTimer();
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = undefined;
        if (!enabledRef.current || sessionRevisionRef.current !== sessionRevision) return;
        void probeRef.current?.();
      }, delay);
    },
    [clearRetryTimer],
  );

  const performProbe = useCallback(async () => {
    const sessionRevision = sessionRevisionRef.current;
    const next = await checkLocalTextureRuntime();
    if (!enabledRef.current || sessionRevisionRef.current !== sessionRevision) return next;

    const updated = applyLocalTextureRuntimeProbe(monitorRef.current, next);
    commitMonitor(updated);
    if (next.status === 'ready') {
      clearRetryTimer();
      trackModuleActionOnce('local_component', 'detect', next.health.runtimeVersion);
    } else {
      const retryDelay = getLocalTextureRuntimeRetryDelay(updated);
      if (retryDelay === undefined) clearRetryTimer();
      else scheduleRetry(retryDelay, sessionRevision);
    }
    return next;
  }, [clearRetryTimer, commitMonitor, scheduleRetry]);

  if (!singleFlightRef.current) {
    singleFlightRef.current = createSingleFlightProbe(performProbe);
  }

  const probe = useCallback(() => singleFlightRef.current!(), []);

  probeRef.current = probe;

  const refresh = useCallback(() => {
    const started = beginLocalTextureRuntimeProbeCycle(monitorRef.current);
    if (started !== monitorRef.current) commitMonitor(started);
    return probe();
  }, [commitMonitor, probe]);

  useEffect(() => {
    const sessionRevision = sessionRevisionRef.current + 1;
    sessionRevisionRef.current = sessionRevision;
    singleFlightRef.current = createSingleFlightProbe(performProbe);
    clearRetryTimer();
    if (!enabled) {
      commitMonitor(createLocalTextureRuntimeMonitorState());
      return;
    }
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 15_000);
    const handleFocus = () => void refresh();
    window.addEventListener('focus', handleFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', handleFocus);
      clearRetryTimer();
      if (sessionRevisionRef.current === sessionRevision) sessionRevisionRef.current += 1;
    };
  }, [clearRetryTimer, commitMonitor, enabled, performProbe, refresh]);

  return {
    state: monitor.runtime,
    refresh,
    hasReadySession: monitor.hasReadySession,
    reconnecting: monitor.reconnecting,
  };
}
