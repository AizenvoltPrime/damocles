import { z } from 'zod';

/**
 * One configured hook: a command to run plus optional filtering/timeout metadata. `command` is either a
 * shell string (run via the platform shell — pipes, &&, any binary) or an argv array (no shell). `match`
 * is an optional regex tested against the (uniform) Damocles tool name (tool_call/tool_result only).
 */
export interface HookEntry {
  command: string | string[];
  match?: string | undefined;
  timeoutMs?: number | undefined;
  description?: string | undefined;
}

export const hookEntrySchema: z.ZodType<HookEntry> = z.object({
  command: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  match: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  description: z.string().optional(),
});

/** Top-level `hooks.json` shape: a map of pi event key → ordered hook entries. Extra keys are ignored. */
export interface HookConfig {
  hooks?: Record<string, HookEntry[]> | undefined;
}

export const hookConfigSchema: z.ZodType<HookConfig> = z.object({
  hooks: z.record(z.string(), z.array(hookEntrySchema)).optional(),
});

/**
 * The native output contract normalized into one per-hook decision. Produced by the runner from the
 * child's exit code + stdout (the flat snake_case JSON response); reconciled across multiple hooks in
 * `dispatch.ts` and mapped onto the relevant pi result type.
 */
export interface HookDecision {
  /** tool_call permission decision (response `decision` ∈ allow|deny|ask), when the child set one. */
  permissionDecision?: 'allow' | 'deny' | 'ask';
  /** Generic block — `decision:"deny"` or `decision:"block"`. Honored by blocking-capable events. */
  block: boolean;
  /** The hook asked to end the turn (response `terminate`). Meaningful only with a deny. */
  terminate?: boolean;
  /** Reason text (response `reason`). */
  reason?: string;
  /** tool_call arg rewrite (response `updated_input`; denormalized before mutating `event.input`). */
  updatedInput?: Record<string, unknown>;
  /** Context to add (response `context`, or plain non-JSON stdout). */
  additionalContext?: string;
  /** tool_result replacement tool output (response `updated_output`). */
  updatedToolOutput?: string;
  /** input session rename (response `session_title`). */
  sessionTitle?: string;
  /** A human-facing system message (response `system_message`), surfaced as a notification. */
  systemMessage?: string;
  /** Infra failure (spawn error / timeout): fail-soft everywhere except tool_call write/shell. */
  failed: boolean;
}

/** A no-op decision (exit 0, empty stdout): neither blocks nor adds anything. */
export function emptyDecision(): HookDecision {
  return { block: false, failed: false };
}
