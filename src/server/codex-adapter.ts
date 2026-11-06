import { AcpAdapter, type AdapterConfig } from "./acp-adapter.js";
import { codexModelWindow, codexUsage } from "./codex-task-mapping.js";

export type { AdapterConfig, RunHooks, TaskExecutor } from "./acp-adapter.js";

export class CodexAdapter extends AcpAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      telemetry: { usage: codexUsage, modelWindow: codexModelWindow },
    });
  }
}
