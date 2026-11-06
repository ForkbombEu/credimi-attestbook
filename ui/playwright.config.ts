import { defineConfig, devices } from '@playwright/test'

/**
 * Browser tests for the catalog UI. The web server runs the real AttestBook
 * application with the built UI and seeded API data (see ./e2e/server.ts).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // One shared in-memory registry backs every spec. The editor suite creates a
  // rulebook to exercise the authorized create flow, so specs must not run in
  // parallel or the catalog's seeded counts would change mid-run.
  workers: 1,
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
