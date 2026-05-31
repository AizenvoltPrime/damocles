import * as fs from "node:fs";
import * as path from "node:path";
import { DAMOCLES_ANTHROPIC_GRANT_PATH } from "./paths";
import { log } from "../logger";

/**
 * Anthropic OAuth refresh wire format, mirrored from the bundled Claude Code SDK
 * (`claude-agent-sdk/assistant.mjs`): a JSON body POSTed to `/v1/oauth/token`
 * with the `anthropic-beta` header that gates the OAuth API. The grant Damocles
 * captures at `/login` is minted for this client, so refresh must present the
 * same id and beta header — a form-encoded body without the beta header is
 * rejected. No `User-Agent` is sent: the endpoint doesn't require one (the
 * existing Codex OAuth refresh sends none), and omitting it keeps any
 * Damocles-identifying marker off a request that uses Claude Code's client id.
 */
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_BETA = "oauth-2025-04-20";

/** Refresh this far before `expiresAt` so a token never reaches a subprocess already expired. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
/** setTimeout caps at ~24.8 days; tokens live hours, but clamp so a corrupt expiry can't overflow. */
const MAX_TIMER_DELAY_MS = 6 * 60 * 60 * 1000;
/** Floor delay for re-arming the timer after a failed refresh, so transient failures retry without storming. */
const REFRESH_RETRY_MS = 60 * 1000;
/** Below this, a captured `expiresAt` is in seconds, not ms (1e12 ms = 2001; real expiries are ~1.7e12). */
const MS_THRESHOLD = 1e12;

/**
 * The Anthropic OAuth grant, matching the `claudeAiOauth` object the bundled
 * binary persists to `.credentials.json`. `expiresAt` is a Unix timestamp in
 * **milliseconds** (the binary's persisted unit, not its internal seconds cache).
 */
export interface AnthropicGrant {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

/** On-disk shape of the grant store, identical to what the binary writes. */
interface GrantStoreFile {
  claudeAiOauth: AnthropicGrant;
  organizationUuid?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

let current: AnthropicGrant | null = null;
let organizationUuid: string | undefined;
let loaded = false;
let refreshInFlight: Promise<AnthropicGrant | null> | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let grantPath = DAMOCLES_ANTHROPIC_GRANT_PATH;

function suffix(value: string | null | undefined): string {
  if (!value) return "<none>";
  return value.length <= 4 ? "****" : `…${value.slice(-4)}`;
}

function isValidGrant(value: unknown): value is AnthropicGrant {
  if (!value || typeof value !== "object") return false;
  const g = value as Record<string, unknown>;
  return (
    typeof g["accessToken"] === "string" && g["accessToken"].length > 0 &&
    typeof g["refreshToken"] === "string" && g["refreshToken"].length > 0 &&
    typeof g["expiresAt"] === "number" && Number.isFinite(g["expiresAt"])
  );
}

/**
 * Parse a raw `.credentials.json`/grant-store payload into a validated grant.
 * Returns `null` for the `{}` placeholder the binary leaves on Linux, malformed
 * JSON, or a grant missing a real `accessToken`/`refreshToken`. Shared by the
 * store reader and the `/login` capture path. `expiresAt` is canonicalized to
 * milliseconds so the rest of the module compares it against `Date.now()`
 * regardless of whether the binary wrote seconds or ms.
 */
export function parseAnthropicGrant(raw: string): { grant: AnthropicGrant; organizationUuid?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const oauth = (parsed as Record<string, unknown>)["claudeAiOauth"];
  if (!isValidGrant(oauth)) return null;
  const grant: AnthropicGrant = { ...oauth, expiresAt: toMillis(oauth.expiresAt) };
  const org = (parsed as Record<string, unknown>)["organizationUuid"];
  return {
    grant,
    ...(typeof org === "string" ? { organizationUuid: org } : {}),
  };
}

function toMillis(expiresAt: number): number {
  return expiresAt < MS_THRESHOLD ? expiresAt * 1000 : expiresAt;
}

function readStore(): { grant: AnthropicGrant; organizationUuid?: string } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(grantPath, "utf8");
  } catch {
    return null;
  }
  return parseAnthropicGrant(raw);
}

function writeStoreAtomic(grant: AnthropicGrant, org: string | undefined): void {
  try { fs.mkdirSync(path.dirname(grantPath), { recursive: true, mode: 0o700 }); }
  catch (err) { log("[AnthropicToken] mkdir %s failed: %O", path.dirname(grantPath), err); }

  const payload: GrantStoreFile = { claudeAiOauth: grant, ...(org ? { organizationUuid: org } : {}) };
  const tempPath = `${grantPath}.tmp.${process.pid}.${Date.now().toString(16)}${Math.floor(Math.random() * 0x100000).toString(16)}`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tempPath, grantPath);
  } catch (err) {
    log("[AnthropicToken] atomic write failed: %O", err);
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    throw err;
  }
}

