import {
  deliveryEventSchema,
  type DeliveryEvent,
  LIMITS,
  type HarnessIdentity,
} from "../shared/protocol.js";
/** 校验本机 HTTP 根地址，返回可直接拼接接口路径的 origin。 */
export function localBase(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw new Error("连接器只允许连接本机 HTTP 根地址");
  return u.origin;
}
export class HttpError extends Error {
  /** 保留响应状态码，方便调用方区分过期领取和可重试的请求故障。 */
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
/** 向已校验的地址发送 JSON，合并调用方取消信号和单次请求超时。 */
export async function post<T>(
  base: string,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(LIMITS.connectorHttpMs)])
      : AbortSignal.timeout(LIMITS.connectorHttpMs),
  });
  const value = await r.json();
  if (!r.ok) throw new HttpError(r.status, value.error ?? "连接器请求失败");
  return value as T;
}
/** 从上次收到的事件 ID 继续订阅，逐条交出校验通过的任务通知。 */
export async function* subscribe(
  base: string,
  after: number,
  signal: AbortSignal,
  identity?: HarnessIdentity & { generation?: string },
  onConnected?: () => void,
): AsyncGenerator<DeliveryEvent> {
  const r = await fetch(localBase(base) + "/connector/events", {
    headers: {
      accept: "text/event-stream",
      "last-event-id": String(after),
      ...(identity
        ? {
            "x-harness-name": identity.harnessName,
            "x-owner-id": identity.ownerId,
            ...(identity.generation
              ? { "x-connector-generation": identity.generation }
              : {}),
          }
        : {}),
    },
    signal,
  });
  if (!r.ok || !r.body) throw new HttpError(r.status, "无法订阅任务事件");
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    // 响应头到达后即可标记本次连接就绪，随后再读历史和实时事件。
    onConnected?.();
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      buffered += decoder.decode(next.value, { stream: true });
      if (buffered.length > LIMITS.httpBytes)
        throw new Error("订阅事件内容超限");
      let split;
      // 网络分块可能截断一条事件，等到空行再解析完整事件帧。
      while ((split = buffered.indexOf("\n\n")) >= 0) {
        const frame = buffered.slice(0, split);
        buffered = buffered.slice(split + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        // 保活等注释帧没有 data，直接跳过。
        if (!data) continue;
        const event = deliveryEventSchema.parse(JSON.parse(data));
        const eventId = frame
          .split("\n")
          .find((l) => l.startsWith("id:"))
          ?.slice(3)
          .trim();
        if (eventId !== String(event.id)) throw new Error("事件 ID 不匹配");
        yield event;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
