import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000
  },
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm']
  },
  worker: {
    format: 'es'
  }
});
