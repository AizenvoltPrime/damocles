/*
 * Adapted from pi-mcp-adapter (MIT). Copyright (c) 2026 Nico Bailon. See THIRD-PARTY-NOTICES.md.
 * OAuth credential storage for MCP servers, backed by VS Code SecretStorage (the OS keychain) so
 * long-lived bearer tokens and client secrets never sit in plaintext on disk (M1). The store is
 * injected via `setMcpSecretStorage`; before injection (and in unit tests) an in-process map stands
 * in. Legacy on-disk entries (`<MCP_OAUTH_DIR>/sha256-<hash>/tokens.json`) are migrated into the
 * keychain on first read and then deleted. Read-modify-write per server is serialized.
 */
import type { SecretStorage } from "vscode";
import { createHash } from "crypto";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { MCP_OAUTH_DIR } from "./paths";
import { log } from "../../logger";

/** OAuth token storage format. */
export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  /** Unix timestamp in seconds. */
  expiresAt?: number;
  scope?: string;
}

/** OAuth client information from dynamic or static registration. */
export interface StoredClientInfo {
  clientId: string;
  clientSecret?: string;
  clientIdIssuedAt?: number;
  clientSecretExpiresAt?: number;
  redirectUris?: string[];
}

/** Complete auth entry for a server. */
export interface AuthEntry {
  tokens?: StoredTokens;
  clientInfo?: StoredClientInfo;
  codeVerifier?: string;
  oauthState?: string;
  /** Track the URL these credentials are for. */
  serverUrl?: string;
}

const KEY_PREFIX = "damocles.mcp.oauth.";

let secretStore: SecretStorage | undefined;
const memoryStore = new Map<string, string>();
let warnedNoKeychain = false;

/** Inject the VS Code SecretStorage (OS keychain) backing the credential store (called at activation). */
export function setMcpSecretStorage(storage: SecretStorage): void {
  secretStore = storage;
}

/** The SecretStorage key for a server (name hashed to a stable, opaque key). */
function storageKey(serverName: string): string {
  if (typeof serverName !== "string") {
    throw new Error(`Invalid MCP server name: ${JSON.stringify(serverName)}`);
  }
  const hash = createHash("sha256").update(serverName, "utf8").digest("hex");
  return `${KEY_PREFIX}sha256-${hash}`;
}

async function readRaw(key: string): Promise<string | undefined> {
  if (secretStore) return secretStore.get(key);
  if (!warnedNoKeychain) {
    warnedNoKeychain = true;
    log("[McpAuth] SecretStorage not configured; using in-process credential store");
  }
  return memoryStore.get(key);
}

async function writeRaw(key: string, value: string): Promise<void> {
  if (secretStore) {
    await secretStore.store(key, value);
    return;
  }
  memoryStore.set(key, value);
}

async function deleteRaw(key: string): Promise<void> {
  if (secretStore) {
    await secretStore.delete(key);
    return;
  }
  memoryStore.delete(key);
}

const keyChains = new Map<string, Promise<unknown>>();

