import type { TaskMessageScope } from "../../shared/protocol.js";
import type { Store } from "../storage/store.js";
import { AppError } from "../tasks/service.js";

type Peer = "publisher" | "executor";

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
