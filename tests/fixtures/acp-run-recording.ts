import { readFileSync } from "node:fs";
import type {
  RequestPermissionRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { z } from "zod";
import { validateAcp } from "../../src/server/acp-validation.js";
import {
  auditedHarnessSchema,
  capabilitySnapshotSchema,
  contextObservationSchema,
  requestedSettingsSchema,
  runUsageSchema,
} from "../../src/shared/protocol.js";

const notification = z.custom<Omit<SessionNotification, "sessionId">>((frame) =>
  validateAcp("SessionNotification", {
    ...Object(frame),
    sessionId: "fixture",
  }),
);
const permission = z.custom<Omit<RequestPermissionRequest, "sessionId">>(
  (request) =>
    validateAcp("RequestPermissionRequest", {
      ...Object(request),
      sessionId: "fixture",
    }),
);
const approval = z.object({
  permission,
  expectedOption: z.string(),
});
const recording = z.object({
  id: z.string(),
  harness: auditedHarnessSchema,
  source: z.string(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  adapterVersion: z.string(),
  settings: requestedSettingsSchema.required(),
  model: capabilitySnapshotSchema.shape.models.element,
  catalogWindow: z.number().int().positive().nullable(),
  frames: z.array(z.union([approval, notification])),
  result: z.looseObject({ stopReason: z.literal("end_turn") }),
  deepseekEvents: z.array(z.unknown()).optional(),
  expected: z.object({
    output: z.string(),
    reasoning: z.string(),
    context: contextObservationSchema,
    usageMethod: z.string(),
    usage: runUsageSchema.omit({
      scope: true,
      basis: true,
      modelId: true,
      missingReason: true,
      source: true,
    }),
  }),
});
export const acpRunRecordings = z
  .array(recording)
  .parse(
    JSON.parse(
      readFileSync(new URL("acp-run-recordings.json", import.meta.url), "utf8"),
    ),
  );
