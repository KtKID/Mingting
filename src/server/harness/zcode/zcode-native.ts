import { spawn } from "node:child_process";
import { once } from "node:events";
import { z } from "zod";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { LIMITS } from "../../../shared/protocol.js";

// Consumed subset of ZCode CLI 0.17.1's app-server NDJSON dialect.
const idSchema = z.union([z.string(), z.number()]);
const frameSchema = z.object({
  id: idSchema.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .object({ code: z.union([z.number(), z.string()]), message: z.string() })
    .optional(),
});
const responseSchema = z
  .object({
    decision: z.enum(["allow", "deny", "escalate", "modify"]),
  })
  .passthrough();
const permissionSchema = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  reason: z.string().optional(),
  input: z.unknown(),
  options: z
    .array(
      z.object({
        optionId: z.string().min(1),
        kind: z.string(),
        name: z.string(),
        response: responseSchema,
      }),
    )
    .min(1),
});
export const nativeEventSchema = z.object({
  sessionId: z.string(),
  type: z.string(),
  payload: z.unknown(),
  turnId: z.string().optional(),
});
export const nativeSessionSchema = z.object({
  session: z.object({ sessionId: z.string().min(1) }),
});

/** 校验原生审批归属，将 ZCode 审批请求和选项映射到 ACP。 */
export function mapZcodePermission(
  value: unknown,
  nativeSessionId: string,
  sessionId: string,
) {
  const native = permissionSchema.parse(value);
  if (native.sessionId !== nativeSessionId)
    throw new Error("ZCode 审批会话不匹配");
  const choices = native.options.flatMap((option) => {
    // 将已支持的允许与拒绝类别映射为 ACP 选项，跳过其他类别。
    const kind =
      option.kind === "allow_once"
        ? ("allow_once" as const)
        : option.kind === "allow_always"
          ? ("allow_always" as const)
          : ["deny", "deny_once"].includes(option.kind)
            ? ("reject_once" as const)
            : option.kind === "deny_always"
              ? ("reject_always" as const)
              : undefined;
    if (!kind) return [];
    if (
      (kind.startsWith("allow") ? "allow" : "deny") !== option.response.decision
    )
      throw new Error("ZCode 审批选项与响应语义不一致");
    return [
      {
        optionId: option.optionId,
        name: option.name,
        kind,
        response: option.response,
      },
    ];
  });
  if (
    !choices.length ||
    new Set(
      choices.map(
        /* 提取选项 ID，检查映射后是否仍然唯一。 */ (choice) => choice.optionId,
      ),
    ).size !== choices.length
  )
    throw new Error("ZCode 审批选项无效");
  const request: RequestPermissionRequest = {
    sessionId,
    toolCall: {
      toolCallId: native.toolCallId,
      title: native.toolName + " · 操作审批",
      kind: native.toolName === "Read" ? "read" : "other",
      status: "pending",
      rawInput: native.input,
    },
    options: choices.map(
      /* 只向 ACP 调用方提供选项 ID、名称和类别。 */ ({
        optionId,
        name,
        kind,
      }) => ({
        optionId,
        name,
        kind,
      }),
    ),
    _meta: {
      "mingting.dev/approval": {
        title: native.toolName + " · 操作审批",
        description:
          (native.reason ?? "执行者请求执行此操作。") +
          "\n\n" +
          JSON.stringify(native.input, null, 2),
      },
    },
  };
  return { native, choices, request };
}

