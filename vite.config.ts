import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'bilko-flow/react': path.resolve(__dirname, 'node_modules/bilko-flow/src/react/index.ts'),
      'bilko-flow': path.resolve(__dirname, 'node_modules/bilko-flow/src/domain/index.ts'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