/** Serialize a read-modify-write sequence for one server so concurrent updates can't clobber each other. */
function withKeyLock<T>(serverName: string, task: () => Promise<T>): Promise<T> {
  const key = storageKey(serverName);
  const prev = keyChains.get(key) ?? Promise.resolve();
  const run = prev.then(task, task);
  keyChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** Base directory for legacy on-disk OAuth storage (read-only migration source). */
function legacyBaseDir(): string {
  const override = process.env["MCP_OAUTH_DIR"]?.trim();
  return override ? override : MCP_OAUTH_DIR;
}

function legacyServerDir(serverName: string): string {
  const hash = createHash("sha256").update(serverName, "utf8").digest("hex");
  return join(legacyBaseDir(), `sha256-${hash}`);
}

/**
 * Import a pre-SecretStorage on-disk entry into the keychain (once), then delete the plaintext dir.
 * Returns the migrated entry, or undefined when there is nothing to migrate.
 */
async function migrateLegacyEntry(serverName: string, key: string): Promise<AuthEntry | undefined> {
  const dir = legacyServerDir(serverName);
  const filePath = join(dir, "tokens.json");
  if (!existsSync(filePath)) return undefined;
  let entry: AuthEntry | undefined;
  try {
    entry = JSON.parse(readFileSync(filePath, "utf-8")) as AuthEntry;
  } catch (error) {
    log("[McpAuth] Failed to parse legacy auth entry for %s: %O", serverName, error);
    entry = undefined;
  }
  if (entry && Object.keys(entry).length > 0) {
    await writeRaw(key, JSON.stringify(entry));
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    log("[McpAuth] Failed to remove legacy auth dir for %s: %O", serverName, error);
  }
  return entry && Object.keys(entry).length > 0 ? entry : undefined;
}

async function readEntry(serverName: string): Promise<AuthEntry | undefined> {
  const key = storageKey(serverName);
  const raw = await readRaw(key);
  if (raw !== undefined) {
    try {
      return JSON.parse(raw) as AuthEntry;
    } catch (error) {
      // A corrupt blob is unrecoverable and indistinguishable from "never authenticated". Clear it so it
      // can't wedge every future read, and surface it as a warning — the server then re-authenticates.
      log("[McpAuth] Corrupt auth entry for %s; clearing it to force re-authentication: %O", serverName, error);
      await deleteRaw(key);
      return undefined;
    }
  }
  return migrateLegacyEntry(serverName, key);
}

async function writeEntry(serverName: string, entry: AuthEntry): Promise<void> {
  await writeRaw(storageKey(serverName), JSON.stringify(entry));
}

/** Get the raw auth entry for a server (no URL validation). */
export function getAuthEntry(serverName: string): Promise<AuthEntry | undefined> {
  return readEntry(serverName);
}

/**
 * Get the auth entry only if it is bound to the given server URL. Resolves to undefined when no
 * URL is stored (legacy) or the URL has changed (credentials no longer valid for this server).
 */
export async function getAuthForUrl(serverName: string, serverUrl: string): Promise<AuthEntry | undefined> {
  const entry = await readEntry(serverName);
  if (!entry) return undefined;
  if (!entry.serverUrl) return undefined;
  if (entry.serverUrl !== serverUrl) return undefined;
  return entry;
}

/** Persist an auth entry, stamping it with `serverUrl` when provided. */
export function saveAuthEntry(serverName: string, entry: AuthEntry, serverUrl?: string): Promise<void> {
  return withKeyLock(serverName, async () => {
    if (serverUrl) entry.serverUrl = serverUrl;
    await writeEntry(serverName, entry);
  });
}

/** Remove all credentials for a server (keychain entry + any residual legacy dir). */
export function removeAuthEntry(serverName: string): Promise<void> {
  return withKeyLock(serverName, async () => {
    await deleteRaw(storageKey(serverName));
    const dir = legacyServerDir(serverName);
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        log("[McpAuth] Failed to remove legacy auth dir for %s: %O", serverName, error);
      }
    }
  });
}

/** Update tokens for a server, clearing stale URL-bound state when the URL changes. */
export function updateTokens(serverName: string, tokens: StoredTokens, serverUrl?: string): Promise<void> {
  return withKeyLock(serverName, async () => {
    const entry = (await readEntry(serverName)) ?? {};
    if (serverUrl && entry.serverUrl !== serverUrl) {
      delete entry.clientInfo;
      delete entry.codeVerifier;
      delete entry.oauthState;
    }
    entry.tokens = tokens;
    if (serverUrl) entry.serverUrl = serverUrl;
    await writeEntry(serverName, entry);
  });
}

