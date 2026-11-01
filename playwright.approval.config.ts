import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import base from "./playwright.config";
const installedChrome =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const archive = z
  .object({
    APPROVAL_REGRESSION_DIR: z.string().min(1),
    APPROVAL_REGRESSION_DB: z.string().min(1),
  })
  .parse(process.env);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export default defineConfig({
  ...base,
  testMatch: "approval-replay-ui.spec.ts",
  outputDir: resolve(archive.APPROVAL_REGRESSION_DIR, "browser"),
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: resolve(archive.APPROVAL_REGRESSION_DIR, "playwright.json"),
      },
    ],
  ],
  webServer: {
    command: `PORT=60391 FAKE_ACP=1 TASK_DB=${quote(archive.APPROVAL_REGRESSION_DB)} npm start`,
    url: "http://127.0.0.1:60391/api/bootstrap",
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "recorded-e2e",
      use: { viewport: { width: 1440, height: 1100 }, colorScheme: "light" },
    },
  ],
  use: {
    ...base.use,
    trace: "on",
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
        (existsSync(installedChrome) ? installedChrome : undefined),
    },
  },
});
