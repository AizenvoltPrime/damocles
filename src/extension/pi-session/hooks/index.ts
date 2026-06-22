import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { log } from '../../logger';
import { mapPiToolName, normalizeToolInput } from '../tool-normalization';
import {
  dispatchInput,
  dispatchToolResult,
  dispatchObserveOnly,
  dispatchContext,
  type DispatchDeps,
} from './dispatch';
import {
  buildAgentEndPayload,
  buildSessionStartPayload,
  buildSessionEndPayload,
  buildPreCompactPayload,
  buildSessionCompactPayload,
  buildGenericPayload,
  type HookCommon,
} from './payload';

import { takePreToolUseContext, clearSessionPreToolUseContext, type PreToolUseContextStash } from './context-stash';

export { HooksConfigService } from './config';
export type { DispatchDeps } from './dispatch';
export {
  createPreToolUseContextStash,
  stashPreToolUseContext,
  takePreToolUseContext,
  clearSessionPreToolUseContext,
  type PreToolUseContextStash,
} from './context-stash';

/** customType for the per-prompt UserPromptSubmit context the drain handler injects (hidden from chat). */
export const HOOK_CONTEXT_CUSTOM_TYPE = 'damocles-hook-context';

/** The subset of pi's `ToolResultEventResult` the PostToolUse path returns (the package omits the type). */
export interface ToolResultPatch {
  content?: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** A pi tool-result event, narrowed to the fields the PostToolUse hook reads (primary + subagent). */
export interface ToolResultLike {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: ReadonlyArray<{ type?: string; text?: string }>;
  isError: boolean;
  details: unknown;
}

/**
 * Tier-2 observe-only events (US-007): cheap notify/logging points whose return value is ignored. The
 * HIGH-FREQUENCY/mutation-heavy events (`message_update`, `tool_execution_*`, `context`,
 * `before_provider_request`, `after_provider_response`, `user_bash`, `project_trust`) are deliberately
 * NOT here — they are never spawned (US-007 exclusion list).
 */
const TIER2_EVENTS: readonly string[] = [
  'model_select',
  'thinking_level_select',
  'session_before_switch',
  'session_before_fork',
  'session_before_tree',
  'turn_start',
  'turn_end',
  'agent_start',
  'message_start',
  'message_end',
  'resources_discover',
];

/** The slice of the panel registry the configured hooks need: scope-guard + a webview emitter. */
export interface HookPanelReader {
  get(sessionId: string): { postMessage: (message: ExtensionToWebviewMessage) => void } | undefined;
}

/** Everything `registerConfiguredHooks` needs: dispatch deps, the panel registry, and a session rename. */
export interface ConfiguredHooksDeps {
  dispatch: DispatchDeps;
  registry: HookPanelReader;
  /** Rename the session — prefers the live mutator (anti-fork) over the file writer; routed by sessionId. */
  renameSession: (sessionId: string, cwd: string, newName: string) => Promise<void>;
  /** PreToolUse `additionalContext` stashed at the gate (keyed by toolCallId), drained onto the result. */
  preToolUseContextStash?: PreToolUseContextStash;
}

/** Surface hook `systemMessage`(s) to the user as warning notifications (the FR-16 transparency surface). */
export function postHookSystemMessages(
  post: (message: ExtensionToWebviewMessage) => void,
  messages: readonly string[],
): void {
  for (const message of messages) {
    post({ type: 'notification', notificationType: 'warning', message });
  }
}

/** Build the CC common-keys block (Appendix A) from a pi extension context. Shared by every event. */
export function buildHookCommon(ctx: ExtensionContext): HookCommon {
  return {
    session_id: ctx.sessionManager.getSessionId(),
    transcript_path: ctx.sessionManager.getSessionFile() ?? '',
    cwd: ctx.cwd,
  };
}

function textFromContent(content: ReadonlyArray<{ type?: string; text?: string }>): string {
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}

/** Build the `result` object from a pi tool result: joined text + error flag + details. */
function buildToolResponse(content: ReadonlyArray<{ type?: string; text?: string }>, isError: boolean, details: unknown): unknown {
  return { output: textFromContent(content), is_error: isError, ...(details !== undefined ? { details } : {}) };
}

/** Optional surfaces for `buildToolResultPatch`: PreToolUse context to append + a systemMessage sink. */
export interface ToolResultPatchOptions {
  /** PreToolUse `additionalContext` stashed at the gate for this tool call, appended to the output. */
  preToolUseContext?: readonly string[];
  /** Surface any PostToolUse `systemMessage`(s) (panel notification on the primary; log for subagents). */
  notify?: (messages: readonly string[]) => void;
}

/**
 * Run the PostToolUse hooks for one tool result and fold the reconciled decision into a pi result patch:
 * `updatedToolOutput`/`additionalContext` rewrite the content, `decision:"block"` sets `isError` + appends
 * the reason (pi can't re-run the tool). Any PreToolUse `additionalContext` stashed at the gate is appended
 * here too (pi's `tool_call` return can't inject context). Returns undefined when nothing changed. Shared
 * by the primary agent and subagents (US-008).
 */
export async function buildToolResultPatch(
  deps: DispatchDeps,
  common: HookCommon,
  event: ToolResultLike,
  opts: ToolResultPatchOptions = {},
): Promise<ToolResultPatch | undefined> {
  const result = await dispatchToolResult(deps, {
    common,
    toolName: mapPiToolName(event.toolName),
    toolInput: normalizeToolInput(event.toolName, event.input),
    toolResponse: buildToolResponse(event.content, event.isError, event.details),
  });

  if (result?.systemMessages.length && opts.notify) opts.notify(result.systemMessages);

  const patch: ToolResultPatch = {};
  let newText: string | undefined = result?.updatedToolOutput;
  if (result?.block) {
    patch.isError = true;
    const base = newText ?? textFromContent(event.content);
    newText = `${base}\n\n${result.reason ?? 'Blocked by a PostToolUse hook.'}`.trim();
  }
  if (result?.additionalContext) {
    const base = newText ?? textFromContent(event.content);
    newText = `${base}\n\n${result.additionalContext}`.trim();
  }
  if (opts.preToolUseContext?.length) {
    const base = newText ?? textFromContent(event.content);
    newText = `${base}\n\n${opts.preToolUseContext.join('\n\n')}`.trim();
  }
  if (newText !== undefined) patch.content = [{ type: 'text', text: newText }];
  return patch.content || patch.isError ? patch : undefined;
}

/**
 * Register the configured-hook handlers on a pi extension runtime (the shared Damocles extension). Each
 * handler is scope-guarded to a real panel session (internal sub-calls register no panel, so they never
 * fire), gated by `hasEntries` for zero cost when unconfigured (FR-14), and fail-soft (a hook error never
 * breaks the turn — FR-12). PreToolUse (`tool_call`) is NOT here: it runs inside the permission gate
 * (Section 3.3); this wires `tool_result`, `input`, `before_agent_start` (configured-hook context +
 * UserPromptSubmit drain), `agent_end` (Stop), and the session lifecycle events.
 */
export function registerConfiguredHooks(pi: ExtensionAPI, deps: ConfiguredHooksDeps): void {
  const config = deps.dispatch.config;
  /** Per-session UserPromptSubmit context stash, drained into a hidden message at before_agent_start. */
  const contextStash = new Map<string, string[]>();

  // --- UserPromptSubmit (input) ----------------------------------------------
  pi.on('input', async (event, ctx) => {
    if (event.source !== 'interactive') return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    const panel = deps.registry.get(sessionId);
    if (!panel || !config.hasEntries('input')) return undefined;
    try {
      const result = await dispatchInput(deps.dispatch, { common: buildHookCommon(ctx), prompt: event.text });
      if (!result) return undefined;
      if (result.systemMessages.length) postHookSystemMessages((m) => panel.postMessage(m), result.systemMessages);
      if (result.block) {
        const reason = result.reason ?? 'Your prompt was blocked by a hook.';
        panel.postMessage({ type: 'notification', notificationType: 'warning', message: reason });
        return { action: 'handled' };
      }
      if (result.additionalContext) {
        const existing = contextStash.get(sessionId) ?? [];
        existing.push(result.additionalContext);
        contextStash.set(sessionId, existing);
      }
      if (result.sessionTitle) {
        deps.renameSession(sessionId, ctx.cwd, result.sessionTitle).catch((err) =>
          log('[Hooks] sessionTitle rename failed: %O', err),
        );
      }
      return undefined;
    } catch (err) {
      log('[Hooks] input handler failed: %O', err);
      return undefined;
    }
  });

  // --- before_agent_start: configured-hook context + UserPromptSubmit drain --
  // Runs hooks under the `before_agent_start` key (their stdout is injected as run context — US-004) and
  // drains the UserPromptSubmit context stash. Both are merged into one hidden message that coexists with
  // the Damocles memory-catalog message (pi collects every handler's message).
  pi.on('before_agent_start', async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!deps.registry.get(sessionId)) return undefined;

    const parts: string[] = [];
    try {
      if (config.hasEntries('before_agent_start')) {
        const payload = { ...buildGenericPayload(buildHookCommon(ctx), 'before_agent_start'), prompt: event.prompt };
        const injected = await dispatchContext(deps.dispatch, 'before_agent_start', ctx.cwd, payload);
        if (injected) parts.push(injected);
      }
    } catch (err) {
      log('[Hooks] before_agent_start handler failed: %O', err);
    }

    const drained = contextStash.get(sessionId);
    if (drained?.length) {
      contextStash.delete(sessionId);
      parts.push(drained.join('\n\n'));
    }

    if (parts.length === 0) return undefined;
    return { message: { customType: HOOK_CONTEXT_CUSTOM_TYPE, content: parts.join('\n\n'), display: false } };
  });

  // --- PostToolUse (tool_result) --------------------------------------------
  pi.on('tool_result', async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    // Drain (read + delete) BEFORE the panel guard so a session rebind can't leave a permanent orphan
    // entry keyed by a forever-unique toolCallId.
    const stash = deps.preToolUseContextStash;
    const preToolUseContext = stash ? takePreToolUseContext(stash, event.toolCallId) : undefined;
    const panel = deps.registry.get(sessionId);
    if (!panel) return undefined;
    // Zero-cost when unconfigured (FR-14): only build the payload if a tool_result hook is set or there
    // is stashed PreToolUse context to deliver.
    if (!config.hasEntries('tool_result') && !preToolUseContext?.length) return undefined;
    try {
      return await buildToolResultPatch(deps.dispatch, buildHookCommon(ctx), event, {
        ...(preToolUseContext?.length ? { preToolUseContext } : {}),
        notify: (messages) => postHookSystemMessages((m) => panel.postMessage(m), messages),
      });
    } catch (err) {
      log('[Hooks] tool_result handler failed: %O', err);
      return undefined;
    }
  });

  // --- Stop (agent_end) — observe-only --------------------------------------
  pi.on('agent_end', async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    // Turn boundary: sweep this session's orphaned PreToolUse context (a tool that proceeded but whose
    // tool_result never arrived). Unconditional — runs even when no agent_end hook is configured.
    if (deps.preToolUseContextStash) clearSessionPreToolUseContext(deps.preToolUseContextStash, sessionId);
    if (!deps.registry.get(sessionId) || !config.hasEntries('agent_end')) return;
    try {
      await dispatchObserveOnly(deps.dispatch, 'agent_end', ctx.cwd, buildAgentEndPayload(buildHookCommon(ctx), event.messages));
    } catch (err) {
      log('[Hooks] agent_end (Stop) handler failed: %O', err);
    }
  });

  // --- Session lifecycle (observe-only) -------------------------------------
  pi.on('session_start', async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!deps.registry.get(sessionId) || !config.hasEntries('session_start')) return;
    try {
      await dispatchObserveOnly(deps.dispatch, 'session_start', ctx.cwd, buildSessionStartPayload(buildHookCommon(ctx), event.reason));
    } catch (err) {
      log('[Hooks] session_start handler failed: %O', err);
    }
  });

  pi.on('session_shutdown', async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    // Final orphan sweep: a panel closed mid-turn (before agent_end) would otherwise leak its entries in
    // the process-global stash. Unconditional, like the agent_end sweep.
    if (deps.preToolUseContextStash) clearSessionPreToolUseContext(deps.preToolUseContextStash, sessionId);
    if (!deps.registry.get(sessionId) || !config.hasEntries('session_shutdown')) return;
    try {
      await dispatchObserveOnly(deps.dispatch, 'session_shutdown', ctx.cwd, buildSessionEndPayload(buildHookCommon(ctx), event.reason));
    } catch (err) {
      log('[Hooks] session_shutdown handler failed: %O', err);
    }
  });

  pi.on('session_before_compact', async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!deps.registry.get(sessionId) || !config.hasEntries('session_before_compact')) return;
    try {
      await dispatchObserveOnly(
        deps.dispatch,
        'session_before_compact',
        ctx.cwd,
        buildPreCompactPayload(buildHookCommon(ctx), event.reason, event.willRetry),
      );
    } catch (err) {
      log('[Hooks] session_before_compact handler failed: %O', err);
    }
  });

  pi.on('session_compact', async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!deps.registry.get(sessionId) || !config.hasEntries('session_compact')) return;
    try {
      await dispatchObserveOnly(
        deps.dispatch,
        'session_compact',
        ctx.cwd,
        buildSessionCompactPayload(buildHookCommon(ctx), event.reason, event.willRetry, event.fromExtension),
      );
    } catch (err) {
      log('[Hooks] session_compact handler failed: %O', err);
    }
  });

  // --- Tier-2 observe-only (US-007) -----------------------------------------
  // Registered via a name-keyed cast because pi.on's overloads are per-literal; the handler reads only
  // ctx (never event-specific fields), so one generic handler serves every Tier-2 key.
  const onAny = pi.on as unknown as (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => void;
  for (const eventKey of TIER2_EVENTS) {
    onAny(eventKey, async (_event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!deps.registry.get(sessionId) || !config.hasEntries(eventKey)) return;
      try {
        await dispatchObserveOnly(deps.dispatch, eventKey, ctx.cwd, buildGenericPayload(buildHookCommon(ctx), eventKey));
      } catch (err) {
        log('[Hooks] %s handler failed: %O', eventKey, err);
      }
    });
  }
}
