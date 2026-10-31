import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  testMatch: "ui.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : undefined,
    baseURL: "http://127.0.0.1:60391",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { viewport: { width: 1440, height: 1000 }, colorScheme: "light" },
    },
    {
      name: "mobile-dark",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        colorScheme: "dark",
      },
    },
  ],
  webServer: {
    command: `PORT=60391 FAKE_ACP=1 TASK_DB=/tmp/task-platform-ui-${process.pid}.sqlite npm start`,
    url: "http://127.0.0.1:60391/api/bootstrap",
    reuseExistingServer: false,
  },
});
