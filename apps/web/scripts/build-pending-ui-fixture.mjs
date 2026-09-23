import { build } from 'vite';
await build({base:'/qa-pending/',publicDir:false,build:{outDir:'public/qa-pending',emptyOutDir:false,rollupOptions:{input:'test-fixtures/projection-pending-ui.html'}}});
