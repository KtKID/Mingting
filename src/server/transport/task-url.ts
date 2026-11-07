import type { Request } from "express";

/** 为发单回执附上当前本机服务的任务详情地址。 */
export function withTaskUrl<T extends { taskId: string }>(
  req: Request,
  receipt: T,
) {
  return {
    ...receipt,
    taskUrl: `http://${req.headers.host}/?task=${receipt.taskId}`,
  };
}
