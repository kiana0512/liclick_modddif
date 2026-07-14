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
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
    },
  },
});
