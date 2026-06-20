import { spawn, type ChildProcess } from 'child_process';
import { log } from '../../logger';
import type { HookEntry, HookDecision } from './types';
import { emptyDecision } from './types';
import { substituteCommand, type SubstitutionContext } from './substitute';

/** Claude Code's default hook timeout. */
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

/** Upper bound on a configured `timeoutMs`: a typo'd huge value would otherwise stall the turn (dispatch
 *  is serial, so the gate blocks on it) until it elapsed. */
export const MAX_HOOK_TIMEOUT_MS = 600_000;

/** Hard cap on captured stdout/stderr so a runaway hook can't spike memory (output beyond is dropped). */
export const MAX_HOOK_OUTPUT_CHARS: number = 10 * 1024 * 1024;

/** Everything the runner needs beyond the entry + payload: spawn cwd/env + substitution + the event key. */
export interface RunHookContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  substitution: SubstitutionContext;
  eventKey: string;
}

interface SpawnOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function describeCommand(command: string | string[]): string {
  return Array.isArray(command) ? command.join(' ') : command;
}

/** A one-line decision summary for the transparency log (FR-16). */
function summarizeDecision(decision: HookDecision): string {
  const parts: string[] = [];
  if (decision.permissionDecision) parts.push(decision.permissionDecision);
  else if (decision.block) parts.push('block');
  if (decision.updatedInput) parts.push('updatedInput');
  if (decision.updatedToolOutput !== undefined) parts.push('updatedToolOutput');
  if (decision.additionalContext) parts.push('+context');
  if (decision.sessionTitle) parts.push('sessionTitle');
  if (decision.failed) parts.push('failed');
  return parts.length ? parts.join(',') : 'no-op';
}

/** Best-effort kill of the child and any descendants it spawned (a shell-string hook spawns its own tree). */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  const directKill = (): void => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already dead
    }
  };
  if (process.platform === 'win32') {
    try {
      const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      // spawn reports a missing/blocked `taskkill` ASYNCHRONOUSLY via an 'error' event, not a sync throw;
      // an unhandled 'error' on a ChildProcess crashes the extension host. Swallow it and fall back.
      tk.on('error', directKill);
    } catch {
      directKill();
    }
    return;
  }
  try {
    // The child is its own process-group leader (spawned `detached`), so a negative pid signals the
    // whole group — the shell AND its descendants — not just the shell.
    process.kill(-child.pid, 'SIGKILL');
    return;
  } catch {
    // group already gone, or not a leader — fall through to a direct kill
  }
  directKill();
}

function spawnHook(
  command: string | string[],
  payload: Record<string, unknown>,
  ctx: RunHookContext,
  timeoutMs: number,
): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve, reject) => {
    // Serialize BEFORE spawning: `payload` carries pi-controlled values (`event.details`), so a circular
    // ref or BigInt would throw here — fail-soft without leaving an orphaned child + pending timer.
    let serializedPayload: string;
    try {
      serializedPayload = JSON.stringify(payload);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    // POSIX: run the child in its own process group so a timeout kill reaches its descendants too.
    const detached = process.platform !== 'win32';
    const child = Array.isArray(command)
      ? spawn(command[0]!, command.slice(1), { cwd: ctx.cwd, env: ctx.env, shell: false, detached })
      : spawn(command, { cwd: ctx.cwd, env: ctx.env, shell: true, detached });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    // Decode as UTF-8 via the stream's internal StringDecoder so a multi-byte character split across two
    // chunks isn't corrupted into U+FFFD (which would make otherwise-valid JSON stdout unparseable).
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    // Slice to the remaining budget so a single huge write can't overshoot the cap by a full chunk.
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_HOOK_OUTPUT_CHARS) stdout += chunk.slice(0, MAX_HOOK_OUTPUT_CHARS - stdout.length);
    });
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_HOOK_OUTPUT_CHARS) stderr += chunk.slice(0, MAX_HOOK_OUTPUT_CHARS - stderr.length);
    });
    // A hook that never reads stdin would otherwise crash us with EPIPE on the write below.
    child.stdin?.on('error', () => {});

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, stdout, stderr, timedOut });
    });

    try {
      child.stdin?.end(serializedPayload);
    } catch {
      // stdin already closed (process exited) — ignore.
    }
  });
}

