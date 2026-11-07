import type { z } from "zod";
import type { subscriberDecisionSchema } from "../../../shared/protocol.js";
import type { TaskService } from "../../tasks/service.js";
import { taskExchange } from "../task-communication.js";

/** 校验订阅者凭据，并按审批所属运行记录发起方的审批意见。 */
export function subscriberDecision(
  service: TaskService,
  input: z.infer<typeof subscriberDecisionSchema>,
) {
  const { store } = service;
  service.requireSubscriber(input);
  const approval = store.approval(input.approvalId);
  const scope =
    approval?.taskId === input.taskId
      ? store.runMessageScope(approval.runId)
      : store.taskMessageScope(input.taskId);
  return taskExchange(
    store,
    scope,
    "publisher",
    "approval.decision",
    input,
    () => {
      // 保存订阅者的审批选择并返回确认。
      service.decideSubscriber(input);
      return { ok: true };
    },
  );
}
