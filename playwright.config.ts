import { defineConfig } from "@playwright/test";

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
      use: { browserName: "chromium", baseURL: "http://127.0.0.1:43173" },
    },
    {
      name: "chromium-production",
      use: { browserName: "chromium", baseURL: "http://127.0.0.1:43174" },
    },
  ],
  webServer: [
    {
      name: "vite-development",
      command: "npm run dev -- --host 127.0.0.1 --port 43173 --strictPort",
      url: "http://127.0.0.1:43173",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      name: "vite-production-preview",
      command:
        "npm run build && npm run preview -- --host 127.0.0.1 --port 43174 --strictPort",
      url: "http://127.0.0.1:43174",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
