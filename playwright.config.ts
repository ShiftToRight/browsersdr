import { defineConfig } from "@playwright/test";

const devPort = Number(process.env.BSD_E2E_DEV_PORT ?? 43173);
const productionPort = Number(process.env.BSD_E2E_PRODUCTION_PORT ?? 43174);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  // Bound simultaneous real DSP/audio/browser pipelines on local hosts too.
  workers: process.env.CI ? 1 : 2,
  retries: process.env.CI ? 1 : 0,
  timeout: 20_000,
  expect: { timeout: 7_000 },
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    acceptDownloads: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 1000 },
  },
  projects: [
    {
      name: "chromium-dev",
      use: { browserName: "chromium", baseURL: `http://127.0.0.1:${devPort}` },
    },
    {
      name: "chromium-production",
      use: {
        browserName: "chromium",
        baseURL: `http://127.0.0.1:${productionPort}`,
      },
    },
  ],
  webServer: [
    {
      name: "vite-development",
      command: `npm run dev -- --host 127.0.0.1 --port ${devPort} --strictPort`,
      url: `http://127.0.0.1:${devPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      name: "vite-production-preview",
      command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${productionPort} --strictPort`,
      url: `http://127.0.0.1:${productionPort}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
