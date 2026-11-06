import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { acpRunRecordings } from "./acp-run-recording.js";

const data = acpRunRecordings.find(
  (recording) => recording.id === process.argv[2],
);
if (!data) throw new Error("Unknown ACP recording");
const sessionId = randomUUID();
const { model, settings } = data;
const mode = data.harness === "ZCode" ? "plan" : "workspace-write";
const configured = new Set<string>();
let effort =
  model.efforts.find(({ id }) => id !== settings.reasoningEffort)?.id ??
  settings.reasoningEffort;
let prompted = false;

function options(): SessionConfigOption[] {
  return [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: model.id,
      options: [{ value: model.id, name: model.name }],
    },
    {
      id: "reasoning_effort",
      name: "Thought level",
      type: "select",
      currentValue: effort,
      options: model.efforts.map(({ id, name }) => ({ value: id, name })),
    },
  ];
}

const connection = agent({ name: "mingting-recorded-acp-run" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    ...(data.adapterVersion === "unknown"
      ? {}
      : {
          agentInfo: { name: data.harness, version: data.adapterVersion },
        }),
  }))
  .onRequest(methods.agent.session.new, () => ({
    sessionId,
    configOptions: options(),
    modes: { currentModeId: mode, availableModes: [{ id: mode, name: mode }] },
    ...(data.catalogWindow === null
      ? {}
      : {
          models: {
            currentModelId: model.id,
            availableModels: [
              {
                modelId: model.id,
                name: model.name,
                _meta:
                  data.harness === "Grok"
                    ? { totalContextTokens: data.catalogWindow }
                    : { contextWindow: data.catalogWindow },
              },
            ],
          },
        }),
  }))
  .onRequest(methods.agent.session.setMode, ({ params }) => {
    if (params.sessionId !== sessionId || params.modeId !== mode)
      throw new Error("Unexpected replay mode");
    return {};
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    const { configId, value } = params;
    if (
      params.sessionId !== sessionId ||
      (configId === "model"
        ? value !== settings.modelId
        : configId !== "reasoning_effort" || value !== settings.reasoningEffort)
    )
      throw new Error("Unexpected replay configuration");
    if (configId === "reasoning_effort") effort = settings.reasoningEffort;
    configured.add(configId);
    return { configOptions: options() };
  })
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    if (prompted || ctx.params.sessionId !== sessionId || configured.size !== 2)
      throw new Error("Replay requires both settings before the prompt");
    prompted = true;
    for (const frame of data.frames) {
      ctx.signal.throwIfAborted();
      if ("permission" in frame) {
        const { outcome } = await ctx.client.request(
          methods.client.session.requestPermission,
          { ...frame.permission, sessionId },
          { cancellationSignal: ctx.signal },
        );
        if (
          outcome.outcome !== "selected" ||
          outcome.optionId !== frame.expectedOption
        )
          throw new Error("Unexpected decision from the platform");
      } else {
        await ctx.client.notify(methods.client.session.update, {
          ...frame,
          sessionId,
        });
      }
    }
    if (data.deepseekEvents) {
      const cwd = process.cwd();
      // Test workspaces use plain ASCII names and canonical absolute paths.
      const projectKey = "--" + cwd.split("/").filter(Boolean).join("-") + "--";
      const folder = join(cwd, "sessions", projectKey, sessionId);
      await mkdir(folder, { recursive: true });
      const header = {
        type: "session",
        version: 4,
        id: sessionId,
        cwd,
        isSeeded: false,
        delegationDepth: 0,
      };
      await writeFile(
        join(folder, "session.v4.jsonl"),
        [header, ...data.deepseekEvents]
          .map((event) => JSON.stringify(event))
          .join("\n"),
      );
    }
    return data.result;
  })
  .connect(
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  );
process.stdin.once("end", () => connection.close());
