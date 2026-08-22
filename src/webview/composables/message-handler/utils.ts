import { FEEDBACK_MARKER, POLICY_BLOCK_MARKER } from "@shared/types/constants";
import type { ToolCall } from "@shared/types/session";
import type { ContentBlock, HistoryToolCall, UserContentBlock } from "@shared/types/content";

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

export function convertHistoryTools(tools: HistoryToolCall[] | undefined): ToolCall[] | undefined {
  return tools?.map((t): ToolCall => ({
    id: t.id,
    name: t.name,
    input: t.input,
    status: t.isError ? "denied" : "completed",
    ...(t.result !== undefined && { result: t.result }),
    ...(t.isError !== undefined && { isError: t.isError }),
    ...(t.metadata !== undefined && { metadata: t.metadata }),
    ...(t.feedback !== undefined && { feedback: t.feedback }),
  }));
}
