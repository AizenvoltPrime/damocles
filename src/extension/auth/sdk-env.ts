import { existsSync } from "node:fs";
import { DAMOCLES_CONFIG_DIR, DAMOCLES_CREDENTIALS_PATH } from "./paths";
import { getAnthropicAccessTokenSync, hasValidAnthropicGrant } from "./anthropic-token";
import { DEFAULT_MODELS } from "../../shared/types/constants";
import type { ModelInfo } from "../../shared/types/settings";
import { log } from "../logger";
import packageJson from "../../../package.json";

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
 * On Windows, also force-enables the SDK's PowerShell tool by setting
 * `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` (introduced in SDK 2.1.111 as a
 * progressive rollout). A pre-existing value in the shell wins, so users and
 * enterprise admins can still opt out. Every site that calls the SDK must
 * pass the result as `options.env` — that way the SDK subprocess sees the
 * Damocles config dir without mutating the shared extension-host
 * `process.env`, which would leak into peer extensions (e.g. the Claude Code
 * VS Code extension) that read the same variable.
 *
 * On Linux the bundled binary has no secure-store backend and will not persist
 * a real token to a custom `CLAUDE_CONFIG_DIR`'s `.credentials.json` (it leaves
 * a `{}` placeholder). So the Damocles-owned access token is injected as
 * `CLAUDE_CODE_OAUTH_TOKEN`, which the binary reads in preference to the file.
 * The refresh token is deliberately withheld — Damocles owns refresh, and a
 * subprocess that could self-refresh would clobber the placeholder file again.
 * This stays synchronous and does no per-call file I/O: the token comes from
 * the manager's in-memory cache (one lazy sync read on first use).
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
  if (process.platform === "win32" && !("CLAUDE_CODE_USE_POWERSHELL_TOOL" in result)) {
    result["CLAUDE_CODE_USE_POWERSHELL_TOOL"] = "1";
  }
  if (process.platform === "linux") {
    const token = getAnthropicAccessTokenSync();
    if (token) result["CLAUDE_CODE_OAUTH_TOKEN"] = token;
  }
  result["AI_AGENT"] = "claude-code-damocles";
  result["CLAUDE_AGENT_SDK_CLIENT_APP"] = `damocles/${packageJson.version}`;
  return result;
}

export interface RequireAuthForResult {
  ok: boolean;
  /** When ok=false, the model the caller asked for. */
  modelValue: string;
  /** When ok=false, the backend that has no credentials. */
  missingBackend: "anthropic" | "openai";
  /** When ok=false, human-readable message safe to log + show in a chat banner. */
  message: string;
}

const REQUIRE_AUTH_LOG_SUPPRESS = new Set<string>();

/**
 * Default suppress-once logger used when callers don't pass their own.
 * Keyed by `featureName:modelValue:missingBackend` so the same site emits
 * its banner exactly once per extension-host lifetime instead of spamming
 * the log on every iteration of a tight loop (Memory expansion, Recall
 * sub-calls).
 */
function defaultEmitOnce(key: string, message: string): void {
  if (REQUIRE_AUTH_LOG_SUPPRESS.has(key)) return;
  REQUIRE_AUTH_LOG_SUPPRESS.add(key);
  log("[requireAuthFor] %s", message);
}

function lookupModelInfo(modelValue: string | undefined | null): ModelInfo | undefined {
  if (!modelValue) return undefined;
  const stripped = modelValue.replace(/\[1m\]$/, "");
  return DEFAULT_MODELS.find(m => m.value === stripped);
}

/**
 * Resolves the ModelInfo for a given model value, checks whether credentials exist for that
 * model's backend, and emits a one-time per-session log + chat banner if missing.
 *
 * Used by Memory query-expansion, Recall sub-calls, and btw-handler. Returns `{ ok: true }` when
 * credentials exist, otherwise a populated failure object — callers gracefully degrade (no throw):
 * Memory returns raw query, Recall returns no expansion, btw-handler returns unchanged context.
 *
 * Anthropic creds live at `~/.damocles/auth/.credentials.json`. OpenAI-backed models run only on the
 * pi harness, so they are not routable through this SDK sub-call path and always degrade gracefully.
 */
export async function requireAuthFor(args: {
  modelValue: string;
  featureName: string;
  emitOnce?: (key: string, message: string) => void;
}): Promise<RequireAuthForResult> {
  const emit = args.emitOnce ?? defaultEmitOnce;
  const modelInfo = lookupModelInfo(args.modelValue);
  const backend: "anthropic" | "openai" = modelInfo?.backend === "openai" ? "openai" : "anthropic";

  if (backend === "anthropic") {
    // On Linux a `{}` `.credentials.json` exists but holds no token; check the
    // Damocles grant store for a real access token instead of mere file presence.
    const authed = process.platform === "linux"
      ? hasValidAnthropicGrant()
      : existsSync(DAMOCLES_CREDENTIALS_PATH);
    if (authed) {
      return { ok: true, modelValue: args.modelValue, missingBackend: "anthropic", message: "" };
    }
    const message = `[${args.featureName}] Skipped: model "${args.modelValue}" requires Anthropic sign-in (Damocles auth)`;
    emit(`${args.featureName}:${args.modelValue}:anthropic`, message);
    return { ok: false, modelValue: args.modelValue, missingBackend: "anthropic", message };
  }

  // OpenAI-backed models run exclusively on the pi harness; the SDK sub-call path cannot route
  // them, so they always degrade gracefully here (callers skip the sub-call, never throw).
  const message = `[${args.featureName}] Skipped: OpenAI model "${args.modelValue}" is not supported on the SDK sub-call path`;
  emit(`${args.featureName}:${args.modelValue}:openai`, message);
  return { ok: false, modelValue: args.modelValue, missingBackend: "openai", message };
}

/**
 * Backend-appropriate small/fast model — Haiku 4.5 for the Anthropic backend.
 * Sites that call this (memory query-expansion, recall sub-calls, btw-handler)
 * issue Anthropic sub-calls; on OpenAI-only setups they gracefully degrade
 * via `requireAuthFor` below.
 */
export const SMALL_FAST_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

export function getSmallFastModel(): string {
  return SMALL_FAST_ANTHROPIC_MODEL;
}
