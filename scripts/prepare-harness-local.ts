import { copyFile, chmod, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { projectDirectory, projectPath } from "../src/server/local-path.js";

const keepExisting = (error: unknown) => {
  const parsed = z.object({ code: z.string() }).safeParse(error);
  if (parsed.success && parsed.data.code === "EEXIST") return;
  throw error;
};

// Explicit setup: copy existing logins once, with all subsequent agent writes inside var/.
for (const name of ["codex", "grok"]) {
  const root = projectDirectory(`var/${name}-local`);
  const target = projectPath(join(root, "auth.json"));
  await copyFile(
    join(homedir(), `.${name}`, "auth.json"),
    target,
    constants.COPYFILE_EXCL,
  ).catch(keepExisting);
  await chmod(target, 0o600);
}
await writeFile(
  projectPath("var/grok-local/config.toml"),
  "[cli]\nauto_update = false\n",
  { mode: 0o600, flag: "wx" },
).catch(keepExisting);
console.log("Codex / Grok 项目内登录副本已准备，源配置保持原样。");