type NativeId = z.infer<typeof idSchema>;
/** 创建可在协议响应或错误到达后从外部结算的 Promise。 */
export function nativeDeferred<T>() {
  /** 在解析回调绑定前调用时报告初始化错误。 */
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred 尚未初始化");
  };
  /** 在拒绝回调绑定前调用时报告初始化错误。 */
  let reject: (reason: unknown) => void = () => {
    throw new Error("Deferred 尚未初始化");
  };
  const promise = new Promise<T>((yes, no) => {
    // 同步保存 Promise 的解析和拒绝回调。
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export class ZcodeNative {
  private child;
  private nextId = 0;
  private pending = new Map<
    NativeId,
    {
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private incoming = new Map<
    NativeId,
    { fingerprint: string; result: Promise<unknown> }
  >();
  private stopped = false;
  private failure = nativeDeferred<never>();
  readonly failed = this.failure.promise;
  private exited;
  /** 启动 ZCode 原生 app-server，并挂接读取、退出和错误处理。 */
  constructor(
    workspace: string,
    private onRequest: (method: string, params: unknown) => Promise<unknown>,
    private onEvent: (
      value: z.infer<typeof nativeEventSchema>,
    ) => Promise<void>,
  ) {
    this.child = spawn("zcode", ["app-server", "--stdio"], {
      cwd: workspace,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.resume();
    this.child.stdin.on(
      "error",
      /* 吸收连接结束时写入管道可能产生的错误事件。 */ () => {},
    );
    this.exited = once(this.child, "close").catch(
      /* 把关闭等待失败转换为可安全等待的空结果。 */ () => [],
    );
    this.child.once(
      "error",
      /* 把子进程启动错误传播给协议请求。 */ () =>
        this.fail(new Error("ZCode app-server 启动失败")),
    );
    this.child.once("exit", () => {
      // 将连接仍在使用时的子进程退出记为失败。
      if (!this.stopped) this.fail(new Error("ZCode app-server 提前退出"));
    });
    void this.failed.catch(
      /* 提前挂接后台失败处理，避免未处理的拒绝。 */ () => {},
    );
    void this.read().catch(
      /* 把读取循环的异常传播给整个原生连接。 */ (error: unknown) =>
        this.fail(error),
    );
  }
  /** 校验消息字节数，并按 NDJSON 单行写入原生进程。 */
  private write(frame: unknown) {
    if (this.stopped) return;
    const encoded = JSON.stringify(frame);
    if (Buffer.byteLength(encoded) > LIMITS.acpBytes)
      throw new Error("ZCode 发送消息过大");
    this.child.stdin.write(encoded + "\n");
  }
  /** 登记带 ID 和时限的原生请求，并限制待响应请求数量。 */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error("ZCode 连接已结束"));
    if (this.pending.size >= LIMITS.pendingReports)
      return Promise.reject(new Error("ZCode 请求积压"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      // 注册请求完成回调，启动超时计时并发送请求帧。
      const timer = setTimeout(() => {
        // 请求超时后清理登记，并返回带方法名的错误。
        this.pending.delete(id);
        reject(new Error("ZCode 协议请求超时：" + method));
      }, LIMITS.initMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  /** 清理所有挂起请求，向调用方传播连接故障。 */
  private fail(reason: unknown) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(reason);
    }
    this.pending.clear();
    this.failure.reject(reason);
  }
  /** 从标准输出按行读取并分派 NDJSON 消息，限制缓冲区大小。 */
  private async read() {
    let buffer = "";
    for await (const chunk of this.child.stdout.setEncoding("utf8")) {
      buffer += chunk;
      let split: number;
      while ((split = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, split);
        buffer = buffer.slice(split + 1);
        if (Buffer.byteLength(line) > LIMITS.acpBytes)
          throw new Error("ZCode 单条消息过大");
        if (line.trim()) await this.receive(JSON.parse(line));
      }
      if (Buffer.byteLength(buffer) > LIMITS.acpBytes)
        throw new Error("ZCode 单条消息过大");
    }
    if (buffer.trim()) throw new Error("ZCode 帧未完整结束");
  }
  /** 区分原生请求、响应和通知，复用重复请求的处理结果。 */
  private async receive(value: unknown) {
    const frame = frameSchema.parse(value);
    if (frame.method && frame.id !== undefined) {
      const id = frame.id;
      const fingerprint = JSON.stringify({
        method: frame.method,
        params: frame.params,
      });
      let existing = this.incoming.get(id);
      if (existing && existing.fingerprint !== fingerprint)
        throw new Error("ZCode 重复请求内容变化");
      if (!existing) {
        if (this.incoming.size >= LIMITS.pendingReports)
          throw new Error("ZCode 反向请求数量超限");
        existing = {
          fingerprint,
          result: this.onRequest(frame.method, frame.params),
        };
        this.incoming.set(id, existing);
      }
      // The read loop must continue while a permission response is pending.
      void existing.result
        .then(
          /* 用当前请求 ID 发回已解析的原生处理结果。 */ (result) =>
            this.write({ id, result }),
          /* 原生请求处理失败时发回协议错误。 */ () =>
            this.write({
              id,
              error: {
                code: -32601,
                message: "明庭未支持此原生请求或请求已失效",
              },
            }),
        )
        .catch(
          /* 发送响应失败时终止连接并通知挂起请求。 */ (error: unknown) =>
            this.fail(error),
        );
    } else if (frame.method === "session/event") {
      await this.onEvent(nativeEventSchema.parse(frame.params));
    } else if (frame.method) {
      // Other state/resource notifications carry no execution authority.
    } else if (frame.id !== undefined) {
      const request = this.pending.get(frame.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(frame.id);
      if (frame.error)
        request.reject(
          new Error(`ZCode ${frame.error.code}: ${frame.error.message}`),
        );
      else request.resolve(frame.result);
    } else throw new Error("ZCode 协议帧缺少标识");
  }
  /** 幂等关闭连接，结束输入并等待子进程退出。 */
  async close() {
    if (this.stopped) return;
    this.stopped = true;
    this.fail(new Error("ZCode 连接已关闭"));
    this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    const timer = setTimeout(
      /* 宽限期到期后强制结束 ZCode 子进程。 */ () =>
        this.child.kill("SIGKILL"),
      LIMITS.killMs,
    );
    await this.exited;
    clearTimeout(timer);
  }
}
