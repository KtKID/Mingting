import { Router, type Request } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  publisherContextKey,
  taskCommandDescription,
  publishTaskToolName,
} from "../../shared/host-wakeup.js";
import {
  approvalSubscriptionSchema,
  approvalWaitSchema,
  mcpTaskCommandSchema,
  subscriberDecisionSchema,
  type TaskMessageScope,
} from "../../shared/protocol.js";
import { wakeupAcknowledgementSchema } from "../../shared/task-wakeup.js";
import { AppError, type TaskService } from "../tasks/service.js";
import type { HostPublisher } from "../tasks/publication.js";
import { subscriberDecision } from "./subscriber/decision.js";
import { taskExchange, taskMessage } from "./task-communication.js";
import { withTaskUrl } from "./task-url.js";

/** 提供 MCP 工具，并为每个请求组装独立的 MCP 传输。 */
export function mcpRouter(
  service: TaskService,
  readPublisher?: (request: Request, raw: unknown) => HostPublisher,
) {
  const router = Router();
  const { store } = service;
  router.post("/mcp", async (req, res) => {
    // 为当前请求创建无会话的 MCP 服务，注册工具并处理请求。
    const mcp = new McpServer({ name: "task-platform-mvp", version: "0.2.0" });
    mcp.registerTool(
      publishTaskToolName,
      {
        title: "发布任务",
        description:
          taskCommandDescription +
          "发布任务并立即返回回执。resultSubscription 用于订阅执行结果。approvalTargets 默认 [subscriber]，也可 [] 由用户在明庭审批。订阅者审批沿用 approvalSubscription。",
        inputSchema: mcpTaskCommandSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (input, extra) => {
        // 处理 MCP 新建或追加发单，按宿主上下文鉴权并记录回执。
        let failedAppend: TaskMessageScope | undefined;
        try {
          const raw = extra._meta?.[publisherContextKey];
          if (raw !== undefined && !readPublisher)
            throw new AppError(503, "明庭尚未配置唤醒宿主");
          const publisher =
            raw === undefined ? undefined : readPublisher?.(req, raw);
          if (
            input.action === "append" &&
            input.taskId &&
            publisher &&
            service.isOriginalPublisher(input.taskId, publisher)
          )
            failedAppend = store.taskMessageScope(input.taskId);
          const result = withTaskUrl(
            req,
            service.publishCommand(input, publisher),
          );
          const scope =
            result.taskTurn === undefined
              ? undefined
              : { taskId: result.taskId, taskTurn: result.taskTurn };
          taskMessage(
            store,
            scope,
            "publisher",
            "send",
            input.action === "append" ? "append.response" : "new.response",
            result,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (e) {
          if (failedAppend && e instanceof AppError) {
            taskMessage(
              store,
              failedAppend,
              "publisher",
              "receive",
              "append",
              input,
            );
            taskMessage(
              store,
              failedAppend,
              "publisher",
              "send",
              "append.response",
              { error: e.message },
            );
          }
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: e instanceof AppError ? e.message : "任务发布失败",
              },
            ],
          };
        }
      },
    );
    mcp.registerTool(
      "list_harnesses",
      {
        title: "在线 Harness",
        description: "查询通过常驻 SSE 订阅登记的在线 harness 身份。",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        // 返回通过常驻订阅登记的在线执行器和能力。
        const result = { harnesses: service.harnesses() };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      },
    );
    /** 将审批相关错误转换成 MCP 工具结果，隐藏内部错误细节。 */
    const toolError = (error: unknown) => ({
      isError: true,
      content: [
        {
          type: "text" as const,
          text: error instanceof AppError ? error.message : "审批请求失败",
        },
      ],
    });
    mcp.registerTool(
      "wait_for_approval",
      {
        title: "订阅任务审批",
        description: `使用 ${publishTaskToolName} 返回的 approvalSubscription 等待审批（每次最多25秒）。检查完整工具上下文并调用 submit_approval_decision；任务仍活动时持续等待。已提交意见的审批会保留在快照中。`,
        inputSchema: approvalWaitSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input, extra) => {
        // 鉴权后限时等待可处理的审批或任务结束，并记录请求和响应。
        let scope: TaskMessageScope | undefined;
        try {
          service.requireSubscriber(input);
          scope = store.taskMessageScope(input.taskId);
          taskMessage(store, scope, "publisher", "receive", "approval.wait", {
            waitMs: input.waitMs,
          });
          const result = await service.waitForApproval(
            input,
            input.waitMs,
            extra.signal,
          );
          taskMessage(
            store,
            scope,
            "publisher",
            "send",
            "approval.wait.response",
            result,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          taskMessage(
            store,
            scope,
            "publisher",
            "send",
            "approval.wait.response",
            {
              error: error instanceof AppError ? error.message : "审批请求失败",
            },
          );
          return toolError(error);
        }
      },
    );
    mcp.registerTool(
      "submit_approval_decision",
      {
        title: "提交订阅者审批意见",
        description:
          "发起方使用任务专属订阅凭据和原始 ACP optionId 提交同意或拒绝。平台保留10秒用户决定窗口；用户决定优先。相同意见重试保持原截止时间。",
        inputSchema: subscriberDecisionSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (input) => {
        // 通过 MCP 提交发起方的审批意见。
        try {
          const result = subscriberDecision(service, input);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
    mcp.registerTool(
      "get_wakeup_status",
      {
        description:
          "检查当前平台的聊天事件唤醒宿主是否已接通。通过后可在发布时绑定当前threadId和originTurnId，发布后结束回合。",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        // 返回聊天唤醒宿主的可用状态。
        const result = service.wakeupStatus();
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      },
    );
    mcp.registerTool(
      "get_task_wakeups",
      {
        description:
          "使用发起方审批订阅凭据读取此任务的聊天目标、持久事件、投递及恢复确认记录。",
        inputSchema: approvalSubscriptionSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => {
        // 鉴权后列出订阅任务的 Codex 唤醒目标与事件。
        try {
          const result = service.taskWakeups(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
    mcp.registerTool(
      "acknowledge_task_wakeup",
      {
        description:
          "收到平台事件并恢复新回合后，记录当前threadId、turnId与事件ID；两类事件各自确认独立回合。真实验收还需宿主聊天记录。",
        inputSchema: approvalSubscriptionSchema
          .extend(wakeupAcknowledgementSchema.shape)
          .strict(),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => {
        // 通过 MCP 确认原会话新回合已接收唤醒，并记录通信。
        try {
          const { taskId, subscriptionToken, ...ack } = input;
          const subscription = { taskId, subscriptionToken };
          const event = service
            .taskWakeups(subscription)
            .events.find(
              /* 按回执的事件 ID 定位所属运行。 */ (event) =>
                event.id === ack.eventId,
            );
          const result = taskExchange(
            store,
            event && store.runMessageScope(event.runId),
            "publisher",
            "wakeup.ack",
            ack,
            /* 校验并保存唤醒回执，关联该运行的通信轮次。 */ () =>
              service.acknowledgeWakeup(subscription, ack),
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.once("close", () => {
      // 响应关闭时释放本次请求的 MCP 传输和服务。
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  router.all(
    "/mcp",
    /* 拒绝 MCP 路径上的非 POST 请求。 */ (_req, res) =>
      res.status(405).json({ error: "仅支持 MCP Streamable HTTP POST" }),
  );
  return router;
}
