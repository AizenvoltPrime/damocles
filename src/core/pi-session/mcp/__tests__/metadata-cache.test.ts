import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  saveServerCache,
  loadServerCache,
  readServerCacheEntry,
  clearServerCache,
  computeServerHash,
  cachedToolsToMcp,
  cachedHasResources,
  cachedRetiredResources,
  type ServerCacheEntry,
} from '../metadata-cache';
import { MCP_METADATA_CACHE_DIR } from '../paths';
import type { McpServerDefinition, McpTool } from '../types';

const SERVER = '__damocles_test_server__';
const cacheFile = join(
  MCP_METADATA_CACHE_DIR,
  `${createHash('sha256').update(SERVER).digest('hex').slice(0, 32)}.json`,
);

const def: McpServerDefinition = { command: 'echo', args: ['hi'] };
const tools: McpTool[] = [
  { name: 'echo', description: 'echo back', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
];

/** An entry as an older build writes it: version 1, a resource list, no `hasResources`. */
function writeOlderEntry(resources: unknown): void {
  mkdirSync(MCP_METADATA_CACHE_DIR, { recursive: true });
  const entry = { version: 1, configHash: computeServerHash(def), tools: [{ name: 'echo' }], resources, cachedAt: Date.now() };
  writeFileSync(cacheFile, JSON.stringify(entry), 'utf-8');
}

const rawEntry = (): ServerCacheEntry => JSON.parse(readFileSync(cacheFile, 'utf-8')) as ServerCacheEntry;

afterEach(() => {
  if (existsSync(cacheFile)) rmSync(cacheFile);
});

describe('metadata cache', () => {
  it('round-trips tools and the resources flag keyed by config hash, at version 1', () => {
    saveServerCache(SERVER, def, tools, true, readServerCacheEntry(SERVER));
    const entry = loadServerCache(SERVER, def);
    expect(entry).not.toBeNull();
    expect(entry?.configHash).toBe(computeServerHash(def));
    expect(entry?.version).toBe(1);

    const restoredTools = cachedToolsToMcp(entry!);
    expect(restoredTools).toHaveLength(1);
    expect(restoredTools[0]?.name).toBe('echo');
    expect(restoredTools[0]?.annotations?.readOnlyHint).toBe(true);
    expect(cachedHasResources(entry!)).toBe(true);
    expect(entry?.resources).toEqual([]);
  });

  it('reads an older build\u2019s entry: resources offered when its list is not empty', () => {
    writeOlderEntry([{ uri: 'file://a', name: 'A', description: 'res a' }]);
    expect(cachedHasResources(loadServerCache(SERVER, def)!)).toBe(true);
    writeOlderEntry([]);
    expect(cachedHasResources(loadServerCache(SERVER, def)!)).toBe(false);
  });

  it('carries an older build\u2019s resource list forward unchanged and never writes a new one', () => {
    const older = [{ uri: 'file://a', name: 'A', description: 'res a' }, { uri: 'x://b', name: 'B' }];
    writeOlderEntry(older);

    saveServerCache(SERVER, def, tools, false, readServerCacheEntry(SERVER));

    expect(rawEntry().resources).toEqual(older);
    expect(rawEntry().hasResources).toBe(false);
    expect(cachedRetiredResources(rawEntry())).toEqual([{ uri: 'file://a', name: 'A' }, { uri: 'x://b', name: 'B' }]);
  });

  it('keeps only well-formed carried entries when reading them for migration', () => {
    writeOlderEntry([{ uri: 'x://ok', name: 'ok' }, { uri: 7, name: 'bad' }, null, { uri: '', name: 'empty' }]);
    expect(cachedRetiredResources(loadServerCache(SERVER, def)!)).toEqual([{ uri: 'x://ok', name: 'ok' }]);
  });

  it('keeps an older build\u2019s resource list as the retired list across a config change, where older builds no longer read it', () => {
    const older = [{ uri: 'file://a', name: 'A' }];
    writeOlderEntry(older);
    const changed: McpServerDefinition = { command: 'echo', args: ['different'] };

    saveServerCache(SERVER, changed, tools, true, readServerCacheEntry(SERVER));
    saveServerCache(SERVER, def, tools, true, readServerCacheEntry(SERVER));

    expect(rawEntry().resources).toEqual([]);
    expect(rawEntry().retiredResources).toEqual(older);
    expect(cachedRetiredResources(readServerCacheEntry(SERVER)!)).toEqual(older);
  });

  it('prefers a resource list an older build wrote after the retired one was kept', () => {
    writeOlderEntry([{ uri: 'file://old', name: 'old' }]);
    saveServerCache(SERVER, { command: 'other' }, tools, true, readServerCacheEntry(SERVER));
    writeOlderEntry([{ uri: 'file://new', name: 'new' }]);

    expect(cachedRetiredResources(readServerCacheEntry(SERVER)!)).toEqual([{ uri: 'file://new', name: 'new' }]);
  });

  it('keeps the retired list through a sign-out, in an entry no config loads tools from', () => {
    writeOlderEntry([{ uri: 'file://a', name: 'A' }]);

    clearServerCache(SERVER, readServerCacheEntry(SERVER));

    expect(loadServerCache(SERVER, def, 0)).toBeNull();
    expect(cachedRetiredResources(readServerCacheEntry(SERVER)!)).toEqual([{ uri: 'file://a', name: 'A' }]);
    saveServerCache(SERVER, def, tools, false, null);
    clearServerCache(SERVER, readServerCacheEntry(SERVER));
    expect(existsSync(cacheFile)).toBe(false);
  });

  it('invalidates the cache when the config hash changes', () => {
    saveServerCache(SERVER, def, tools, false, readServerCacheEntry(SERVER));
    const changed: McpServerDefinition = { command: 'echo', args: ['different'] };
    expect(loadServerCache(SERVER, changed)).toBeNull();
  });

  it('excludes lifecycle/idle from the identity hash', () => {
    const a = computeServerHash({ command: 'x' });
    const b = computeServerHash({ command: 'x', lifecycle: 'keep-alive', idleTimeout: 5 });
    expect(a).toBe(b);
  });
});
