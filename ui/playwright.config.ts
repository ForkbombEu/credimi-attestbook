import { defineConfig, devices } from '@playwright/test'

/**
 * Browser tests for the catalog UI. The web server runs the real AttestBook
 * application with the built UI and seeded API data (see ./e2e/server.ts).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'bun run build:ui && bun ui/e2e/server.ts',
    cwd: '..',
    url: 'http://127.0.0.1:4173/health',
    timeout: 180_000,
    reuseExistingServer: false,
  },
})
