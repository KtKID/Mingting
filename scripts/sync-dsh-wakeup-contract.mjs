/** 将明庭权威 schema 同步到指定的宿主生成文件，支持只读漂移检查。 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [target, option] = process.argv.slice(2);
if (!target || (option !== undefined && option !== "--check"))
  throw new Error("用法：sync-dsh-wakeup-contract.mjs <目标文件> [--check]");
const source = await readFile(
  new URL("../src/shared/dsh-wakeup.ts", import.meta.url),
  "utf8",
);
const generated =
  "/** 由明庭 scripts/sync-dsh-wakeup-contract.mjs 生成。 */\n" + source;
const path = resolve(target);
if (option === "--check") {
  if ((await readFile(path, "utf8")) !== generated)
    throw new Error("宿主契约与明庭不一致");
} else {
  await writeFile(path, generated);
}
