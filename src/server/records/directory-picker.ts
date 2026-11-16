import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { AppError } from "../tasks/service.js";

const exec = promisify(execFile);
const dialogTimeoutMs = 120_000;
const gitTimeoutMs = 5_000;
export const projectDirectoryRequestTimeoutMs =
  dialogTimeoutMs + gitTimeoutMs + 5_000;
const processErrorSchema = z.object({
  code: z.union([z.string(), z.number()]),
});

const chooseFolderScript = `
on run argv
  try
    set initialFolder to (POSIX file (item 1 of argv)) as alias
    set selectedFolder to choose folder with prompt "选择明庭项目文件夹" default location initialFolder
    return POSIX path of selectedFolder
  on error number -128
    return ""
  end try
end run
`;

export type ProjectDirectoryDialog = (
  signal: AbortSignal,
) => Promise<string | null>;

export const chooseMacProjectDirectory: ProjectDirectoryDialog = async (
  signal,
) => {
  if (process.platform !== "darwin") {
    throw new AppError(501, "系统文件夹选择目前支持 macOS，请手填项目目录。");
  }
  try {
    const { stdout } = await exec(
      "/usr/bin/osascript",
      ["-e", chooseFolderScript, process.cwd()],
      { signal, timeout: dialogTimeoutMs, maxBuffer: 16_384 },
    );
    return stdout.replace(/\n$/, "") || null;
  } catch {
    throw new AppError(
      503,
      "无法完成 macOS 文件夹选择，请重试或手填项目目录。",
    );
  }
};

/** 定位选中目录所在的工作树，支持子目录、子模块和链接工作树。 */
export async function projectDirectoryFromGit(
  directory: string,
  signal: AbortSignal,
) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  try {
    const selected = await realpath(directory);
    const { stdout } = await exec(
      "git",
      ["-C", selected, "rev-parse", "--show-toplevel"],
      { env, signal, timeout: gitTimeoutMs, maxBuffer: 16_384 },
    );
    const projectRoot = await realpath(stdout.replace(/\n$/, ""));
    const within = relative(projectRoot, selected);
    if (
      within === ".." ||
      within.startsWith(".." + sep) ||
      isAbsolute(within)
    ) {
      throw new AppError(422, "所选文件夹不在解析出的 Git 工作树内。");
    }
    return { projectRoot, projectName: basename(projectRoot) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = processErrorSchema.safeParse(error).data?.code;
    if (code === 128) {
      throw new AppError(
        422,
        "所选文件夹不在可识别的 Git 工作树内，可手填项目目录。",
      );
    }
    throw new AppError(
      503,
      "无法读取所选文件夹的 Git 根目录，请检查目录和 Git 是否可用。",
    );
  }
}
