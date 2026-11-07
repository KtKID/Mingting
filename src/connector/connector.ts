import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import {
  LIMITS,
  isAuditedHarness,
  claimResultSchema,
  heartbeatResultSchema,
  approvalCreatedSchema,
  permissionResultSchema,
  type DeliveryEvent,
  type Claim,
  type ConnectorUpdate,
  type RunUsage,
} from "../shared/protocol.js";
import type {
  RunHooks,
  TaskExecutor,
} from "../server/harness/acp/acp-adapter.js";
import { subscribe, post, localBase, HttpError } from "./transport.js";
/** 订阅本机任务通知，串行领取和执行，并将过程、审批和结果接回明庭。 */
export class TaskConnector {
  readonly ownerId = randomUUID();
  private stop = new AbortController();
  private connection?: AbortController;
  private runAbort?: AbortController;
  private loop?: Promise<void>;
  private pumping?: Promise<void>;
  // 同一任务的不同轮次各有领取事件，按事件 ID 排队并为每项保留重试用的领取 ID。
  private pending = new Map<number, { taskId: string; claimId: string }>();
  private cursor = 0;
  private generation?: string;
  private probe?: Promise<void>;
  private probeAbort?: AbortController;
  private probed = false;
  readonly received: DeliveryEvent[] = [];
  /** 绑定本机平台、执行器和订阅身份，可选回调观察事件，筛选器限制可领取任务。 */
  constructor(
    private base: string,
    private adapter: TaskExecutor,
    private onEvent?: (event: DeliveryEvent) => void,
    readonly harnessName = "Codex",
    private acceptsTask?: (taskId: string) => boolean,
  ) {
    this.base = localBase(base);
  }
  /** 启动后台订阅循环，重复调用沿用已有循环。 */
  start() {
    if (this.loop) return;
    this.loop = this.listen();
  }
  /** 断开当前订阅，由监听循环按原游标重连，运行继续通过独立心跳保活。 */
  reconnect() {
    this.connection?.abort();
  }
  /** 持续接收和补收任务通知，记录游标，并把可领取的事件交给处理循环。 */
  private async listen() {
    while (!this.stop.signal.aborted) {
      this.connection = new AbortController();
      const generation = randomUUID();
      try {
        for await (const event of subscribe(
          this.base,
          this.cursor,
          AbortSignal.any([this.stop.signal, this.connection.signal]),
          { ownerId: this.ownerId, harnessName: this.harnessName, generation },
          () => {
            // 每次订阅使用新代次，后续领取和能力上报关联本次连接。
            this.generation = generation;
            this.probed = false;
            if (this.pending.size) this.kick();
            else this.maybeProbe();
          },
        )) {
          this.cursor = event.id;
          this.received.push(event);
          if (this.received.length > 200) this.received.shift();
          try {
            this.onEvent?.(event);
          } catch {}
          if (this.acceptsTask && !this.acceptsTask(event.taskId)) continue;
          if (!this.pending.has(event.id))
            this.pending.set(event.id, {
              taskId: event.taskId,
              claimId: randomUUID(),
            });
          this.kick();
        }
      } catch {
      } finally {
        this.generation = undefined;
        this.probeAbort?.abort();
      }
      if (!this.stop.signal.aborted)
        await delay(LIMITS.reconnectMs, undefined, {
          signal: this.stop.signal,
        }).catch(() => {});
    }
  }
  /** 空闲时发现执行器提供的模型与档位，将快照绑定到当前订阅代次。 */
  private maybeProbe() {
    if (
      !isAuditedHarness(this.harnessName) ||
      !this.generation ||
      this.stop.signal.aborted ||
      this.probed ||
      this.probe ||
      this.pumping ||
      this.pending.size ||
      !this.adapter.probeCapabilities
    )
      return;
    const generation = this.generation;
    const abort = new AbortController();
    this.probeAbort = abort;
    this.probe = this.adapter
      .probeCapabilities(abort.signal)
      .then(async (capabilities) => {
        if (capabilities && !abort.signal.aborted)
          await post(
            this.base,
            "/connector/capabilities",
            { ownerId: this.ownerId, generation, capabilities },
            abort.signal,
          );
      })
      .catch(() => {})
      .finally(() => {
        // 同一代次中，完成或失败的探测记为已尝试。被取消的探测可在空闲时再跑。
        if (generation === this.generation && !abort.signal.aborted)
          this.probed = true;
        this.probe = undefined;
        this.probeAbort = undefined;
        this.maybeProbe();
      });
  }
  /** 在线时唤起唯一的领取循环，有任务时优先发出取消能力探测的信号。 */
  private kick() {
    if (
      this.pumping ||
      this.stop.signal.aborted ||
      !this.generation ||
      this.connection?.signal.aborted
    )
      return;
    this.probeAbort?.abort();
    this.pumping = this.pump().finally(() => {
      this.pumping = undefined;
      if (this.pending.size && !this.stop.signal.aborted) this.kick();
      else this.maybeProbe();
    });
  }
  /** 按入队顺序领取任务，等当前运行结束后再处理下一条。 */
  private async pump() {
    while (
      this.pending.size &&
      !this.stop.signal.aborted &&
      this.generation &&
      !this.connection?.signal.aborted
    ) {
      const [deliveryId, { taskId, claimId }] = this.pending
        .entries()
        .next().value!;
      let claim: Claim;
      try {
        claim = claimResultSchema.parse(
          await post(
            this.base,
            "/connector/claim",
            {
              taskId,
              deliveryId,
              ownerId: this.ownerId,
              claimId,
              generation: this.generation,
            },
            this.stop.signal,
          ),
        );
      } catch (e) {
        // 任务缺失或事件过期时移出队列，其余错误保留原领取 ID 并延时重试。
        if (e instanceof HttpError && [404, 410].includes(e.status)) {
          this.pending.delete(deliveryId);
          continue;
        }
        await delay(LIMITS.reconnectMs, undefined, {
          signal: this.stop.signal,
        }).catch(() => {});
        continue;
      }
      this.pending.delete(deliveryId);
      await this.execute(claim);
    }
  }
  /** 为已领取的运行维护租约，驱动执行器，并回报进度、审批和终态。 */
  private async execute(claim: Claim) {
    const abort = new AbortController();
    this.runAbort = abort;
    const owner = { ownerId: this.ownerId, claimId: claim.claimId };
    let seq = 0,
      queued = 0;
    let reports = Promise.resolve();
    let heartbeatBusy = false;
    let cancelled = false;
    /** 为回报分配本次运行的序号，依次等待平台确认，失败或积压超限时中止执行。 */
    const enqueue = (update: ConnectorUpdate) => {
      if (++queued > LIMITS.pendingReports) {
        abort.abort(new Error("状态回传积压"));
        return reports;
      }
      const current = ++seq;
      reports = reports.then(async () => {
        try {
          const path = `/connector/runs/${claim.run.id}/report`;
          const body = {
            ...owner,
            seq: current,
            update,
          };
          try {
            await post(this.base, path, body);
          } catch (error) {
            if (
              update.type !== "settings" ||
              error instanceof HttpError ||
              abort.signal.aborted
            )
              throw error;
            // 设置回执遇到非 HTTP 状态错误时，用原序号再发一次，服务端可识别已提交的回执。
            await post(this.base, path, body);
          }
        } catch (e) {
          abort.abort(new Error("状态回传失败，停止原执行"));
          throw e;
        } finally {
          queued--;
        }
      });
      void reports.catch(() => {});
      return reports;
    };
    /** 定期续期本次运行的领取租约，同时接收平台取消指令。 */
    const heartbeat = async () => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      try {
        const state = heartbeatResultSchema.parse(
          await post(
            this.base,
            `/connector/runs/${claim.run.id}/heartbeat`,
            owner,
          ),
        );
        if (state.cancelRequested) {
          cancelled = true;
          abort.abort(new Error("运行已取消"));
        }
      } catch {
        abort.abort(new Error("领取心跳失败，停止原执行"));
      } finally {
        heartbeatBusy = false;
      }
    };
    const timer = setInterval(() => void heartbeat(), LIMITS.heartbeatMs);
    const runTimeout = setTimeout(
      () => abort.abort(new Error("执行超时")),
      LIMITS.runMs,
    );
    /** 将连接器停止信号转为当前执行的取消信号。 */
    const stop = () => abort.abort(new Error("连接器停止"));
    this.stop.signal.addEventListener("abort", stop, { once: true });
    let status: "succeeded" | "failed" | "cancelled" | "interrupted" = "failed",
      error: string | null = null,
      stopReason: string | null = null;
    let usage: RunUsage | undefined;
    try {
      await heartbeat();
      abort.signal.throwIfAborted();
      // 平台和执行器对工作区及演示模式达成一致后才启动本次 ACP 执行。
      if (
        claim.workspace !== this.adapter.workspace ||
        claim.mode !== this.adapter.mode
      )
        throw new Error("连接器与平台固定工作区或演示模式不一致，未启动 ACP");
      const text = `${claim.task.title}\n\n${claim.task.description}`;
      const hooks: RunHooks = {
        // 会话、初始化信息、流式通知和上下文观测共用同一条回报队列。
        session: (sessionId) => enqueue({ type: "session", sessionId }),
        discovery: (discovery) => enqueue({ type: "discovery", discovery }),
        update: (notification) =>
          enqueue({ type: "notification", notification }),
        context: (sessionId, observation) =>
          enqueue({ type: "context", sessionId, observation }),
        /** 先等已排队回报提交，再登记审批并轮询平台裁决，将原始选项交回 ACP。 */
        permission: async (
          requestId,
          request,
          signal,
        ): Promise<RequestPermissionResponse> => {
          try {
            await reports;
            const created = approvalCreatedSchema.parse(
              await post(
                this.base,
                `/connector/runs/${claim.run.id}/permissions`,
                { ...owner, requestId, request },
                abort.signal,
              ),
            );
            while (!signal.aborted && !abort.signal.aborted) {
              const result = permissionResultSchema.parse(
                await post(
                  this.base,
                  `/connector/runs/${claim.run.id}/permissions/${created.approvalId}/result`,
                  owner,
                  abort.signal,
                ),
              );
              if (result.status === "resolved") return result.response!;
              await delay(LIMITS.approvalPollMs, undefined, {
                signal: AbortSignal.any([signal, abort.signal]),
              });
            }
            return { outcome: { outcome: "cancelled" } };
          } catch (e) {
            if (signal.aborted || abort.signal.aborted)
              return { outcome: { outcome: "cancelled" } };
            abort.abort(new Error("审批回传失败"));
            throw e;
          }
        },
      };
      if (isAuditedHarness(this.harnessName) && this.adapter.executeTask) {
        const result = await this.adapter.executeTask(
          text,
          abort.signal,
          hooks,
          claim.task.requestedSettings,
          // 适配器等设置回执提交后才发送任务正文。
          (sessionId, receipt) =>
            enqueue({ type: "settings", sessionId, receipt }),
        );
        ({ stopReason, usage } = result);
        if (result.error) throw new Error(result.error);
        if (abort.signal.aborted && !cancelled) abort.signal.throwIfAborted();
      } else {
        if (claim.task.requestedSettings) {
          const reason = "当前执行器无法确认任务设置";
          await enqueue({
            type: "settings",
            sessionId: null,
            receipt: {
              status: "rejected",
              modelId: null,
              reasoningEffort: null,
              modelWindow: null,
              reason,
              confirmedAt: new Date().toISOString(),
            },
          });
          throw new Error(reason);
        }
        stopReason = await this.adapter.execute(text, abort.signal, hooks);
      }
      await reports;
      status =
        stopReason === "end_turn"
          ? "succeeded"
          : stopReason === "cancelled"
            ? "cancelled"
            : "failed";
      if (status === "failed") error = "ACP 回合未正常结束：" + stopReason;
    } catch (e) {
      status = cancelled
        ? "cancelled"
        : this.stop.signal.aborted
          ? "interrupted"
          : "failed";
      error = e instanceof Error ? e.message.slice(0, 2000) : "ACP 执行失败";
    } finally {
      clearInterval(timer);
      clearTimeout(runTimeout);
      this.stop.signal.removeEventListener("abort", stop);
      await reports.catch(() => {});
      // 尽力用下一个序号提交终态。平台未收到终态时，按租约到期处理。
      try {
        await post(this.base, `/connector/runs/${claim.run.id}/report`, {
          ...owner,
          seq: ++seq,
          update: { type: "finished", status, error, stopReason, usage },
        });
      } catch {}
      this.runAbort = undefined;
    }
  }
  /** 中止订阅、执行与能力探测，等已启动的后台流程退出。 */
  async close() {
    this.stop.abort();
    this.connection?.abort();
    this.runAbort?.abort();
    await this.loop;
    await this.pumping;
    await this.probe;
  }
}