/** Update dynamic client info, clearing stale URL-bound state when the URL changes. */
export function updateClientInfo(serverName: string, clientInfo: StoredClientInfo, serverUrl?: string): Promise<void> {
  return withKeyLock(serverName, async () => {
    const entry = (await readEntry(serverName)) ?? {};
    if (serverUrl && entry.serverUrl !== serverUrl) {
      delete entry.tokens;
      delete entry.codeVerifier;
      delete entry.oauthState;
    }
    entry.clientInfo = clientInfo;
    if (serverUrl) entry.serverUrl = serverUrl;
    await writeEntry(serverName, entry);
  });
}

/** Update the PKCE code verifier, clearing stale URL-bound state when the URL changes. */
export function updateCodeVerifier(serverName: string, codeVerifier: string, serverUrl?: string): Promise<void> {
  return withKeyLock(serverName, async () => {
    const entry = (await readEntry(serverName)) ?? {};
    if (serverUrl && entry.serverUrl !== serverUrl) {
      delete entry.tokens;
      delete entry.clientInfo;
      delete entry.oauthState;
    }
    entry.codeVerifier = codeVerifier;
    if (serverUrl) entry.serverUrl = serverUrl;
    await writeEntry(serverName, entry);
  });
}

/** Clear the PKCE code verifier for a server. */
export function clearCodeVerifier(serverName: string): Promise<void> {
  return withKeyLock(serverName, async () => {
    const entry = await readEntry(serverName);
    if (!entry) return;
    delete entry.codeVerifier;
    await writeEntry(serverName, entry);
  });
}

/** Update the CSRF state, clearing stale URL-bound state when the URL changes. */
export function updateOAuthState(serverName: string, state: string, serverUrl?: string): Promise<void> {
  return withKeyLock(serverName, async () => {
    const entry = (await readEntry(serverName)) ?? {};
    if (serverUrl && entry.serverUrl !== serverUrl) {
      delete entry.tokens;
      delete entry.clientInfo;
      delete entry.codeVerifier;
    }
    entry.oauthState = state;
    if (serverUrl) entry.serverUrl = serverUrl;
    await writeEntry(serverName, entry);
  });
}

/** Get the stored CSRF state for a server. */
export async function getOAuthState(serverName: string): Promise<string | undefined> {
  const entry = await readEntry(serverName);
  return entry?.oauthState;
}

/** Clear the stored CSRF state for a server. */
export function clearOAuthState(serverName: string): Promise<void> {
  return withKeyLock(serverName, async () => {
    const entry = await readEntry(serverName);
    if (!entry) return;
    delete entry.oauthState;
    await writeEntry(serverName, entry);
  });
}

/** Treat a token as expired this many seconds early so one expiring mid-request doesn't yield a 401 (L6). */
const TOKEN_EXPIRY_SKEW_SECONDS = 30;

/**
 * Whether stored tokens are expired. null when no tokens exist, false when no expiry or not
 * expired, true when expired (within a small clock-skew margin).
 */
export async function isTokenExpired(serverName: string): Promise<boolean | null> {
  const entry = await readEntry(serverName);
  if (!entry?.tokens) return null;
  if (!entry.tokens.expiresAt) return false;
  return entry.tokens.expiresAt < Date.now() / 1000 + TOKEN_EXPIRY_SKEW_SECONDS;
}

/** Whether a server has any stored tokens. */
export async function hasStoredTokens(serverName: string): Promise<boolean> {
  const entry = await readEntry(serverName);
  return !!entry?.tokens;
}

/** Clear all credentials for a server. */
export function clearAllCredentials(serverName: string): Promise<void> {
  return removeAuthEntry(serverName);
}

/** Clear only the dynamic client info for a server. */
export function clearClientInfo(serverName: string): Promise<void> {
  return withKeyLock(serverName, async () => {
    const entry = await readEntry(serverName);
    if (!entry) return;
    delete entry.clientInfo;
    await writeEntry(serverName, entry);
  });
}

/** Clear only the tokens for a server. */
export function clearTokens(serverName: string): Promise<void> {
  return withKeyLock(serverName, async () => {
    const entry = await readEntry(serverName);
    if (!entry) return;
    delete entry.tokens;
    await writeEntry(serverName, entry);
  });
}
