import express from "express";
import { LIMITS } from "../../shared/protocol.js";
import { loadConfig } from "../config.js";
import { Store } from "../storage/store.js";
import { TaskService } from "../tasks/service.js";
import type { WakeupDelivery } from "../wakeup/task-wakeup.js";
import { browserApiRouter } from "./browser-api/router.js";
import { connectorRouter } from "./connector.js";
import { hostWakeupRouter, type HostWakeupHost } from "./host-wakeup.js";
import { httpErrorHandler, localHttpGuard } from "./http-middleware.js";
import { mcpRouter } from "./mcp.js";
import { subscriberRouter } from "./subscriber/router.js";
import { webAssetsRouter } from "./web-assets.js";
import type { ProjectDirectoryDialog } from "../records/directory-picker.js";
import { ProjectRecords } from "../records/service.js";

type Config = {
  dbPath: string;
  workspace: string;

  mode?: "fake" | "codex";
  wakeupDelivery?: WakeupDelivery;
  wakeupHosts?: HostWakeupHost[];
  configPath?: string;
  chooseProjectDirectory?: ProjectDirectoryDialog;
};

/** 组装任务服务、数据库、中间件与 HTTP 路由。 */
export function createPlatform(config: Config) {
  const { workspace, mode = "codex" } = config;
  const { tasks, web } = loadConfig(config.configPath);
  const store = new Store(config.dbPath);
  const records = new ProjectRecords(store);
  const service = new TaskService(
    store,
    workspace,
    mode,
    config.wakeupDelivery,
  );

  const app = express();
  service.events.once("close", () => records.close());
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(localHttpGuard(web?.frameAncestor));
  app.use(connectorRouter(service, tasks.runReportBodyBytes));
  app.use(express.json({ limit: LIMITS.httpBytes }));
  const wakeupHost = config.wakeupHosts?.length
    ? hostWakeupRouter(service, config.wakeupHosts, tasks.wakeupResultTextLimit)
    : undefined;
  if (wakeupHost) app.use("/wakeup-host", wakeupHost.router);
  app.use(
    browserApiRouter(
      service,
      workspace,
      mode,
      records,
      config.chooseProjectDirectory,
    ),
  );
  app.use(subscriberRouter(service));
  app.use(
    mcpRouter(service, tasks.approvalWaitMs, wakeupHost?.publisher, records),
  );
  app.use(webAssetsRouter());
  app.use(httpErrorHandler);
  return { app, service, store, records };
}
