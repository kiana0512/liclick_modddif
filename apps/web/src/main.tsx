import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/noto-sans-sc/wght.css';
import { AppErrorBoundary } from './components/common/AppErrorBoundary';
import { App } from './App';
import { initializeBrowserComputeCapabilities } from './platform/browserComputeCapabilities';
import { initializeReleaseCompatibility } from './services/releaseManifestClient';
import './styles/globals.css';

const queryClient = new QueryClient();

void initializeReleaseCompatibility();
void initializeBrowserComputeCapabilities();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);
