/**
 * enabled-models.ts — Resolve pi's `enabledModels` scope for subagent model validation.
 *
 * Ported from @tintinweb/pi-subagents (MIT, © 2026 tintinweb; see THIRD-PARTY-NOTICES.md).
 * Reads `enabledModels` from pi settings (global `PI_AGENT_DIR/settings.json` + project-local
 * `<cwd>/.pi/settings.json`, project wins) and resolves entries to concrete `provider/modelId`
 * keys. Only exact `provider/modelId` matching is supported (pi's `/scoped-models` picker writes
 * exact entries); globs / bare ids / `:thinking` suffixes are silently ignored.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PI_AGENT_DIR } from '../agent-dir';
import { log } from '../../logger';

/** Minimal model shape used for scope resolution. */
export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

/** Minimal runtime shape — only the method resolveEnabledModels actually calls. `ModelRuntime`
 *  satisfies it structurally. */
export interface ModelRuntimeRef {
  getAvailableSnapshot(): readonly unknown[];
}

/** Paths to pi's settings.json files: [project, global] (project takes precedence). */
function settingsPaths(cwd: string): [project: string, global: string] {
  return [join(cwd, '.pi', 'settings.json'), join(PI_AGENT_DIR, 'settings.json')];
}

/** Read `enabledModels` from a single settings.json file. Undefined when missing or absent. */
function readField(path: string): string[] | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    // A hand-edited settings.json can hold non-string entries; keep only strings so downstream
    // `.trim()`/`.indexOf()` can't throw and break the documented fail-soft contract.
    if (Array.isArray(raw?.enabledModels)) return raw.enabledModels.filter((e: unknown): e is string => typeof e === 'string');
  } catch {
    /* corrupt file — silent */
  }
  return undefined;
}

/** Read enabledModels from pi's settings — project-local overrides global. */
export function readEnabledModels(cwd: string): string[] | undefined {
  const [project, global] = settingsPaths(cwd);
  return readField(project) ?? readField(global);
}

/**
 * Resolve enabledModels patterns → Set<"provider/modelId"> (lowercase keys). Returns:
 *   - `undefined` ONLY when no allowlist is configured (no patterns) → scope check is a no-op (allow any),
 *   - an EMPTY set when an allowlist IS configured but nothing resolved (typo / unauthed provider /
 *     renamed model) → denies every model. An allowlist that fails to resolve must NOT silently widen to
 *     "allow any" — that would mask the misconfiguration, so the failure is surfaced (the spawn is denied
 *     with a scope error) and logged.
 * Resolved fresh against the live runtime on every call (invoked once per spawn, not a hot path) so a
 * provider authenticating or deauthenticating mid-session is reflected immediately.
 */
export function resolveEnabledModels(patterns: string[] | undefined, registry: ModelRuntimeRef): Set<string> | undefined {
  if (!patterns || patterns.length === 0) return undefined;

  // No fallback: the snapshot is populated at init; an empty snapshot legitimately means the documented
  // fail-closed deny-all (a configured allowlist that resolves nothing denies every subagent model).
  const available = registry.getAvailableSnapshot() as ModelEntry[];
  const allowed = new Set<string>();
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (!trimmed) continue;
    resolveExact(trimmed, available, allowed);
  }
  if (allowed.size === 0) {
    log('[enabled-models] configured enabledModels resolved to zero available models (denying all subagent models): %o', patterns);
  }
  return allowed;
}

/** True when `model` is in the allowed set. Centralizes the key format (`provider/id` lowercase). */
export function isModelInScope(model: { provider: string; id: string }, allowed: Set<string>): boolean {
  return allowed.has(modelKey(model));
}

/** Canonical lowercase `provider/id` key for the allowed set. */
function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`.toLowerCase();
}

/** Resolve an exact `provider/modelId` pattern against the available set. */
function resolveExact(pattern: string, available: ModelEntry[], allowed: Set<string>): void {
  const slashIdx = pattern.indexOf('/');
  if (slashIdx === -1) return; // bare modelId not supported

  const provider = pattern.slice(0, slashIdx).toLowerCase();
  const modelId = pattern.slice(slashIdx + 1).toLowerCase();
  const exact = available.find((m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === modelId);
  if (exact) allowed.add(modelKey(exact));
}
