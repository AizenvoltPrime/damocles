/*
 * Adapted from pi-mcp-adapter (MIT). Copyright (c) 2026 Nico Bailon.
 * See THIRD-PARTY-NOTICES.md. Persistent on-disk cache of each server's tools and whether it offers
 * resources, keyed by a config hash so warm tool definitions survive the brief pre-connect window and
 * an offline server. Live `tools/list` remains the source of truth. One file per server name, so a user
 * and a folder server of the same name share it.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { McpTool, McpServerDefinition } from './types';
import { MCP_METADATA_CACHE_DIR } from './paths';

// Shared with older Damocles builds through ~/.damocles/mcp/metadata-cache, so fields are additive and this never changes.
const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: McpTool['annotations'];
}

export interface CachedResource {
  uri: string;
  name: string;
  description?: string;
}

export interface ServerCacheEntry {
  version: number;
  configHash: string;
  tools: CachedTool[];
  /**
   * The resource list an older build wrote. Carried forward unchanged while the config hash holds, never
   * written anew: older builds still make their `get_*` tools from it.
   */
  resources: CachedResource[];
  /**
   * The last non-empty `resources` list, kept when a config change or sign-out empties `resources`: the only
   * record of the retired `get_*` names for rule migration. Older builds ignore it.
   */
  retiredResources?: CachedResource[];
  /** Absent in entries an older build wrote. */
  hasResources?: boolean;
  cachedAt: number;
}

/** Whether the cached server offers resources; an older build's entry answers through its resource list. */
export function cachedHasResources(entry: ServerCacheEntry): boolean {
  return entry.hasResources ?? (Array.isArray(entry.resources) && entry.resources.length > 0);
}

/** The newest resource list an older build wrote into the entry, as stored. */
function retiredResourceList(entry: ServerCacheEntry): unknown[] {
  if (Array.isArray(entry.resources) && entry.resources.length > 0) return entry.resources;
  return Array.isArray(entry.retiredResources) ? entry.retiredResources : [];
}

function cacheFilePath(serverName: string): string {
  const hash = createHash('sha256').update(serverName).digest('hex').slice(0, 32);
  return join(MCP_METADATA_CACHE_DIR, `${hash}.json`);
}

/**
 * Hash only the fields that determine which tools/resources a server exposes, as written in the config.
 * Values are never resolved here: that would run `!command` values outside a connect and write a hash
 * of resolved secrets to disk.
 */
export function computeServerHash(definition: McpServerDefinition): string {
  const identity: Record<string, unknown> = {
    command: definition.command,
    args: definition.args,
    env: definition.env,
    cwd: definition.cwd,
    url: definition.url,
    headers: definition.headers,
    auth: definition.auth,
    bearerToken: definition.bearerToken,
    bearerTokenEnv: definition.bearerTokenEnv,
    exposeResources: definition.exposeResources,
  };
  return createHash('sha256').update(stableStringify(identity)).digest('hex');
}

/** The server's entry on disk whatever config wrote it and however old, or null when absent, unreadable or of another version. */
export function readServerCacheEntry(serverName: string): ServerCacheEntry | null {
  const file = cacheFilePath(serverName);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as ServerCacheEntry;
    if (!raw || typeof raw !== 'object' || raw.version !== CACHE_VERSION || typeof raw.cachedAt !== 'number') return null;
    return raw;
  } catch {
    return null;
  }
}

/** `entry` when `definition` wrote it within `maxAgeMs` (0 for any age), else null. */
export function usableServerCache(
  entry: ServerCacheEntry | null,
  definition: McpServerDefinition,
  maxAgeMs: number = CACHE_MAX_AGE_MS,
): ServerCacheEntry | null {
  if (!entry || entry.configHash !== computeServerHash(definition)) return null;
  if (maxAgeMs > 0 && Date.now() - entry.cachedAt > maxAgeMs) return null;
  return entry;
}

export function loadServerCache(
  serverName: string,
  definition: McpServerDefinition,
  maxAgeMs: number = CACHE_MAX_AGE_MS,
): ServerCacheEntry | null {
  return usableServerCache(readServerCacheEntry(serverName), definition, maxAgeMs);
}

function writeEntry(serverName: string, entry: ServerCacheEntry): void {
  mkdirSync(MCP_METADATA_CACHE_DIR, { recursive: true });
  const file = cacheFilePath(serverName);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry), 'utf-8');
  renameSync(tmp, file);
}

/**
 * Write the server's tools and capability. `previous` is the entry on disk (`readServerCacheEntry`): its
 * `resources` are carried while the config hash holds, and its retired list across any change. Returns the entry written.
 */
export function saveServerCache(
  serverName: string,
  definition: McpServerDefinition,
  tools: McpTool[],
  hasResources: boolean,
  previous: ServerCacheEntry | null,
): ServerCacheEntry {
  const configHash = computeServerHash(definition);
  const resources = previous?.configHash === configHash && Array.isArray(previous.resources) ? previous.resources : [];
  const retired = previous ? retiredResourceList(previous) : [];
  const entry: ServerCacheEntry = {
    version: CACHE_VERSION,
    configHash,
    tools: serializeTools(tools),
    resources,
    ...(resources.length === 0 && retired.length > 0 ? { retiredResources: retired as CachedResource[] } : {}),
    hasResources,
    cachedAt: Date.now(),
  };
  writeEntry(serverName, entry);
  return entry;
}

/**
 * Drop a server's cached tools (used when its credentials are cleared). A retired resource list stays, in
 * an entry no config hash matches, so no build reads tools from it. Returns what is left on disk.
 */
export function clearServerCache(serverName: string, previous: ServerCacheEntry | null): ServerCacheEntry | null {
  const retired = previous ? retiredResourceList(previous) : [];
  try {
    if (retired.length === 0) {
      rmSync(cacheFilePath(serverName), { force: true });
      return null;
    }
    const entry: ServerCacheEntry = { version: CACHE_VERSION, configHash: '', tools: [], resources: [], retiredResources: retired as CachedResource[], cachedAt: 0 };
    writeEntry(serverName, entry);
    return entry;
  } catch {
    // Best-effort: a missing/locked cache file must not break sign-out.
    return previous;
  }
}

export function serializeTools(tools: McpTool[]): CachedTool[] {
  return tools
    .filter((t) => t?.name)
    .map((t) => {
      const ct: CachedTool = { name: t.name };
      if (t.description !== undefined) ct.description = t.description;
      if (t.inputSchema !== undefined) ct.inputSchema = t.inputSchema;
      if (t.annotations !== undefined) ct.annotations = t.annotations;
      return ct;
    });
}

export function cachedToolsToMcp(entry: ServerCacheEntry): McpTool[] {
  return (entry.tools ?? [])
    .filter((t) => t?.name)
    .map((t) => {
      const tool: McpTool = { name: t.name };
      if (t.description !== undefined) tool.description = t.description;
      if (t.inputSchema !== undefined) tool.inputSchema = t.inputSchema;
      if (t.annotations !== undefined) tool.annotations = t.annotations;
      return tool;
    });
}

/** The retired resource list's well-formed entries: a string name and URI each. */
export function cachedRetiredResources(entry: ServerCacheEntry): CachedResource[] {
  return retiredResourceList(entry).flatMap((r: unknown): CachedResource[] => {
    if (typeof r !== 'object' || r === null) return [];
    const { uri, name } = r as Record<string, unknown>;
    return typeof uri === 'string' && uri !== '' && typeof name === 'string' && name !== '' ? [{ uri, name }] : [];
  });
}

export function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 'undefined' : serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
