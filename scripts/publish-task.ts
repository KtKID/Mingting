import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { publishTaskSchema } from "../src/shared/protocol.js";
const input = publishTaskSchema.parse({
  title: process.argv[2] ?? "补充项目安装说明",
  description: process.argv[3] ?? "检查 README，补充安装和启动步骤。",
  publisherName: process.argv[4] ?? "MCP 示例客户端",
  ...(process.argv[5] ? { targetHarness: process.argv[5] } : {}),
});
const client = new Client({ name: "publish-task-example", version: "0.1.0" });
try {
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(process.env.TASK_MCP_URL ?? "http://127.0.0.1:60390/mcp"),
    ),
  );
  console.log(
    JSON.stringify(
      await client.callTool({ name: "mcp-mingting-tool", arguments: input }),
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
