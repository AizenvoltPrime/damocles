/*
 * Adapted from pi-mcp-adapter (MIT). Copyright (c) 2026 Nico Bailon.
 * See THIRD-PARTY-NOTICES.md. Persistent on-disk cache of each server's tools/resources,
 * keyed by a config hash so warm tool definitions survive the brief pre-connect window and
 * an offline server. Live `tools/list` remains the source of truth.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { McpTool, McpResource, McpServerDefinition } from './types';
import { interpolateEnvRecord, resolveBearerToken, resolveConfigPath } from './utils';
import { MCP_METADATA_CACHE_DIR } from './paths';

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
  resources: CachedResource[];
  cachedAt: number;
}

function cacheFilePath(serverName: string): string {
  const hash = createHash('sha256').update(serverName).digest('hex').slice(0, 32);
  return join(MCP_METADATA_CACHE_DIR, `${hash}.json`);
}

/** Hash only the fields that determine which tools/resources a server exposes. */
export function computeServerHash(definition: McpServerDefinition): string {
  const identity: Record<string, unknown> = {
    command: definition.command,
    args: definition.args,
    env: interpolateEnvRecord(definition.env),
    cwd: resolveConfigPath(definition.cwd),
    url: definition.url,
    headers: interpolateEnvRecord(definition.headers),
    auth: definition.auth,
    bearerToken: resolveBearerToken(definition),
    bearerTokenEnv: definition.bearerTokenEnv,
    exposeResources: definition.exposeResources,
  };
  return createHash('sha256').update(stableStringify(identity)).digest('hex');
}

export function loadServerCache(
  serverName: string,
  definition: McpServerDefinition,
  maxAgeMs: number = CACHE_MAX_AGE_MS,
): ServerCacheEntry | null {
  const file = cacheFilePath(serverName);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as ServerCacheEntry;
    if (!raw || raw.version !== CACHE_VERSION) return null;
    if (raw.configHash !== computeServerHash(definition)) return null;
    if (typeof raw.cachedAt !== 'number') return null;
    if (maxAgeMs > 0 && Date.now() - raw.cachedAt > maxAgeMs) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveServerCache(
  serverName: string,
  definition: McpServerDefinition,
  tools: McpTool[],
  resources: McpResource[],
): void {
  mkdirSync(MCP_METADATA_CACHE_DIR, { recursive: true });
  const entry: ServerCacheEntry = {
    version: CACHE_VERSION,
    configHash: computeServerHash(definition),
    tools: serializeTools(tools),
    resources: serializeResources(resources),
    cachedAt: Date.now(),
  };
  const file = cacheFilePath(serverName);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry), 'utf-8');
  renameSync(tmp, file);
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

export function serializeResources(resources: McpResource[]): CachedResource[] {
  return resources
    .filter((r) => r?.name && r?.uri)
    .map((r) => {
      const cr: CachedResource = { uri: r.uri, name: r.name };
      if (r.description !== undefined) cr.description = r.description;
      return cr;
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

export function cachedResourcesToMcp(entry: ServerCacheEntry): McpResource[] {
  return (entry.resources ?? [])
    .filter((r) => r?.name && r?.uri)
    .map((r) => {
      const resource: McpResource = { uri: r.uri, name: r.name };
      if (r.description !== undefined) resource.description = r.description;
      return resource;
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
