import { defineConfig } from 'vitest/config';

export default defineConfig({
  // three is pure ESM; excluding it from pre-bundling avoids optimizer re-runs (and full reloads)
  // when new three/examples/jsm/* addons are imported while 15 developers share one dev server.
  optimizeDeps: { exclude: ['three'] },
  server: { port: 5173, strictPort: true, host: '0.0.0.0' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, sourcemap: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 120_000,
    pool: 'threads',
  },
});
