import { z } from "zod";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { Run } from "./protocol";

// Optional application metadata carried intact by ACP v1.
const promptSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().min(1).max(16000).optional(),
});

export function approvalPrompt(
  request: RequestPermissionRequest,
  previous?: Run["tools"][number],
) {
  const parsed = promptSchema.safeParse(
    request._meta?.["mingting.dev/approval"],
  );
  const prompt = parsed.success ? parsed.data : undefined;
  const tool = request.toolCall;
  const content = tool.content
    ?.map((item) =>
      item.type === "content" && item.content.type === "text"
        ? item.content.text
        : item.type === "diff"
          ? `${item.path}\n${item.newText}`
          : "",
    )
    .filter(Boolean)
    .join("\n");
  const input =
    tool.rawInput == null
      ? ""
      : typeof tool.rawInput === "string"
        ? tool.rawInput
        : JSON.stringify(tool.rawInput, null, 2);
  return {
    title: prompt?.title ?? tool.title ?? previous?.title ?? "操作审批",
    description:
      prompt?.description ??
      (content ||
        input ||
        previous?.input ||
        tool.locations?.map((location) => location.path).join("\n") ||
        "执行者请求执行此操作。"),
  };
}

export function approvalOption(
  request: RequestPermissionRequest,
  kind: "allow" | "reject",
) {
  return (
    request.options.find((option) => option.kind === `${kind}_once`) ??
    request.options.find((option) => option.kind === `${kind}_always`)
  );
}
