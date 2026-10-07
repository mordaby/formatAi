import { defineConfig } from 'vitest/config';

// The setup file pins the plans' AI quotas (see there). `globalSetup` drops the suite's throwaway databases on a LOCAL MongoDB before and
// after the run (test/setup/testDbs.ts). `testTimeout`: the MongoDB tests run many files in parallel against one local server, and 5 s
// (vitest's default) timed some of them out under that load.
export default defineConfig({
  test: {
    setupFiles: ['test/setup/tierQuota.ts'],
    globalSetup: ['test/setup/testDbs.ts'],
    testTimeout: 15_000,
  },
});
