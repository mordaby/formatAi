import { defineConfig } from 'vitest/config';

// Only the setup file: every other setting stays vitest's default, as before this file existed.
export default defineConfig({ test: { setupFiles: ['test/setup/tierQuota.ts'] } });
