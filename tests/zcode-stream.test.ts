import { test } from "node:test";
import assert from "node:assert/strict";
import { translateZcodeLine } from "../src/server/zcode-stream.js";
import { applyProgress } from "../src/server/progress.js";
import { LIMITS, runSchema } from "../src/shared/protocol.js";

test("A7 native ZCode batch events stay separate from per-tool updates; malformed known events fail", () => {
  assert.deepEqual(
    translateZcodeLine(
      {
        type: "tool.updated",
        payload: { kind: "batch", toolCallIds: ["t"], successCount: 1 },
      },
      "s",
    ),
    {},
  );
  assert.deepEqual(
    translateZcodeLine({ type: "session.updated", payload: {} }, "s"),
    {},
  );
  assert.throws(() =>
    translateZcodeLine(
      { type: "tool.updated", payload: { kind: "result", toolCallId: "t" } },
      "s",
    ),
  );
  assert.throws(() =>
    translateZcodeLine(
      { type: "model.streaming", payload: { kind: "text_delta" } },
      "s",
    ),
  );
  assert.throws(() =>
    translateZcodeLine(
      {
        type: "result",
        sessionId: "s",
        response: "hi",
        projection: { status: "error" },
      },
      "s",
    ),
  );
  assert.equal(
    translateZcodeLine(
      {
        type: "model.streaming",
        payload: { kind: "reasoning_delta", delta: "想一想" },
      },
      "s",
    ).update?.update.sessionUpdate,
    "agent_thought_chunk",
  );
});

test("A8 bounded persistent projections retain legacy defaults, partial tools, and long-output limits", () => {
  const run = runSchema.parse({
    id: "r",
    taskId: "t",
    status: "running",
    sessionId: "s",
    createdAt: "now",
    endedAt: null,
    output: "",
    error: null,
    stopReason: null,
    discovery: null,
  });
  assert.equal(run.reasoning, "");
  assert.equal(run.tools.length, 0);
  applyProgress(run, {
    sessionId: "s",
    update: {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "想".repeat(LIMITS.outputChars + 1) },
    },
  });
  assert.equal(run.reasoning.length, LIMITS.outputChars);
  for (let i = 0; i <= LIMITS.tools; i++)
    applyProgress(run, {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: String(i),
        status: "failed",
        title: "读取",
        content: [
          {
            type: "content",
            content: { type: "text", text: "x".repeat(LIMITS.toolChars + 1) },
          },
        ],
      },
    });
  assert.equal(run.tools.length, LIMITS.tools);
  assert.equal(run.tools[0]?.id, "1");
  assert.equal(run.tools[0]?.output.length, LIMITS.toolChars);
  applyProgress(run, {
    sessionId: "s",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "1",
      status: null,
    },
  });
  assert.equal(run.tools[0]?.status, "failed");
});
