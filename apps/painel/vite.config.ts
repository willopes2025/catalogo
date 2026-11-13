import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@aritana/regras': path.resolve(__dirname, '../../packages/regras/src/index.ts') } },
  server: { port: 5173, host: true, proxy: { '/api': 'http://localhost:3000' } },
});
