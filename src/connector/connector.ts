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
import type { RunHooks, TaskExecutor } from "../server/acp-adapter.js";
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
  private generation?: string;
  private probe?: Promise<void>;
  private probeAbort?: AbortController;
  private probed = false;
  readonly received: DeliveryEvent[] = [];
  constructor(
    private base: string,
    private adapter: TaskExecutor,
    private onEvent?: (event: DeliveryEvent) => void,
    readonly harnessName = "Codex",
    private acceptsTask?: (taskId: string) => boolean,
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
      const generation = randomUUID();
      try {
        for await (const event of subscribe(
          this.base,
          this.cursor,
          AbortSignal.any([this.stop.signal, this.connection.signal]),
          { ownerId: this.ownerId, harnessName: this.harnessName, generation },
          () => {
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
          if (!this.pending.has(event.taskId))
            this.pending.set(event.taskId, randomUUID());
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
        if (generation === this.generation && !abort.signal.aborted)
          this.probed = true;
        this.probe = undefined;
        this.probeAbort = undefined;
        this.maybeProbe();
      });
  }
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
  private async pump() {
    while (
      this.pending.size &&
      !this.stop.signal.aborted &&
      this.generation &&
      !this.connection?.signal.aborted
    ) {
      const [taskId, claimId] = this.pending.entries().next().value!;
      let claim: Claim;
      try {
        claim = claimResultSchema.parse(
          await post(
            this.base,
            "/connector/claim",
            {
              taskId,
              ownerId: this.ownerId,
              claimId,
              generation: this.generation,
            },
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
    let cancelled = false;
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
    const stop = () => abort.abort(new Error("连接器停止"));
    this.stop.signal.addEventListener("abort", stop, { once: true });
    let status: "succeeded" | "failed" | "cancelled" | "interrupted" = "failed",
      error: string | null = null,
      stopReason: string | null = null;
    let usage: RunUsage | undefined;
    try {
      await heartbeat();
      abort.signal.throwIfAborted();
      if (
        claim.workspace !== this.adapter.workspace ||
        claim.mode !== this.adapter.mode
      )
        throw new Error("连接器与平台固定工作区或演示模式不一致，未启动 ACP");
      const text = `${claim.task.title}\n\n${claim.task.description}`;
      const hooks: RunHooks = {
        session: (sessionId) => enqueue({ type: "session", sessionId }),
        discovery: (discovery) => enqueue({ type: "discovery", discovery }),
        update: (notification) =>
          enqueue({ type: "notification", notification }),
        context: (sessionId, observation) =>
          enqueue({ type: "context", sessionId, observation }),
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
  async close() {
    this.stop.abort();
    this.connection?.abort();
    this.runAbort?.abort();
    await this.loop;
    await this.pumping;
    await this.probe;
  }
}
