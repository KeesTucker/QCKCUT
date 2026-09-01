import { defineConfig } from '@playwright/test';

const PORT = 5173;

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? 'line' : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  // The dev server is the app; there is no build step.
  webServer: {
    command: `node server.mjs`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
  },
  projects: [
    // Renders the test clips once, so specs never pay for encoding.
    { name: 'setup', testMatch: /fixtures\.setup\.mjs/, use: { channel: 'chrome' } },
    { name: 'ui', testMatch: /ui\/.*\.spec\.mjs/, dependencies: ['setup'], use: { channel: 'chrome' } },
  ],
});
