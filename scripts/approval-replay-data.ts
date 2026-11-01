import { readFile } from "node:fs/promises";
import { z } from "zod";
import type {
  RequestPermissionRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { recordingSourceSchema } from "../src/shared/approval-replay.js";
export {
  scenarios,
  commandSchema,
  optionFor,
} from "../src/shared/approval-replay.js";

// ACP payloads use the same SDK validation boundary as shared/protocol.ts.
export const recordingSchema = z.object({
  version: z.literal(1),
  sources: z.array(recordingSourceSchema),
  request: z.custom<RequestPermissionRequest>(),
  before: z.array(z.custom<SessionNotification["update"]>()),
  allowed: z.array(z.custom<SessionNotification["update"]>()),
  denied: z.array(z.custom<SessionNotification["update"]>()),
  allowedOutput: z.string(),
  deniedOutput: z.string(),
});
export const recordingPath = new URL(
  "../tests/fixtures/zcode-approval-recording.json",
  import.meta.url,
);
export async function loadRecording() {
  return recordingSchema.parse(
    JSON.parse(
      await readFile(
        process.env.APPROVAL_RECORDING_PATH ?? recordingPath,
        "utf8",
      ),
    ),
  );
}
