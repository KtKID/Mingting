import type { TaskMessageScope } from "../../shared/protocol.js";
import type { Store } from "../storage/store.js";
import { AppError } from "../tasks/service.js";

type Peer = "publisher" | "executor";

/** 按任务轮次保存通信消息，并根据方向填入发送方与接收方。 */
export function taskMessage(
  store: Store,
  scope: TaskMessageScope | undefined,
  peer: Peer,
  direction: "receive" | "send",
  type: string,
  content: unknown,
) {
  if (!scope) return;
  const from = direction === "receive" ? peer : "mingting";
  const to = direction === "receive" ? "mingting" : peer;
  store.communication(scope.taskId, scope.taskTurn, from, to, type, content);
}

/** 记录同步操作的请求及响应，失败时记录对外错误并继续抛出异常。 */
export function taskExchange<T>(
  store: Store,
  scope: TaskMessageScope | undefined,
  peer: Peer,
  type: string,
  input: unknown,
  operation: () => T,
): T {
  taskMessage(store, scope, peer, "receive", type, input);
  let result: T;
  try {
    result = operation();
  } catch (error) {
    taskMessage(store, scope, peer, "send", `${type}.response`, {
      error: error instanceof AppError ? error.message : "服务错误",
    });
    throw error;
  }
  taskMessage(store, scope, peer, "send", `${type}.response`, result);
  return result;
}
