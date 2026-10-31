import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import {
  LIMITS,
  claimResultSchema,
  heartbeatResultSchema,
  approvalCreatedSchema,
  permissionResultSchema,
  type DeliveryEvent,
  type Claim,
  type ConnectorUpdate,
} from "../shared/protocol.js";
import { CodexAdapter } from "../server/codex-adapter.js";
import { subscribe, post, localBase, HttpError } from "./transport.js";
export class TaskConnector {
  readonly ownerId = randomUUID();
  private stop = new AbortController();
  private connection?: AbortController;
  private runAbort?: AbortController;
  private loop?: Promise<void>;
  private pumping?: Promise<void>;
  private pending = new Map<string, string>();
  private cursor = 0;
  readonly received: DeliveryEvent[] = [];
  constructor(
    private base: string,
    private adapter: CodexAdapter,
    private onEvent?: (event: DeliveryEvent) => void,
  ) {
    this.base = localBase(base);
  }
  start() {
    if (this.loop) return;
    this.loop = this.listen();
  }
  reconnect() {
    this.connection?.abort();
  }
  private async listen() {
    while (!this.stop.signal.aborted) {
      this.connection = new AbortController();
      try {
        for await (const event of subscribe(
          this.base,
          this.cursor,
          AbortSignal.any([this.stop.signal, this.connection.signal]),
        )) {
          this.cursor = event.id;
          this.received.push(event);
          if (this.received.length > 200) this.received.shift();
          try {
            this.onEvent?.(event);
          } catch {}
          if (!this.pending.has(event.taskId))
            this.pending.set(event.taskId, randomUUID());
          this.kick();
        }
      } catch {}
      if (!this.stop.signal.aborted)
        await delay(LIMITS.reconnectMs, undefined, {
          signal: this.stop.signal,
        }).catch(() => {});
    }
  }
  private kick() {
    if (this.pumping || this.stop.signal.aborted) return;
    this.pumping = this.pump().finally(() => {
      this.pumping = undefined;
      if (this.pending.size && !this.stop.signal.aborted) this.kick();
    });
  }
  private async pump() {
    while (this.pending.size && !this.stop.signal.aborted) {
      const [taskId, claimId] = this.pending.entries().next().value!;
      let claim: Claim;
      try {
        claim = claimResultSchema.parse(
          await post(
            this.base,
            "/connector/claim",
            { taskId, ownerId: this.ownerId, claimId },
            this.stop.signal,
          ),
        );
      } catch (e) {
        if (e instanceof HttpError && [404, 410].includes(e.status)) {
          this.pending.delete(taskId);
          continue;
        }
        await delay(LIMITS.reconnectMs, undefined, {
          signal: this.stop.signal,
        }).catch(() => {});
        continue;
      }
      this.pending.delete(taskId);
      await this.execute(claim);
    }
  }
  private async execute(claim: Claim) {
    const abort = new AbortController();
    this.runAbort = abort;
    const owner = { ownerId: this.ownerId, claimId: claim.claimId };
    let seq = 0,
      queued = 0;
    let reports = Promise.resolve();
    let heartbeatBusy = false;
    const enqueue = (update: ConnectorUpdate) => {
      if (++queued > LIMITS.pendingReports) {
        abort.abort(new Error("状态回传积压"));
        return;
      }
      const current = ++seq;
      reports = reports.then(async () => {
        try {
          await post(this.base, `/connector/runs/${claim.run.id}/report`, {
            ...owner,
            seq: current,
            update,
          });
        } catch (e) {
          abort.abort(new Error("状态回传失败，停止原执行"));
          throw e;
        } finally {
          queued--;
        }
      });
      void reports.catch(() => {});
    };
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
        if (state.cancelRequested) abort.abort(new Error("运行已取消"));
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
    const stop = () => abort.abort(new Error("连接器停止"));
    this.stop.signal.addEventListener("abort", stop, { once: true });
    let status: "succeeded" | "failed" | "cancelled" | "interrupted" = "failed",
      error: string | null = null,
      stopReason: string | null = null;
    try {
      await heartbeat();
      abort.signal.throwIfAborted();
      if (
        claim.workspace !== this.adapter.workspace ||
        claim.mode !== this.adapter.mode
      )
        throw new Error("连接器与平台固定工作区或演示模式不一致，未启动 ACP");
      stopReason = await this.adapter.execute(
        `${claim.task.title}\n\n${claim.task.description}`,
        abort.signal,
        {
          session: (sessionId) => enqueue({ type: "session", sessionId }),
          discovery: (discovery) => enqueue({ type: "discovery", discovery }),
          update: (notification) =>
            enqueue({ type: "notification", notification }),
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
        },
      );
      await reports;
      status =
        stopReason === "end_turn"
          ? "succeeded"
          : stopReason === "cancelled"
            ? "cancelled"
            : "failed";
      if (status === "failed") error = "ACP 回合未正常结束：" + stopReason;
    } catch (e) {
      status = this.stop.signal.aborted ? "interrupted" : "failed";
      error = e instanceof Error ? e.message.slice(0, 2000) : "ACP 执行失败";
    } finally {
      clearInterval(timer);
      clearTimeout(runTimeout);
      this.stop.signal.removeEventListener("abort", stop);
      await reports.catch(() => {});
      try {
        await post(this.base, `/connector/runs/${claim.run.id}/report`, {
          ...owner,
          seq: ++seq,
          update: { type: "finished", status, error, stopReason },
        });
      } catch {}
      this.runAbort = undefined;
    }
  }
  async close() {
    this.stop.abort();
    this.connection?.abort();
    this.runAbort?.abort();
    await this.loop;
    await this.pumping;
  }
}
