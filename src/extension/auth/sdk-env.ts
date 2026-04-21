import { DAMOCLES_CONFIG_DIR } from "./paths";

/**
 * Env vars that must never reach an SDK subprocess. Both belong to the
 * standalone Claude Code CLI's authentication surface — `CLAUDE_CODE_OAUTH_TOKEN`
 * is the CLI's session token; `ANTHROPIC_API_KEY` is the API-key fallback.
 * Either, if set in the launching shell, would bypass Damocles's own credentials
 * file and silently authenticate the SDK against the wrong account.
 */
export const SDK_STRIPPED_ENV_KEYS: readonly string[] = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
] as const;

/**
 * Build a sanitized env record for SDK `query()` / `startup()` options.
 *
 * Returns a shallow copy of `process.env` with shell-level CLI auth env vars
 * stripped and `CLAUDE_CONFIG_DIR` pinned to the Damocles config directory.
 * Every site that calls the SDK must pass the result as `options.env` — that
 * way the SDK subprocess sees the Damocles config dir without mutating the
 * shared extension-host `process.env`, which would leak into peer extensions
 * (e.g. the Claude Code VS Code extension) that read the same variable.
 */
export function buildSdkEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  const stripped = new Set<string>(SDK_STRIPPED_ENV_KEYS);
  for (const [key, value] of Object.entries(process.env)) {
    if (stripped.has(key)) continue;
    if (value === undefined) continue;
    result[key] = value;
  }
  result["CLAUDE_CONFIG_DIR"] = DAMOCLES_CONFIG_DIR;
  return result;
}
