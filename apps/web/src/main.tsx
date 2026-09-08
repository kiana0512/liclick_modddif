import React, { Profiler } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/noto-sans-sc/wght.css';
import { AppErrorBoundary } from './components/common/AppErrorBoundary';
import { App } from './App';
import { isPerformanceLabEnabled } from './dev/performanceLabPolicy';
import {
  recordReactProfilerCommit,
  setPerformanceTimelineEnabled,
} from './engine/performance/performanceTimeline';
import { initializeBrowserComputeCapabilities } from './platform/browserComputeCapabilities';
import { initializeReleaseCompatibility } from './services/releaseManifestClient';
import './styles/globals.css';

const staleChunkReloadKey = 'li3d:stale-chunk-reload-at';
const staleChunkReloadCooldownMs = 30_000;

document.documentElement.lang = 'zh-CN';
document.documentElement.translate = false;

/**
 * A page that stays open across a deployment can still reference the previous
 * build's hashed lazy chunks. Vite reports that condition before the rejected
 * import reaches feature-level error handling, so recover once by loading the
 * current index and its current asset manifest. The cooldown prevents a reload
 * loop when the server or network is genuinely unavailable.
 */
window.addEventListener('vite:preloadError', (event) => {
  const now = Date.now();
  const lastReloadAt = Number(window.sessionStorage.getItem(staleChunkReloadKey) ?? 0);
  if (Number.isFinite(lastReloadAt) && now - lastReloadAt < staleChunkReloadCooldownMs) return;

  event.preventDefault();
  window.sessionStorage.setItem(staleChunkReloadKey, String(now));
  window.location.reload();
});

const queryClient = new QueryClient();
const performanceLabEnabled = isPerformanceLabEnabled(window.location.search);

void initializeReleaseCompatibility();
void initializeBrowserComputeCapabilities();

const application = (
  <React.StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </AppErrorBoundary>
  </React.StrictMode>
);

const root = ReactDOM.createRoot(document.getElementById('root')!);
if (performanceLabEnabled) {
  setPerformanceTimelineEnabled(true);
  root.render(
    <Profiler id="app-root" onRender={recordReactProfilerCommit}>
      {application}
    </Profiler>,
  );
} else {
  root.render(application);
}
