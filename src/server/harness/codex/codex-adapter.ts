import { AcpAdapter, type AdapterConfig } from "../acp/acp-adapter.js";
import { codexModelWindow, codexUsage } from "./codex-task-mapping.js";

export type {
  AdapterConfig,
  RunHooks,
  TaskExecutor,
} from "../acp/acp-adapter.js";

export class CodexAdapter extends AcpAdapter {
  /** 在通用 ACP 适配器上注册 Codex 用量和模型窗口的读取逻辑。 */
  constructor(config: AdapterConfig) {
    super({
      ...config,
      telemetry: { usage: codexUsage, modelWindow: codexModelWindow },
    });
  }
}
