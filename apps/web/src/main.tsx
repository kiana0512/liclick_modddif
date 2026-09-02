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
