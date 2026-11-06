import {
  deliveryEventSchema,
  type DeliveryEvent,
  LIMITS,
  type HarnessIdentity,
} from "../shared/protocol.js";
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
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
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
    onConnected?.();
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      buffered += decoder.decode(next.value, { stream: true });
      if (buffered.length > LIMITS.httpBytes)
        throw new Error("订阅事件内容超限");
      let split;
      while ((split = buffered.indexOf("\n\n")) >= 0) {
        const frame = buffered.slice(0, split);
        buffered = buffered.slice(split + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
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
