import { runtime } from "../server/runtime.js";
import { TaskConnector } from "./connector.js";
const config = runtime();
const connector = new TaskConnector(
  process.env.TASK_PLATFORM_URL ?? "http://127.0.0.1:60390",
  config.adapter,
  (event) => console.log(`收到任务订阅事件 #${event.id} task=${event.taskId}`),
);
connector.start();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await connector.close();
  process.exit(0);
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
