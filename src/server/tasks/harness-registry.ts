import {
  isAuditedHarness,
  type CapabilityReport,
  type CapabilitySnapshot,
  type HarnessIdentity,
  type HarnessSubscription,
  type Task,
} from "../../shared/protocol.js";
import { AppError } from "./app-error.js";

export class HarnessRegistry {
  constructor(private changed: () => void) {}

  private subscriptions = new Map<
    string,
    {
      identity: HarnessIdentity;
      connections: number;
      generation?: string;
      capabilities?: CapabilitySnapshot;
    }
  >();
  /** 登记执行器连接，校验身份绑定并更新当前连接代次。 */
  registerHarness(identity: HarnessIdentity, generation?: string) {
    const current = this.subscriptions.get(identity.ownerId);
    if (
      current &&
      current.identity.harnessName.toLowerCase() !==
        identity.harnessName.toLowerCase()
    )
      throw new AppError(409, "ownerId 已绑定其他 harness");
    const entry = current ?? { identity, connections: 0 };
    entry.connections++;
    if (generation) {
      entry.generation = generation;
      entry.capabilities = undefined;
    }
    this.subscriptions.set(identity.ownerId, entry);
    this.changed();
    let closed = false;
    return () => {
      // 幂等注销当前连接，只清理属于该代次的能力快照。
      if (closed) return;
      closed = true;
      if (--entry.connections === 0)
        this.subscriptions.delete(identity.ownerId);
      if (generation && entry.generation === generation) {
        entry.generation = undefined;
        entry.capabilities = undefined;
      }
      this.changed();
    };
  }
  /** 只接收当前受审计连接代次的能力上报，并通知订阅者。 */
  reportCapabilities(report: CapabilityReport) {
    const entry = this.subscriptions.get(report.ownerId);
    if (
      !entry ||
      !isAuditedHarness(entry.identity.harnessName) ||
      entry.generation !== report.generation
    )
      throw new AppError(409, "能力快照不属于当前执行器连接");
    entry.capabilities = report.capabilities;
    this.changed();
  }
  /** 列出在线执行器及已收到的能力快照。 */
  harnesses(): HarnessSubscription[] {
    return [...this.subscriptions.values()].map(
      /* 展开连接身份，存在能力快照时附到结果。 */ (s) => ({
        ...s.identity,
        ...(s.capabilities ? { capabilities: s.capabilities } : {}),
      }),
    );
  }

  /** 校验认领者当前的连接代次与任务指定的执行器。 */
  claimIdentity(task: Task, ownerId: string, generation?: string) {
    const subscription = this.subscriptions.get(ownerId);
    if (generation && subscription?.generation !== generation)
      throw new AppError(409, "领取请求不属于当前订阅连接");
    const identity = subscription?.identity;
    if (
      task.targetHarness &&
      identity?.harnessName.toLowerCase() !== task.targetHarness.toLowerCase()
    )
      throw new AppError(403, "请以目标 harness 身份保持在线订阅后领取");
    return identity;
  }
}
