import {
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { LIMITS } from "../../../shared/protocol.js";

const exec = promisify(execFile);

async function waitForExit(exited: Promise<void>) {
  const timer = new AbortController();
  try {
    return await Promise.race([
      exited.then(() => true),
      delay(LIMITS.killMs, false, { signal: timer.signal }),
    ]);
  } finally {
    timer.abort();
  }
}

/** 向本次运行的进程组发信号，保留进程组存在的判断。 */
function signalGroup(groupId: number, signal: NodeJS.Signals | 0) {
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ESRCH") return false;
      if (error.code === "EPERM") return true;
    }
    throw error;
  }
}

async function groupHasLiveProcesses(groupId: number) {
  if (!signalGroup(groupId, 0)) return false;
  // 已退出的进程可能以僵尸记录留在组内，按状态判断是否还有实际执行者。
  const listing = await exec("/bin/ps", ["-A", "-o", "pgid=", "-o", "stat="], {
    timeout: LIMITS.killMs,
  }).catch(() => undefined);
  return (
    !listing ||
    listing.stdout
      .trim()
      .split("\n")
      .some((line) => {
        const [group, state] = line.trim().split(/\s+/);
        return (
          Number(group) === groupId &&
          state !== undefined &&
          !state.startsWith("Z")
        );
      })
  );
}

/** 在适配器返回前收尾本次 ACP 主进程和组内后代。 */
export async function stopAcpProcess(
  child: ChildProcessWithoutNullStreams,
  exited: Promise<void>,
) {
  child.stdin.end();
  const stopped = await waitForExit(exited);
  if (process.platform === "win32" || child.pid === undefined) {
    if (!stopped) {
      child.kill("SIGTERM");
      if (!(await waitForExit(exited))) child.kill("SIGKILL");
    }
    await exited;
    return;
  }

  const groupId = child.pid;
  if (!(await groupHasLiveProcesses(groupId))) return;
  signalGroup(groupId, "SIGTERM");
  const deadline = Date.now() + LIMITS.killMs;
  while (await groupHasLiveProcesses(groupId)) {
    if (Date.now() >= deadline) signalGroup(groupId, "SIGKILL");
    await delay(100);
  }
  await exited;
}
