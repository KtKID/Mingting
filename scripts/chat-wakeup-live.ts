import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  CodexWakeupDelivery,
  codexWakeupConfig,
} from "../src/server/codex-wakeup.js";
import {
  publishTaskSchema,
  publishResultSchema,
} from "../src/shared/protocol.js";
import {
  validateWakeupReplay,
  renderWakeupReplay,
} from "../src/shared/wakeup-replay.js";
import { wakeupHostStatusSchema } from "../src/shared/task-wakeup.js";

const command = z
  .enum(["probe", "publish", "replay", "events", "ack"])
  .parse(process.argv[2]);
if (command === "probe") {
  const host = new CodexWakeupDelivery(codexWakeupConfig());
  const threadId = z.string().uuid().parse(process.env.CODEX_THREAD_ID);
  const result = await host.probe(threadId);
  const dir = resolve("reports/chat-wakeups", randomUUID());
  await mkdir(dir, { recursive: true });
  const record = {
    kind: "real-host-readiness",
    capturedAt: new Date().toISOString(),
    threadId,
    status: result.available ? "ready" : "blocked",
    host: result,
    publication: "not-started",
    approvalWakeup: "not-started",
    completionWakeup: "not-started",
  };
  await writeFile(
    join(dir, "readiness.json"),
    JSON.stringify(record, null, 2) + "\n",
  );
  await writeFile(
    join(dir, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>聊天唤醒真实验收</title><h1>聊天唤醒真实验收：${record.status}</h1><pre>${JSON.stringify(record, null, 2).replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</pre>`,
  );
  console.log(JSON.stringify({ ...record, report: dir }, null, 2));
  if (!result.available) process.exitCode = 2;
} else if (command === "publish") {
  const threadId = z.string().uuid().parse(process.env.CODEX_THREAD_ID);
  const originTurnId = z.string().uuid().parse(process.argv[3]);
  const inputPath = z.string().min(1).parse(process.argv[4]);
  const receiptPath = z.string().min(1).parse(process.argv[5]);
  const input = publishTaskSchema.parse({
    ...z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(await readFile(inputPath, "utf8"))),
    wakeup: { threadId, originTurnId },
  });
  const { open, unlink } = await import("node:fs/promises");
  const file = await open(receiptPath, "wx", 0o600);
  const client = new Client({
    name: "mingting-wakeup-publisher",
    version: "1",
  });
  let received = false;
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(process.env.TASK_MCP_URL ?? "http://127.0.0.1:60390/mcp"),
      ),
    );
    const status = await client.callTool({
      name: "get_wakeup_status",
      arguments: {},
    });
    if (
      status.isError ||
      !wakeupHostStatusSchema.parse(status.structuredContent).available
    )
      throw new Error("聊天唤醒宿主尚未接通；实际任务保持未发布");
    const response = await client.callTool({
      name: "publish_task",
      arguments: input,
    });
    if (response.isError)
      throw new Error("发布失败；请核对任务台后决定后续操作");
    const receipt = publishResultSchema.parse(response.structuredContent);
    received = true;
    await file.writeFile(JSON.stringify(receipt, null, 2) + "\n");
    await file.sync();
    console.log(
      JSON.stringify({
        taskId: receipt.taskId,
        receiptPath,
        next: "结束当前回合，等待审批事件恢复执行",
      }),
    );
  } finally {
    await file.close();
    await client.close();
    if (!received) await unlink(receiptPath);
  }
} else if (command === "events" || command === "ack") {
  const receipt = publishResultSchema.parse(
    JSON.parse(
      await readFile(z.string().min(1).parse(process.argv[3]), "utf8"),
    ),
  );
  const subscription = receipt.approvalSubscription;
  if (!subscription) throw new Error("回执缺少任务审批订阅");
  const client = new Client({ name: "mingting-wakeup-receiver", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(process.env.TASK_MCP_URL ?? "http://127.0.0.1:60390/mcp"),
      ),
    );
    const result = CallToolResultSchema.parse(
      await client.callTool(
        command === "events"
          ? { name: "get_task_wakeups", arguments: subscription }
          : {
              name: "acknowledge_task_wakeup",
              arguments: {
                ...subscription,
                eventId: z.string().min(1).parse(process.argv[4]),
                threadId: z.string().uuid().parse(process.env.CODEX_THREAD_ID),
                turnId: z.string().uuid().parse(process.argv[5]),
              },
            },
      ),
    );
    if (result.isError)
      throw new Error(
        result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n"),
      );
    console.log(JSON.stringify(result.structuredContent, null, 2));
  } finally {
    await client.close();
  }
} else {
  const input = JSON.parse(
    await readFile(z.string().min(1).parse(process.argv[3]), "utf8"),
  );
  const result = validateWakeupReplay(input);
  const dir = resolve("reports/chat-wakeups", randomUUID());
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "replay.json"),
    JSON.stringify(input, null, 2) + "\n",
  );
  await writeFile(
    join(dir, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  await writeFile(join(dir, "index.html"), renderWakeupReplay(input));
  console.log(JSON.stringify({ ...result, report: dir }, null, 2));
  if (!result.passed) process.exitCode = 1;
}
