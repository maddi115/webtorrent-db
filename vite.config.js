import { defineConfig } from 'vite';

// GitHub Pages serves the app from /webtorrent-db/, everything else from /
export default defineConfig({
  base: process.env.PAGES_BASE || '/',
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
