import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  saveServerCache,
  loadServerCache,
  computeServerHash,
  cachedToolsToMcp,
  cachedResourcesToMcp,
} from '../metadata-cache';
import { MCP_METADATA_CACHE_DIR } from '../paths';
import type { McpServerDefinition, McpTool, McpResource } from '../types';

const SERVER = '__damocles_test_server__';
const cacheFile = join(
  MCP_METADATA_CACHE_DIR,
  `${createHash('sha256').update(SERVER).digest('hex').slice(0, 32)}.json`,
);

const def: McpServerDefinition = { command: 'echo', args: ['hi'] };
const tools: McpTool[] = [
  { name: 'echo', description: 'echo back', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
];
const resources: McpResource[] = [{ uri: 'file://a', name: 'A', description: 'res a' }];

afterEach(() => {
  if (existsSync(cacheFile)) rmSync(cacheFile);
});

describe('metadata cache', () => {
  it('round-trips tools and resources keyed by config hash', () => {
    saveServerCache(SERVER, def, tools, resources);
    const entry = loadServerCache(SERVER, def);
    expect(entry).not.toBeNull();
    expect(entry?.configHash).toBe(computeServerHash(def));

    const restoredTools = cachedToolsToMcp(entry!);
    expect(restoredTools).toHaveLength(1);
    expect(restoredTools[0]?.name).toBe('echo');
    expect(restoredTools[0]?.annotations?.readOnlyHint).toBe(true);

    const restoredResources = cachedResourcesToMcp(entry!);
    expect(restoredResources[0]?.uri).toBe('file://a');
  });

  it('invalidates the cache when the config hash changes', () => {
    saveServerCache(SERVER, def, tools, resources);
    const changed: McpServerDefinition = { command: 'echo', args: ['different'] };
    expect(loadServerCache(SERVER, changed)).toBeNull();
  });

  it('excludes lifecycle/idle from the identity hash', () => {
    const a = computeServerHash({ command: 'x' });
    const b = computeServerHash({ command: 'x', lifecycle: 'keep-alive', idleTimeout: 5 });
    expect(a).toBe(b);
  });
});
