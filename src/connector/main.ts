import { runtime } from "../server/harness/runtime.js";
import { TaskConnector } from "./connector.js";
// 自动拉起和手动运行共用此入口，执行器身份、工作区和模式由运行配置决定。
const config = runtime();
const connector = new TaskConnector(
  process.env.TASK_PLATFORM_URL ?? "http://127.0.0.1:60390",
  config.adapter,
  (event) =>
    console.log(
      `${config.harnessName} 收到任务订阅事件 #${event.id} task=${event.taskId}`,
    ),
  config.harnessName,
);
connector.start();
console.log(`${config.harnessName} 订阅连接器 owner=${connector.ownerId}`);
let stopping = false;
/** 合并退出信号，等订阅、执行和探测收尾后再退出进程。 */
async function stop() {
  if (stopping) return;
  stopping = true;
  await connector.close();
  process.exit(0);
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
