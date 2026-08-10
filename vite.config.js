import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // Three.js is intentionally shipped as one cacheable game runtime chunk.
    // Its compressed output is below 200 kB; the higher limit avoids a raw-size false alarm.
    chunkSizeWarningLimit: 700,
  },
});
