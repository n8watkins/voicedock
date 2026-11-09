// End-to-end tests: the unpacked extension in Chromium against fake engines on
// port 7477 (e2e/fake-engines.mjs). Screenshot baselines exist for
// light and dark at 1x and 2x.
//
//   npm run test:e2e             (CI, or a machine with nothing on those ports)
//   npm run test:e2e:isolated    (in a private network namespace, beside real engines)
//   npm run test:e2e -- --update-snapshots
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.mjs',
  // The fake engines hold fixed ports, so tests share one worker.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}{ext}',
  expect: {
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.002 },
  },
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'light-1x', use: { colorScheme: 'light', deviceScaleFactor: 1 } },
    { name: 'dark-1x', use: { colorScheme: 'dark', deviceScaleFactor: 1 } },
    { name: 'light-2x', use: { colorScheme: 'light', deviceScaleFactor: 2 } },
    { name: 'dark-2x', use: { colorScheme: 'dark', deviceScaleFactor: 2 } },
  ],
});