function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Interpret a parsed response object against the native (flat, snake_case) output contract:
 * `decision` ∈ allow|deny|block|ask, `reason`, `updated_input`, `updated_output`, `context`,
 * `session_title`, `system_message`. One name per field — no nesting, no aliases.
 */
function decisionFromJson(json: Record<string, unknown>): HookDecision {
  const decision = emptyDecision();

  const verdict = json['decision'];
  if (verdict === 'allow' || verdict === 'deny' || verdict === 'ask') {
    decision.permissionDecision = verdict;
    if (verdict === 'deny') decision.block = true;
  } else if (verdict === 'block') {
    decision.block = true;
  }
  const reason = asString(json['reason']);
  if (reason) decision.reason = reason;

  const updatedInput = json['updated_input'];
  if (updatedInput && typeof updatedInput === 'object' && !Array.isArray(updatedInput)) {
    decision.updatedInput = updatedInput as Record<string, unknown>;
  }

  const context = asString(json['context']);
  if (context && context.length > 0) decision.additionalContext = context;

  const updatedOutput = asString(json['updated_output']);
  if (updatedOutput !== undefined) decision.updatedToolOutput = updatedOutput;

  const sessionTitle = asString(json['session_title']);
  if (sessionTitle && sessionTitle.trim().length > 0) decision.sessionTitle = sessionTitle.trim();

  const systemMessage = asString(json['system_message']);
  if (systemMessage && systemMessage.length > 0) decision.systemMessage = systemMessage;

  return decision;
}

/**
 * Map a child's exit code + stdout onto a normalized `HookDecision`. Pure — no logging or I/O — so it is
 * unit-testable in isolation. Decisions come ONLY from the stdout JSON contract: the exit code is health,
 * so any non-zero exit is fail-soft (logged, no effect) and can never silently block. Plain (non-JSON)
 * stdout becomes context. (Infra failures — spawn error / timeout — set `failed` in `runHook`, which the
 * gate upgrades to fail-closed for write/shell; that is a safety property, not an exit-code convention.)
 */
export function parseHookOutput(exitCode: number, stdout: string, _stderr: string): HookDecision {
  if (exitCode !== 0) return emptyDecision();
  const trimmed = stdout.trim();
  if (!trimmed) return emptyDecision();
  const json = tryParseObject(trimmed);
  if (!json) return { ...emptyDecision(), additionalContext: trimmed };
  return decisionFromJson(json);
}

/**
 * Run one configured hook: substitute its command, spawn (shell-string or argv), write the native payload
 * to stdin, enforce the timeout, and parse the result. Never throws — spawn errors and timeouts resolve to
 * a fail-soft decision flagged `failed` (PreToolUse write/shell upgrades that to fail-closed; Section 3.3).
 */
export async function runHook(
  entry: HookEntry,
  payload: Record<string, unknown>,
  ctx: RunHookContext,
): Promise<HookDecision> {
  const command = substituteCommand(entry.command, ctx.substitution);
  // Log the PRE-substitution command: substitution expands `${env:NAME}`/`$NAME` (which include
  // provider/OAuth secrets) into the string, and the output channel must never capture those.
  const logged = describeCommand(entry.command);
  const timeoutMs = Math.min(entry.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS);
  try {
    const outcome = await spawnHook(command, payload, ctx, timeoutMs);
    if (outcome.timedOut) {
      log('[Hooks] %s: timed out after %dms: %s', ctx.eventKey, timeoutMs, logged);
      return { ...emptyDecision(), failed: true };
    }
    if (outcome.exitCode !== 0 && outcome.stderr.trim()) {
      log('[Hooks] %s: non-zero exit %d: %s', ctx.eventKey, outcome.exitCode, outcome.stderr.trim());
    }
    const decision = parseHookOutput(outcome.exitCode, outcome.stdout, outcome.stderr);
    log('[Hooks] %s: %s (exit %d) → %s', ctx.eventKey, logged, outcome.exitCode, summarizeDecision(decision));
    return decision;
  } catch (err) {
    log('[Hooks] %s: spawn failed for %s: %O', ctx.eventKey, logged, err);
    return { ...emptyDecision(), failed: true };
  }
}
