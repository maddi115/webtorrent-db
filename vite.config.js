import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait(),
    nodePolyfills({
      include: ['events', 'util', 'buffer', 'process', 'stream'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      }
    })
  ],
  server: {
    port: 3000,
    fs: {
      strict: false
    }
  },
  optimizeDeps: {
    exclude: ['simple-peer']
  }
});
