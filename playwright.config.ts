import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const baseURL = "http://127.0.0.1:60391";
const archive = process.env.APPROVAL_REGRESSION_DIR;

export function fakePlatform(database: string) {
  return {
    command: "node --import tsx src/server/main.ts",
    env: {
      PORT: new URL(baseURL).port,
      FAKE_ACP: "1",
      TASK_DB: database,
      TASK_WORKSPACE: database + ".workspace",
      TASK_CONNECTOR: "auto",
      TASK_HARNESS: "Codex",
      TASK_HARNESSES: "Codex",
      TASK_AUTH: "existing",
      MINGTING_CODEX_WAKEUPS: "0",
    },
    url: baseURL + "/api/bootstrap",
    reuseExistingServer: false,
  };
}

export default defineConfig({
  testDir: "tests",
  testMatch: "ui.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  ...(archive
    ? {
        outputDir: resolve(archive, "ui-browser"),
        reporter: [
          ["list"],
          ["json", { outputFile: resolve(archive, "ui-playwright.json") }],
        ],
      }
    : {}),
  use: {
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : undefined,
    baseURL,
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
  webServer: fakePlatform(
    process.env.UI_REGRESSION_DB ??
      join(tmpdir(), `task-platform-ui-${process.pid}.sqlite`),
  ),
});
