import { log } from '../../logger';
import type { HooksConfigService } from './config';
import type { HookEntry } from './types';
import { runHook, type RunHookContext } from './runner';
import {
  buildToolCallPayload,
  buildToolResultPayload,
  buildInputPayload,
  type HookCommon,
} from './payload';

/** Ambient deps every dispatch needs: the config source plus the roots used for env + substitution. */
export interface DispatchDeps {
  config: HooksConfigService;
  workspaceRoot: string | undefined;
  userHome: string;
}

function buildRunContext(deps: DispatchDeps, eventKey: string, cwd: string): RunHookContext {
  const wsRoot = deps.workspaceRoot ?? cwd;
  return {
    cwd,
    env: {
      ...process.env,
      DAMOCLES_PROJECT_DIR: wsRoot,
      DAMOCLES_HOOK_EVENT: eventKey,
    },
    substitution: { workspaceFolder: wsRoot, userHome: deps.userHome, env: process.env },
    eventKey,
  };
}

/**
 * Compiled-regex cache for `match` patterns. A config has a handful of distinct patterns, so this avoids
 * recompiling on every tool call; `null` marks a pattern that failed to compile (skipped, warned once).
 */
const matchRegexCache = new Map<string, RegExp | null>();

function compileMatch(pattern: string): RegExp | null {
  const cached = matchRegexCache.get(pattern);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null;
  try {
    compiled = new RegExp(pattern);
  } catch (err) {
    log('[Hooks] invalid match regex %j skipped: %O', pattern, err);
    compiled = null;
  }
  matchRegexCache.set(pattern, compiled);
  return compiled;
}

/** Keep only entries whose optional `match` regex tests true against the Damocles tool name (FR-8). */
function matchEntries(entries: HookEntry[], toolName: string): HookEntry[] {
  return entries.filter((entry) => {
    if (!entry.match) return true;
    const regex = compileMatch(entry.match);
    return regex ? regex.test(toolName) : false;
  });
}

/** PreToolUse reconciliation (Section 3.4): deny > allow > ask, with `updatedInput` applied in order. */
export interface ToolCallHookResult {
  decision: 'allow' | 'deny' | 'ask';
  /** The hook asked to end the turn (response `terminate`). Only ever set alongside `decision: 'deny'`. */
  terminate?: boolean;
  reason?: string;
  additionalContext?: string;
  /** The CC-shaped input after all `updatedInput` merges (already chained across hooks). */
  finalInput: Record<string, unknown>;
  mutated: boolean;
  /** A spawn error/timeout occurred — PreToolUse upgrades this to fail-closed for write/shell. */
  anyFailed: boolean;
  systemMessages: string[];
}

/**
 * Run the `tool_call` (PreToolUse) hooks for one tool call. Each hook sees the prior hook's `updatedInput`
 * mutations (payload rebuilt per hook), matching pi's "later tool_call handlers see earlier mutations".
 * Returns null when no hook matches (the FR-14 zero-cost path). The CALLER applies `finalInput` to the pi
 * event (after `denormalizeToolInput`) and branches on `decision` inside the gate (Section 3.3).
 */
export async function dispatchToolCall(
  deps: DispatchDeps,
  params: { common: HookCommon; toolName: string; toolInput: Record<string, unknown> },
): Promise<ToolCallHookResult | null> {
  const entries = matchEntries(deps.config.getEntries('tool_call'), params.toolName);
  if (entries.length === 0) return null;

  const ctx = buildRunContext(deps, 'tool_call', params.common.cwd);
  let working: Record<string, unknown> = { ...params.toolInput };
  let mutated = false;
  let anyFailed = false;
  let sawDeny = false;
  let sawAllow = false;
  let sawTerminate = false;
  const denyReasons: string[] = [];
  const allowReasons: string[] = [];
  const contexts: string[] = [];
  const systemMessages: string[] = [];

  for (const entry of entries) {
    const payload = buildToolCallPayload(params.common, params.toolName, working);
    const decision = await runHook(entry, payload, ctx);
    if (decision.failed) anyFailed = true;
    if (decision.updatedInput) {
      working = { ...working, ...decision.updatedInput };
      mutated = true;
    }
    if (decision.additionalContext) contexts.push(decision.additionalContext);
    if (decision.systemMessage) systemMessages.push(decision.systemMessage);

    const effective =
      decision.permissionDecision === 'deny' || decision.block
        ? 'deny'
        : decision.permissionDecision === 'allow'
          ? 'allow'
          : 'ask';
    if (effective === 'deny') {
      sawDeny = true;
      // `terminate` counts only from a hook that actually denied: pi honors it only on a blocked call.
      if (decision.terminate) sawTerminate = true;
      if (decision.reason) denyReasons.push(decision.reason);
    } else if (effective === 'allow') {
      sawAllow = true;
      if (decision.reason) allowReasons.push(decision.reason);
    }
  }

  const decision: 'allow' | 'deny' | 'ask' = sawDeny ? 'deny' : sawAllow ? 'allow' : 'ask';
  const reason =
    decision === 'deny'
      ? denyReasons.join('; ') || undefined
      : decision === 'allow'
        ? allowReasons.join('; ') || undefined
        : undefined;

  return {
    decision,
    ...(decision === 'deny' && sawTerminate ? { terminate: true } : {}),
    ...(reason ? { reason } : {}),
    ...(contexts.length ? { additionalContext: contexts.join('\n\n') } : {}),
    finalInput: working,
    mutated,
    anyFailed,
    systemMessages,
  };
}