function clearRefreshTimer(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function scheduleRefreshTimer(delayOverride?: number): void {
  clearRefreshTimer();
  if (!current) return;
  const delay = delayOverride ?? Math.max(0, Math.min(MAX_TIMER_DELAY_MS, current.expiresAt - REFRESH_BUFFER_MS - Date.now()));
  refreshTimer = setTimeout(() => { void ensureFreshAnthropicToken(); }, delay);
  refreshTimer.unref?.();
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const store = readStore();
  if (store) {
    current = store.grant;
    organizationUuid = store.organizationUuid;
    scheduleRefreshTimer();
  }
}

async function postRefresh(refreshToken: string): Promise<TokenResponse | null> {
  let response: Response;
  try {
    response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-beta": OAUTH_BETA,
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log("[AnthropicToken] Refresh request failed: %s", err instanceof Error ? err.message : String(err));
    return null;
  }
  if (!response.ok) {
    log("[AnthropicToken] Refresh rejected: status=%d", response.status);
    return null;
  }
  return (await response.json().catch(() => null)) as TokenResponse | null;
}

function buildRefreshedGrant(prev: AnthropicGrant, json: TokenResponse): AnthropicGrant | null {
  if (typeof json.access_token !== "string" || json.access_token.length === 0) return null;
  if (typeof json.expires_in !== "number" || !Number.isFinite(json.expires_in)) return null;
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" && json.refresh_token.length > 0
      ? json.refresh_token
      : prev.refreshToken,
    expiresAt: Date.now() + json.expires_in * 1000,
    ...(prev.scopes ? { scopes: prev.scopes } : {}),
    ...(prev.subscriptionType ? { subscriptionType: prev.subscriptionType } : {}),
    ...(prev.rateLimitTier ? { rateLimitTier: prev.rateLimitTier } : {}),
  };
}

async function performRefresh(prev: AnthropicGrant): Promise<AnthropicGrant | null> {
  const json = await postRefresh(prev.refreshToken);
  const refreshed = json ? buildRefreshedGrant(prev, json) : null;
  if (!refreshed) {
    if (json) log("[AnthropicToken] Refresh response missing access_token/expires_in");
    scheduleRefreshTimer(REFRESH_RETRY_MS);
    return null;
  }
  try {
    writeStoreAtomic(refreshed, organizationUuid);
  } catch {
    scheduleRefreshTimer(REFRESH_RETRY_MS);
    return null;
  }
  current = refreshed;
  scheduleRefreshTimer();
  log("[AnthropicToken] Refreshed token accessToken=%s", suffix(refreshed.accessToken));
  return refreshed;
}

function needsRefresh(grant: AnthropicGrant): boolean {
  return Date.now() >= grant.expiresAt - REFRESH_BUFFER_MS;
}

/**
 * Synchronous accessor for `buildSdkEnv()`. Performs at most one lazy sync read
 * of the grant store (first call), then serves the in-memory token. When the
 * cached token is within the refresh buffer it kicks an async refresh for the
 * next spawn and returns the current value — never blocks on the network.
 *
 * Past hard `expiresAt` it returns `null` instead of the dead token: the
 * injected `CLAUDE_CODE_OAUTH_TOKEN` is a static bearer with no refresh token
 * bound, so a stale value yields opaque API 401s. Omitting it lets the SDK
 * surface the clean "auth needed" path while the kicked refresh re-arms the token.
 */
export function getAnthropicAccessTokenSync(): string | null {
  ensureLoaded();
  if (!current) return null;
  if (needsRefresh(current)) void ensureFreshAnthropicToken();
  if (Date.now() >= current.expiresAt) return null;
  return current.accessToken;
}

/**
 * Returns a non-expired access token, refreshing if within the buffer.
 * Concurrent callers share a single in-flight refresh promise so parallel
 * spawns (Team, sub-calls) never stampede the token endpoint. On refresh
 * failure the store is left intact and `null` is returned (degrade to the
 * "auth needed" path).
 */
export async function ensureFreshAnthropicToken(): Promise<string | null> {
  ensureLoaded();
  if (!current) return null;
  if (!needsRefresh(current)) return current.accessToken;

  if (!refreshInFlight) {
    const prev = current;
    refreshInFlight = (async () => {
      try {
        return await performRefresh(prev);
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  const result = await refreshInFlight;
  return result?.accessToken ?? null;
}

/** True when a real (non-placeholder) grant is available. Used by `requireAuthFor` on Linux. */
export function hasValidAnthropicGrant(): boolean {
  ensureLoaded();
  return current !== null;
}

/** Persist a freshly captured grant at `/login` and arm the refresh timer. */
export function setAnthropicGrant(grant: AnthropicGrant, org?: string): void {
  writeStoreAtomic(grant, org);
  current = grant;
  organizationUuid = org;
  loaded = true;
  scheduleRefreshTimer();
  log("[AnthropicToken] Grant stored accessToken=%s", suffix(grant.accessToken));
}

/** Clear the grant on `/logout`: delete the store, drop the in-memory token, cancel the timer. */
export function clearAnthropicGrant(): void {
  clearRefreshTimer();
  current = null;
  organizationUuid = undefined;
  loaded = true; // keep loaded so a later read can't resurrect the deleted grant from a racing write
  try {
    fs.unlinkSync(grantPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log("[AnthropicToken] Failed to delete grant store: %O", err);
    }
  }
}

/** Load the grant + arm the timer at activation so refresh survives extension restarts. */
export function initAnthropicTokenManager(): void {
  ensureLoaded();
}

/** Cancel the refresh timer on deactivate. */
export function disposeAnthropicTokenManager(): void {
  clearRefreshTimer();
}

/** Reset all module state — tests only (vitest reuses module state across suites). */
export function __resetAnthropicTokenManagerForTests(testGrantPath?: string): void {
  clearRefreshTimer();
  current = null;
  organizationUuid = undefined;
  loaded = false;
  refreshInFlight = null;
  grantPath = testGrantPath ?? DAMOCLES_ANTHROPIC_GRANT_PATH;
}
