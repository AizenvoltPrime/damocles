import * as fs from 'fs';
import * as path from 'path';
import { PI_AGENT_DIR } from './agent-dir';

// The plugin wraps pi-ai's Anthropic transport and adds Claude Code's billing block, which bills the
// subscription's included allowance; the same OAuth token without it meters as extra usage.
const SUBSCRIPTION_REPO = 'https://github.com/gotgenes/pi-anthropic-auth';

// `@<sha>`, not `#<sha>`: pi's parseGitUrl keeps a `#` fragment on the clone URL, which breaks `git clone`.
// Before bumping, run the plugin's tests against Damocles' pi version; nothing in this repo's CI clones it.
export const SUBSCRIPTION_SOURCE: string = `${SUBSCRIPTION_REPO}@fc183fc54171c1fc511570733d8f86b9f66426f6`;

// pi keys git packages by repo identity, so a replaced plugin's entry is invisible to checks on the current repo.
export const LEGACY_SUBSCRIPTION_REPOS: readonly string[] = [
  'https://github.com/AizenvoltPrime/pi-anthropic-oauth',
  'https://github.com/AizenvoltPrime/pi-anthropic-auth',
];

export type SubscriptionSourceKind = 'current' | 'stale' | 'legacy' | 'unrelated';

// The committish test keeps a sibling repo that shares the prefix (`…-experimental`) from matching.
function namesRepo(source: string, repo: string): boolean {
  if (!source.startsWith(repo)) return false;
  const committish = source.slice(repo.length);
  return committish === '' || committish.startsWith('@') || committish.startsWith('#');
}

export function classifySubscriptionSource(source: string): SubscriptionSourceKind {
  if (source === SUBSCRIPTION_SOURCE) return 'current';
  if (namesRepo(source, SUBSCRIPTION_REPO)) return 'stale';
  if (LEGACY_SUBSCRIPTION_REPOS.some((repo) => namesRepo(source, repo))) return 'legacy';
  return 'unrelated';
}

export function listedSubscriptionKinds(
  packages: readonly (string | { source: string })[],
): ReadonlySet<Exclude<SubscriptionSourceKind, 'unrelated'>> {
  const kinds = new Set<Exclude<SubscriptionSourceKind, 'unrelated'>>();
  for (const pkg of packages) {
    const kind = classifySubscriptionSource(typeof pkg === 'string' ? pkg : pkg.source);
    if (kind !== 'unrelated') kinds.add(kind);
  }
  return kinds;
}

/**
 * Active Claude auth mode:
 * - `none`: no credential stored.
 * - `apikey`: Anthropic API key (bills the API account).
 * - `allowance`: subscription OAuth with a subscription plugin listed (bills the included allowance).
 * - `extra`: subscription OAuth with no plugin listed (metered extra usage).
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
  if (credType === 'oauth') return { mode: isPluginListedOnDisk(agentDir) ? 'allowance' : 'extra' };
  return { mode: 'none' };
}

// A legacy-only entry reads as allowance: that is what it bills until migrated.
function isPluginListedOnDisk(agentDir: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')) as { packages?: unknown };
    if (!Array.isArray(parsed.packages)) return false;
    const packages = parsed.packages.filter(
      (p): p is string | { source: string } =>
        typeof p === 'string' || (typeof p === 'object' && p !== null && typeof (p as { source?: unknown }).source === 'string'),
    );
    return listedSubscriptionKinds(packages).size > 0;
  } catch {
    return false;
  }
}
