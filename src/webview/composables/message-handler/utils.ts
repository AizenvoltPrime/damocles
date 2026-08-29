import { FEEDBACK_MARKER, POLICY_BLOCK_MARKER } from "@shared/types/constants";
import type { ToolCall } from "@shared/types/session";
import type { ContentBlock, HistoryToolCall, UserContentBlock } from "@shared/types/content";
import { resolveCancelledStatus } from "@/stores/tool-cancelled-status";

/**
 * A replayed user turn can only ever hold text and images, but `userReplay.contentBlocks` is declared
 * with the wide assistant-side `ContentBlock` union. Narrowing here keeps the store's user-message
 * entry point honest instead of widening it to accept blocks a user message cannot contain.
 */
export function toUserContentBlocks(blocks: ContentBlock[] | undefined): UserContentBlock[] | undefined {
  const narrowed = blocks?.filter(
    (b): b is UserContentBlock => b.type === "text" || b.type === "image",
  );
  return narrowed?.length ? narrowed : undefined;
}

/**
 * The reason text behind a denied tool call, or undefined when the error is an ordinary failure.
 * Either marker means "denied": the human rejected it at a prompt (FEEDBACK_MARKER) or the runtime
 * blocked it on its own (POLICY_BLOCK_MARKER). Sessions recorded before the policy marker existed
 * carry only FEEDBACK_MARKER, so it stays first and keeps rendering exactly as before.
 */
export function extractDenialFeedback(errorMessage: string): string | undefined {
  for (const marker of [FEEDBACK_MARKER, POLICY_BLOCK_MARKER]) {
    const markerIndex = errorMessage.indexOf(marker);
    if (markerIndex !== -1) return errorMessage.slice(markerIndex + marker.length).trim();
  }
  return undefined;
}

/**
 * The status a replayed call carries, from the only two facts the transcript keeps: whether a result
 * was recorded at all, and whether it was an error. An error is a denial only when it carries a denial
 * marker, the same signal the live path reads off the error text; anything else errored on its own.
 */
function historyToolStatus(tool: HistoryToolCall, denialFeedback: string | undefined): ToolCall["status"] {
  if (tool.isError === true) return denialFeedback !== undefined ? "denied" : "failed";
  if (tool.result === undefined) return "unrecorded";
  return "completed";
}

export function convertHistoryTools(tools: HistoryToolCall[] | undefined): ToolCall[] | undefined {
  return tools?.map((t): ToolCall => {
    const denialFeedback = t.feedback ?? (t.isError === true && t.result !== undefined ? extractDenialFeedback(t.result) : undefined);
    return {
      id: t.id,
      name: t.name,
      input: t.input,
      status: resolveCancelledStatus(historyToolStatus(t, denialFeedback), t.metadata),
      ...(t.result !== undefined && { result: t.result }),
      ...(t.isError !== undefined && { isError: t.isError }),
      ...(t.metadata !== undefined && { metadata: t.metadata }),
      ...(denialFeedback !== undefined && { feedback: denialFeedback }),
    };
  });
}
