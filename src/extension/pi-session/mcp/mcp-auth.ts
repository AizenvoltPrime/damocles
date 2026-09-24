/*
 * Adapted from pi-mcp-adapter (MIT). Copyright (c) 2026 Nico Bailon. See THIRD-PARTY-NOTICES.md.
 * OAuth credential storage for MCP servers, backed by VS Code SecretStorage (the OS keychain) so
 * long-lived bearer tokens and client secrets never sit in plaintext on disk (M1). The store is
 * injected via `setMcpSecretStorage`; before injection (and in unit tests) an in-process map stands
 * in. Credentials are keyed by server identity (name + URL), because two workspace folders can each
 * define a same-named server at a different URL. Read-modify-write per identity is serialized.
 */
import type { SecretStorage } from "vscode";
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "fs";
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
  /** The URL a name-keyed entry was bound to; only the migration to identity keys reads it. */
  serverUrl?: string;
}

/** The server a credential belongs to. Same-named servers at different URLs never share one. */
export interface McpAuthIdentity {
  serverName: string;
  serverUrl: string;
}

const KEY_PREFIX = "damocles.mcp.oauth.";
/** The key format before credentials were keyed by URL: `sha256-<name hash>`. */
const NAME_KEYED = /^damocles\.mcp\.oauth\.sha256-([0-9a-f]{64})$/;
const LEGACY_DIR_NAME = /^sha256-([0-9a-f]{64})$/;

let secretStore: SecretStorage | undefined;
const memoryStore = new Map<string, string>();
let warnedNoKeychain = false;
let migration: Promise<void> = Promise.resolve();

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The name half equals the name-keyed format's hash, so the migration can re-key an entry from its
 * old key and its stored URL without knowing the server name.
 */
function identityKey(nameHash: string, serverUrl: string): string {
  return `${KEY_PREFIX}sha256-${nameHash}-${sha256(serverUrl)}`;
}

function storageKey(id: McpAuthIdentity): string {
  if (typeof id.serverName !== "string" || typeof id.serverUrl !== "string") {
    throw new Error(`Invalid MCP server identity: ${JSON.stringify(id)}`);
  }
  return identityKey(sha256(id.serverName), id.serverUrl);
}

/**
 * Inject the VS Code SecretStorage (OS keychain) backing the credential store (called at activation),
 * and re-key every name-keyed entry to its identity key before any credential is read.
 */
export function setMcpSecretStorage(storage: SecretStorage): void {
  secretStore = storage;
  migration = migrateNameKeyedEntries(storage).catch((error) => {
    log("[McpAuth] Migrating stored MCP sign-ins failed; servers signed in before this version must authenticate again: %O", error);
  });
}

/** Base directory for the pre-keychain on-disk OAuth storage (read-only migration source). */
function legacyBaseDir(): string {
  const override = process.env["MCP_OAUTH_DIR"]?.trim();
  return override ? override : MCP_OAUTH_DIR;
}

/**
 * One-time move of every name-keyed credential, from the keychain and from the pre-keychain
 * `<MCP_OAUTH_DIR>/sha256-<name hash>/tokens.json` files, to its identity key. An entry never bound to
 * a URL could not be used and is dropped. An identity key already present wins.
 */
async function migrateNameKeyedEntries(store: SecretStorage): Promise<void> {
  const rekey = async (nameHash: string, raw: string): Promise<void> => {
    let entry: AuthEntry;
    try {
      entry = JSON.parse(raw) as AuthEntry;
    } catch (error) {
      log("[McpAuth] Dropping an unparseable stored MCP sign-in: %O", error);
      return;
    }
    if (typeof entry.serverUrl !== "string") return;
    const key = identityKey(nameHash, entry.serverUrl);
    if ((await store.get(key)) === undefined) await store.store(key, raw);
  };

  for (const key of await store.keys()) {
    const match = NAME_KEYED.exec(key);
    if (!match) continue;
    const raw = await store.get(key);
    if (raw !== undefined) await rekey(match[1]!, raw);
    await store.delete(key);
  }

  const base = legacyBaseDir();
  if (!existsSync(base)) return;
  for (const dirName of readdirSync(base)) {
    const match = LEGACY_DIR_NAME.exec(dirName);
    if (!match) continue;
    const dir = join(base, dirName);
    const file = join(dir, "tokens.json");
    if (existsSync(file)) await rekey(match[1]!, readFileSync(file, "utf-8"));
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      log("[McpAuth] Failed to remove legacy auth dir %s: %O", dir, error);
    }
  }
}

async function readRaw(key: string): Promise<string | undefined> {
  await migration;
  if (secretStore) return secretStore.get(key);
  if (!warnedNoKeychain) {
    warnedNoKeychain = true;
    log("[McpAuth] SecretStorage not configured; using in-process credential store");
  }
  return memoryStore.get(key);
}

async function writeRaw(key: string, value: string): Promise<void> {
  await migration;
  if (secretStore) {
    await secretStore.store(key, value);
    return;
  }
  memoryStore.set(key, value);
}