/** Rebuild the `result` object with a hook's replacement output so the next tool_result hook chains on it. */
function withUpdatedOutput(response: unknown, output: string): unknown {
  return response && typeof response === 'object' && !Array.isArray(response)
    ? { ...(response as Record<string, unknown>), output }
    : output;
}

/** PostToolUse reconciliation: any block → block (isError + reason); `updatedToolOutput` chains hook→hook. */
export interface ToolResultHookResult {
  block: boolean;
  reason?: string;
  updatedToolOutput?: string;
  additionalContext?: string;
  systemMessages: string[];
}

export async function dispatchToolResult(
  deps: DispatchDeps,
  params: { common: HookCommon; toolName: string; toolInput: Record<string, unknown>; toolResponse: unknown },
): Promise<ToolResultHookResult | null> {
  const entries = matchEntries(deps.config.getEntries('tool_result'), params.toolName);
  if (entries.length === 0) return null;

  const ctx = buildRunContext(deps, 'tool_result', params.common.cwd);

  let block = false;
  let updatedToolOutput: string | undefined;
  // Chain like tool_call (and pi's own tool_result middleware): rebuild the payload per hook so hook N
  // sees hook N-1's replacement in `result.output` instead of the original.
  let currentResponse = params.toolResponse;
  const reasons: string[] = [];
  const contexts: string[] = [];
  const systemMessages: string[] = [];
  for (const entry of entries) {
    const payload = buildToolResultPayload(params.common, params.toolName, params.toolInput, currentResponse);
    const decision = await runHook(entry, payload, ctx);
    if (decision.block) {
      block = true;
      if (decision.reason) reasons.push(decision.reason);
    }
    if (decision.updatedToolOutput !== undefined) {
      updatedToolOutput = decision.updatedToolOutput;
      currentResponse = withUpdatedOutput(currentResponse, decision.updatedToolOutput);
    }
    if (decision.additionalContext) contexts.push(decision.additionalContext);
    if (decision.systemMessage) systemMessages.push(decision.systemMessage);
  }

  return {
    block,
    ...(reasons.length ? { reason: reasons.join('; ') } : {}),
    ...(updatedToolOutput !== undefined ? { updatedToolOutput } : {}),
    ...(contexts.length ? { additionalContext: contexts.join('\n\n') } : {}),
    systemMessages,
  };
}

/** UserPromptSubmit reconciliation: any block → block; context concatenated; last sessionTitle wins. */
export interface InputHookResult {
  block: boolean;
  reason?: string;
  additionalContext?: string;
  sessionTitle?: string;
  systemMessages: string[];
}

export async function dispatchInput(
  deps: DispatchDeps,
  params: { common: HookCommon; prompt: string },
): Promise<InputHookResult | null> {
  const entries = deps.config.getEntries('input');
  if (entries.length === 0) return null;

  const ctx = buildRunContext(deps, 'input', params.common.cwd);
  const payload = buildInputPayload(params.common, params.prompt);

  let block = false;
  let sessionTitle: string | undefined;
  const reasons: string[] = [];
  const contexts: string[] = [];
  const systemMessages: string[] = [];
  for (const entry of entries) {
    const decision = await runHook(entry, payload, ctx);
    if (decision.block) {
      block = true;
      if (decision.reason) reasons.push(decision.reason);
    }
    if (decision.additionalContext) contexts.push(decision.additionalContext);
    if (decision.sessionTitle) sessionTitle = decision.sessionTitle;
    if (decision.systemMessage) systemMessages.push(decision.systemMessage);
  }

  return {
    block,
    ...(reasons.length ? { reason: reasons.join('; ') } : {}),
    ...(contexts.length ? { additionalContext: contexts.join('\n\n') } : {}),
    ...(sessionTitle ? { sessionTitle } : {}),
    systemMessages,
  };
}

/**
 * Run an event's hooks and return the context they emit (additionalContext or plain stdout), concatenated
 * in order. Returns undefined when no hook matches or none produced context. Used by `before_agent_start`
 * (US-004): a pi-native bonus key with no Claude Code analogue whose stdout is injected as run context.
 */
export async function dispatchContext(
  deps: DispatchDeps,
  eventKey: string,
  cwd: string,
  payload: Record<string, unknown>,
): Promise<string | undefined> {
  const entries = deps.config.getEntries(eventKey);
  if (entries.length === 0) return undefined;
  const ctx = buildRunContext(deps, eventKey, cwd);
  const contexts: string[] = [];
  for (const entry of entries) {
    const decision = await runHook(entry, payload, ctx);
    if (decision.additionalContext) contexts.push(decision.additionalContext);
  }
  return contexts.length ? contexts.join('\n\n') : undefined;
}

/**
 * Fire-and-forget dispatch for observe-only events (Stop/SubagentStop, session_*, Tier-2,
 * permission_required): run every configured entry for `eventKey` against a prebuilt payload and discard
 * the result. Returns the number of hooks run (for logging/tests). Never throws.
 *
 * Entries run CONCURRENTLY: the result is discarded so order is irrelevant, and serializing them would
 * let one slow/hung hook stall the turn for the sum of every hook's timeout instead of just the slowest.
 */
export async function dispatchObserveOnly(
  deps: DispatchDeps,
  eventKey: string,
  cwd: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const entries = deps.config.getEntries(eventKey);
  if (entries.length === 0) return 0;
  const ctx = buildRunContext(deps, eventKey, cwd);
  await Promise.all(entries.map((entry) => runHook(entry, payload, ctx)));
  return entries.length;
}
