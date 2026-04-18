import { DAMOCLES_CONFIG_DIR } from "./paths";

/**
 * Env vars that must never reach an SDK subprocess. Both belong to the
 * standalone Claude Code CLI's authentication surface — `CLAUDE_CODE_OAUTH_TOKEN`
 * is the CLI's session token; `ANTHROPIC_API_KEY` is the API-key fallback.
 * Either, if set in the launching shell, would bypass Damocles's own credentials
 * file and silently authenticate the SDK against the wrong account.
 *
 * Reused by `sanitizeProcessEnvForSdk()` (process-wide strip at activation) and
 * by `query-manager.ts:buildEnv()` (defense-in-depth strip on every main-chat
 * spawn) to guarantee a single source of truth.
 */
export const SDK_STRIPPED_ENV_KEYS: readonly string[] = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
] as const;

/**
 * Strip CLI-leaked OAuth env vars and pin CLAUDE_CONFIG_DIR to the Damocles
 * config directory. Called once at activation, before any SDK subprocess can
 * spawn. Idempotent — safe to call multiple times.
 *
 * The other SDK spawners (team agents, recall, recall sub-calls, haiku
 * orientation, BTW, memory expansion) pass no explicit `env` to `query()` and
 * therefore inherit the extension's `process.env` directly via Node's default
 * spawn-env inheritance, so this single mutation covers all of them. The main
 * chat and warmup paths both flow through `query-manager.ts:buildEnv()`, which
 * re-applies the same strip as defense-in-depth.
 */
export function sanitizeProcessEnvForSdk(): void {
  for (const key of SDK_STRIPPED_ENV_KEYS) {
    delete process.env[key];
  }
  process.env["CLAUDE_CONFIG_DIR"] = DAMOCLES_CONFIG_DIR;
}
