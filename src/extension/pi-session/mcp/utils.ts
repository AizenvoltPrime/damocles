/*
 * Portions of this file are lifted from pi-mcp-adapter (MIT).
 * Copyright (c) 2026 Nico Bailon. See THIRD-PARTY-NOTICES.md.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { McpServerDefinition } from './types';

/** Interpolate `${VAR}` and `$env:VAR` references against the current environment (read-only). */
export function interpolateEnvVars(value: string): string {
  return value
    .replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? '')
    .replace(/\$env:(\w+)/g, (_, name: string) => process.env[name] ?? '');
}

/** Interpolate every value in a record; returns undefined for an undefined input. */
export function interpolateEnvRecord(
  values: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!values) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    resolved[key] = interpolateEnvVars(value);
  }
  return resolved;
}

/** Resolve a config path: interpolate env vars, then expand a leading `~`. */
export function resolveConfigPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const resolved = interpolateEnvVars(value);
  if (resolved === '~') return homedir();
  if (resolved.startsWith('~/') || resolved.startsWith('~\\')) {
    return join(homedir(), resolved.slice(2));
  }
  return resolved;
}

/** Resolve a static bearer token from an inline value (interpolated) or an env-var name. */
export function resolveBearerToken(
  definition: Pick<McpServerDefinition, 'bearerToken' | 'bearerTokenEnv'>,
): string | undefined {
  if (definition.bearerToken !== undefined) {
    return interpolateEnvVars(definition.bearerToken);
  }
  return definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined;
}

/**
 * Kill a process and its descendant tree. A direct `child.kill()` / SDK `transport.close()` signals
 * only the root process, orphaning any workers it spawned; on Windows `taskkill /T` walks the tree
 * from the root pid (`/F` is a hard terminate). POSIX tree-killing needs a detached process group we
 * do not spawn, so there we SIGKILL the root only. Resolves once the kill has been dispatched.
 */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (process.platform === 'win32') {
      try {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.once('error', () => resolve());
        killer.once('close', () => resolve());
      } catch {
        resolve();
      }
      return;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process already exited.
    }
    resolve();
  });
}

/** Run `fn` over `items` with at most `limit` concurrent executions, preserving order. */
export async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i] as T);
    }
  }
  const workers = Array(Math.min(Math.max(1, limit), items.length))
    .fill(null)
    .map(() => worker());
  await Promise.all(workers);
  return results;
}
