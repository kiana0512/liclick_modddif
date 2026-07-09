import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

function normalizeBase(value?: string) {
  const normalized = `/${(value ?? '/').split('/').filter(Boolean).join('/')}`;
  return normalized === '/' ? '/' : `${normalized}/`;
}

export default defineConfig({
  plugins: [react()],
  base: normalizeBase(process.env.VITE_PUBLIC_PATH ?? process.env.VITE_BASE_PATH),
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, '/');
          if (!normalized.includes('/node_modules/')) return undefined;
          if (normalized.includes('/react/') || normalized.includes('/react-dom/') || normalized.includes('/scheduler/')) {
            return 'react-vendor';
          }
          if (
            normalized.includes('/three/') ||
            normalized.includes('/@react-three/') ||
            normalized.includes('/three-stdlib/') ||
            normalized.includes('/three-projected-material/')
          ) {
            return 'three-vendor';
          }
          return 'vendor';
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
    },
  },
});
