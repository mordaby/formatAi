import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const evalCases = path.resolve(here, '../../eval/cases');

type Middlewares = { use(path: string, fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): unknown };

function serveCases(middlewares: Middlewares): void {
  middlewares.use('/__dev/cases', (req, res, next) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const file = path.resolve(evalCases, '.' + rel);
    // Stay inside eval/cases (no ".." escapes); answer 404 ourselves so the SPA fallback never returns index.html for a missing file.
    if (!file.startsWith(evalCases + path.sep)) return next();
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
}

/**
 * DEV ONLY: serves the example pairs in eval/cases at /__dev/cases/<case>/<file>, so the
 * /dev debug page can "load a sample case" without a file picker. Present in the dev
 * server; in `vite preview` only with VITE_DEV_PAGE=true (to check a production bundle);
 * never part of a build.
 */
function devCases(): Plugin {
  return {
    name: 'formatai-dev-cases',
    apply: 'serve',
    configureServer(server) {
      serveCases(server.middlewares);
    },
    configurePreviewServer(server) {
      if (process.env.VITE_DEV_PAGE === 'true') serveCases(server.middlewares);
    },
  };
}

export default defineConfig({
  plugins: [react(), devCases()],
  // The engine and shared packages are consumed straight from their TS source
  // (their package.json "main"/"exports" point at ./src/index.ts), so nothing needs
  // aliasing for them; Vite treats a linked workspace package as source, not as a
  // pre-bundled dependency.
  optimizeDeps: {
    // The engine's dependencies are only imported inside the worker, which the dev server sees late
    // (on the first learn). Without this Vite discovers them then, re-optimizes, and reloads the page
    // in the middle of the user's first run. Pre-declaring them makes the first run clean.
    include: ['@formatai/engine > exceljs', '@formatai/engine > xlsx', '@formatai/engine > jszip', '@formatai/engine > decimal.js'],
  },
  worker: {
    // The engine worker is a module worker (`new Worker(url, { type: 'module' })`).
    format: 'es',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
  },
});
