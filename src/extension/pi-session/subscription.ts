import * as fs from 'fs';
import * as path from 'path';
import { PI_AGENT_DIR } from './agent-dir';

/**
 * The third-party pi extension that adds Claude Pro/Max subscription support. Damocles neither
 * authors nor ships it (FR-2): it is installed into pi's user scope via the package manager, and
 * pi's loader registers the Claude Pro/Max provider.
 *
 * The plugin is a request-shaping LAYER, not a separate credential. The Claude OAuth token
 * (`sk-ant-oat…`) is identical whether or not the plugin is present — the plugin makes each request
 * look like the real Claude Code CLI (`user-agent: claude-code/…`, Claude-Code betas, "You are
 * Claude Code" identity), which Anthropic bills against the subscription's included ALLOWANCE.
 * Without the plugin, pi-ai's built-in anthropic provider sends `user-agent: claude-cli/…`, which
 * Anthropic METERS as extra usage on the same token. So toggling the plugin switches the billing
 * bucket for one shared token, with no re-login.
 */
// Pinned to a commit via the `@<sha>` committish (NOT `#<sha>` — pi's parseGitUrl leaves a `#`
// fragment attached to the clone URL, which breaks `git clone`; `@<sha>` is stripped into the ref).
export const SUBSCRIPTION_SOURCE =
  'https://github.com/AizenvoltPrime/pi-anthropic-oauth@aad0288be546b1b9985af295157fbc63cc3cfc2f';

/**
 * Active Claude auth mode:
 * - `none` — no credential stored.
 * - `apikey` — Anthropic API key (bills the API account).
 * - `allowance` — subscription OAuth + plugin loaded (`claude-code/…` → included allowance).
 * - `extra` — subscription OAuth without the plugin (`claude-cli/…` → metered extra usage).
 */
export type ClaudeAuthMode = 'none' | 'apikey' | 'allowance' | 'extra';

export interface ClaudeAuthStatus {
  mode: ClaudeAuthMode;
}

/**
 * Derive the Claude auth mode straight from disk without loading pi, so the settings panel can
 * render on open. Mode = credential type (auth.json) combined with plugin presence (settings.json).
 */
export function readClaudeAuthFromDisk(agentDir: string = PI_AGENT_DIR): ClaudeAuthStatus {
  let credType: string | undefined;
  try {
    const raw = fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, { type?: string } | undefined>;
    credType = parsed['anthropic']?.type;
  } catch {
    // No auth.json — not signed in.
  }

  if (credType === 'api_key') return { mode: 'apikey' };
  if (credType === 'oauth') return { mode: isPluginInstalledOnDisk(agentDir) ? 'allowance' : 'extra' };
  return { mode: 'none' };
}

function isPluginInstalledOnDisk(agentDir: string): boolean {
  try {
    return fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8').includes('pi-anthropic-oauth');
  } catch {
    return false;
  }
}
