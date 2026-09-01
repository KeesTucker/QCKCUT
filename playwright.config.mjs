import { defineConfig } from '@playwright/test';

const PORT = 5173;

export default defineConfig({
  testDir: 'test',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? 'line' : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  // Vite serves the app and the test fixtures straight from source.
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
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
