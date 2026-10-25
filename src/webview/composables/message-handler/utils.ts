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

/** Who refused a tool call: the human at a prompt, or the runtime's own policy. */
export interface DenialFeedback {
  readonly kind: "feedback" | "policy";
  readonly text: string;
}

/**
 * The reason behind a refused tool call, or undefined when the error is an ordinary failure. The human
 * rejected it at a prompt (FEEDBACK_MARKER) or the runtime blocked it on its own (POLICY_BLOCK_MARKER).
 * Sessions recorded before the policy marker existed carry only FEEDBACK_MARKER, so it stays first.
 */
export function extractDenialFeedback(errorMessage: string): DenialFeedback | undefined {
  const markers = [["feedback", FEEDBACK_MARKER], ["policy", POLICY_BLOCK_MARKER]] as const;
  for (const [kind, marker] of markers) {
    const markerIndex = errorMessage.indexOf(marker);
    if (markerIndex !== -1) return { kind, text: errorMessage.slice(markerIndex + marker.length).trim() };
  }
  return undefined;
}

/** A refusal's card status: a policy block shows "Blocked", a human rejection "denied". */
export function refusedStatus(denial: DenialFeedback): "blocked" | "denied" {
  return denial.kind === "policy" ? "blocked" : "denied";
}

/**
 * The status a replayed call carries, from the only two facts the transcript keeps: whether a result
 * was recorded at all, and whether it was an error. An error is a refusal only when it carries a denial
 * marker, the same signal the live path reads off the error text; anything else errored on its own. A
 * stored feedback with no marker in the result is the human's. A call a joining view's replay marks `live` has no outcome
 * yet, and the live messages after the replay set it.
 */
function historyToolStatus(tool: HistoryToolCall, denial: DenialFeedback | undefined): ToolCall["status"] {
  if (tool.live === true) return "pending";
  if (tool.abandoned !== undefined) return "abandoned";
  if (tool.isError === true) return denial !== undefined ? refusedStatus(denial) : "failed";
  if (tool.result === undefined) return "unrecorded";
  return "completed";
}

export function convertHistoryTools(tools: HistoryToolCall[] | undefined): ToolCall[] | undefined {
  return tools?.map((t): ToolCall => {
    const marked = t.isError === true && t.result !== undefined ? extractDenialFeedback(t.result) : undefined;
    const denial = marked ?? (t.feedback !== undefined ? { kind: "feedback" as const, text: t.feedback } : undefined);
    const denialFeedback = t.feedback ?? denial?.text;
    return {
      id: t.id,
      name: t.name,
      input: t.input,
      status: resolveCancelledStatus(historyToolStatus(t, denial), t.metadata),
      ...(t.result !== undefined && { result: t.result }),
      ...(t.isError !== undefined && { isError: t.isError }),
      ...(t.imageCount !== undefined && { imageCount: t.imageCount }),
      ...(t.metadata !== undefined && { metadata: t.metadata }),
      ...(t.durationMs !== undefined && { durationMs: t.durationMs }),
      ...(t.abandoned !== undefined && { abandonReason: t.abandoned }),
      ...(denialFeedback !== undefined && { feedback: denialFeedback }),
    };
  });
}