async function deleteRaw(key: string): Promise<void> {
  await migration;
  if (secretStore) {
    await secretStore.delete(key);
    return;
  }
  memoryStore.delete(key);
}

const keyChains = new Map<string, Promise<unknown>>();

/** Serialize a read-modify-write sequence for one identity so concurrent updates can't clobber each other. */
function withKeyLock<T>(id: McpAuthIdentity, task: () => Promise<T>): Promise<T> {
  const key = storageKey(id);
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

async function readEntry(id: McpAuthIdentity): Promise<AuthEntry | undefined> {
  const key = storageKey(id);
  const raw = await readRaw(key);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as AuthEntry;
  } catch (error) {
    // A corrupt blob is unrecoverable and indistinguishable from "never authenticated". Clear it so it
    // can't wedge every future read, and surface it as a warning — the server then re-authenticates.
    log("[McpAuth] Corrupt auth entry for %s; clearing it to force re-authentication: %O", id.serverName, error);
    await deleteRaw(key);
    return undefined;
  }
}

async function writeEntry(id: McpAuthIdentity, entry: AuthEntry): Promise<void> {
  await writeRaw(storageKey(id), JSON.stringify(entry));
}

/** Read-modify-write one identity's entry under its lock, creating it when absent. */
function updateEntry(id: McpAuthIdentity, mutate: (entry: AuthEntry) => void): Promise<void> {
  return withKeyLock(id, async () => {
    const entry = (await readEntry(id)) ?? {};
    mutate(entry);
    await writeEntry(id, entry);
  });
}

/** Clear fields of an existing entry; no entry means nothing to clear and nothing is written. */
function clearFields(id: McpAuthIdentity, fields: readonly (keyof AuthEntry)[]): Promise<void> {
  return withKeyLock(id, async () => {
    const entry = await readEntry(id);
    if (!entry) return;
    for (const field of fields) delete entry[field];
    await writeEntry(id, entry);
  });
}

/** The auth entry stored for a server identity. */
export function getAuthEntry(id: McpAuthIdentity): Promise<AuthEntry | undefined> {
  return readEntry(id);
}

/** Persist a whole auth entry for a server identity. */
export function saveAuthEntry(id: McpAuthIdentity, entry: AuthEntry): Promise<void> {
  return withKeyLock(id, () => writeEntry(id, entry));
}

/** Remove all credentials for a server identity. */
export function removeAuthEntry(id: McpAuthIdentity): Promise<void> {
  return withKeyLock(id, () => deleteRaw(storageKey(id)));
}

export function updateTokens(id: McpAuthIdentity, tokens: StoredTokens): Promise<void> {
  return updateEntry(id, (entry) => { entry.tokens = tokens; });
}

export function updateClientInfo(id: McpAuthIdentity, clientInfo: StoredClientInfo): Promise<void> {
  return updateEntry(id, (entry) => { entry.clientInfo = clientInfo; });
}

export function updateCodeVerifier(id: McpAuthIdentity, codeVerifier: string): Promise<void> {
  return updateEntry(id, (entry) => { entry.codeVerifier = codeVerifier; });
}

export function clearCodeVerifier(id: McpAuthIdentity): Promise<void> {
  return clearFields(id, ["codeVerifier"]);
}

/** Store the CSRF state of the flow in progress. */
export function updateOAuthState(id: McpAuthIdentity, state: string): Promise<void> {
  return updateEntry(id, (entry) => { entry.oauthState = state; });
}

/** The stored CSRF state of the flow in progress, if any. */
export async function getOAuthState(id: McpAuthIdentity): Promise<string | undefined> {
  const entry = await readEntry(id);
  return entry?.oauthState;
}

export function clearOAuthState(id: McpAuthIdentity): Promise<void> {
  return clearFields(id, ["oauthState"]);
}

/** Treat a token as expired this many seconds early so one expiring mid-request doesn't yield a 401 (L6). */
const TOKEN_EXPIRY_SKEW_SECONDS = 30;

/**
 * Whether stored tokens are expired. null when no tokens exist, false when no expiry or not
 * expired, true when expired (within a small clock-skew margin).
 */
export async function isTokenExpired(id: McpAuthIdentity): Promise<boolean | null> {
  const entry = await readEntry(id);
  if (!entry?.tokens) return null;
  if (!entry.tokens.expiresAt) return false;
  return entry.tokens.expiresAt < Date.now() / 1000 + TOKEN_EXPIRY_SKEW_SECONDS;
}

/** Whether a server identity has any stored tokens. */
export async function hasStoredTokens(id: McpAuthIdentity): Promise<boolean> {
  const entry = await readEntry(id);
  return !!entry?.tokens;
}

/** Clear all credentials for a server identity. */
export function clearAllCredentials(id: McpAuthIdentity): Promise<void> {
  return removeAuthEntry(id);
}

/** Clear only the dynamic client info for a server identity. */
export function clearClientInfo(id: McpAuthIdentity): Promise<void> {
  return clearFields(id, ["clientInfo"]);
}

/** Clear only the tokens for a server identity. */
export function clearTokens(id: McpAuthIdentity): Promise<void> {
  return clearFields(id, ["tokens"]);
}
