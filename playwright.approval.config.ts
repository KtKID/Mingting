import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import base, { fakePlatform } from "./playwright.config";
const installedChrome =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const archive = z
  .object({
    APPROVAL_REGRESSION_DIR: z.string().min(1),
    APPROVAL_REGRESSION_DB: z.string().min(1),
  })
  .parse(process.env);
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
  webServer: fakePlatform(archive.APPROVAL_REGRESSION_DB),
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
