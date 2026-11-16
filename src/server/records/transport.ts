import { Router } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  projectDirectoryChoiceSchema,
  syncProjectRecordsSchema,
  syncProjectRecordsReceiptSchema,
} from "../../shared/project-records.js";
import { AppError } from "../tasks/service.js";
import {
  chooseMacProjectDirectory,
  projectDirectoryFromGit,
  projectDirectoryRequestTimeoutMs,
  type ProjectDirectoryDialog,
} from "./directory-picker.js";
import type { ProjectRecords } from "./service.js";

/** 普通 MCP 入口登记项目与显式刷新，源文档内容由导入器核对。 */
export function registerRecordTools(mcp: McpServer, records: ProjectRecords) {
  mcp.registerTool(
    "sync_project_records",
    {
      title: "同步项目开发记录",
      description:
        "登记或刷新本机项目 docs/spec 内的 Spec 和 Task 记录。保留来源并持续核对文档状态，执行任务保持原样。",
      inputSchema: syncProjectRecordsSchema,
      outputSchema: syncProjectRecordsReceiptSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const project = records.sync(input);
        const result = {
          projectId: project.id,
          specCount: project.specs.length,
          taskCount: project.specs.reduce((n, s) => n + s.tasks.length, 0),
          observedAt: project.observedAt,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "同步失败",
            },
          ],
        };
      }
    },
  );
}

/** 查询入口位于已有网页会话校验之后。 */
export function projectRecordsRouter(
  records: ProjectRecords,
  chooseDirectory: ProjectDirectoryDialog = chooseMacProjectDirectory,
) {
  const router = Router();
  let choosingDirectory = false;
  router.post("/api/project-records/choose-directory", async (req, res) => {
    if (choosingDirectory) throw new AppError(409, "文件夹选择窗口已打开。");
    choosingDirectory = true;
    req.setTimeout(projectDirectoryRequestTimeoutMs);
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    try {
      const directory = await chooseDirectory(controller.signal);
      const choice = directory
        ? {
            status: "selected",
            ...(await projectDirectoryFromGit(directory, controller.signal)),
          }
        : { status: "cancelled" };
      if (!controller.signal.aborted)
        res.json(projectDirectoryChoiceSchema.parse(choice));
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      choosingDirectory = false;
    }
  });
  router.get("/api/project-records", (_req, res) => res.json(records.list()));
  router.get("/api/project-records/:id/document", (req, res) => {
    const path = z.string().min(1).max(4096).parse(req.query.path);
    try {
      res.json(records.document(req.params.id, path));
    } catch (error) {
      res.status(404).json({
        error: error instanceof Error ? error.message : "文档读取失败",
      });
    }
  });
  return router;
}
