/*
 * Portions of this file are lifted from pi-mcp-adapter (MIT).
 * Copyright (c) 2026 Nico Bailon. See THIRD-PARTY-NOTICES.md.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { stripBidiControls, stripControlChars } from '../untrusted-text';

const MAX_SERVER_TEXT_CHARS = 300;

/**
 * Server-supplied text as one capped line for a human or the log: control and bidi characters removed
 * and whitespace collapsed, so it cannot forge a line or reorder the text around it.
 */
export function flattenServerText(text: string, maxChars: number = MAX_SERVER_TEXT_CHARS): string {
  const chars = Array.from(stripBidiControls(stripControlChars(text)).replace(/\s+/g, ' ').trim());
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : chars.join('');
}

/** Interpolate `${VAR}` and `$env:VAR` references against the current environment (read-only). */
export function interpolateEnvVars(value: string): string {
  return value
    .replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? '')
    .replace(/\$env:(\w+)/g, (_, name: string) => process.env[name] ?? '');
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

/**
 * Kill a process and its descendant tree. A direct `child.kill()` signals
 * only the root process, orphaning any workers it spawned; on Windows `taskkill /T` walks the tree
 * from the root pid (`/F` is a hard terminate). POSIX tree-killing needs a detached process group we
 * do not spawn, so there we SIGKILL the root only. Resolves once the kill has been dispatched.
 *
 * The Windows fallback is root-only: when taskkill cannot run or reports a failure, the SIGKILL below
 * reaches the server process and orphans whatever it spawned. That is the best a pid alone allows.
 */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (process.platform === 'win32') {
      try {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        // taskkill reports a missing executable on `error` and a refusal (access denied, no such pid)
        // on a non-zero `exit`, so both have to fall back, and one flag keeps them from doing it twice.
        let fellBack = false;
        const killRoot = () => {
          if (fellBack) return;
          fellBack = true;
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Process already exited.
          }
        };
        killer.once('error', () => {
          killRoot();
          resolve();
        });
        // `code === null` means taskkill was itself signalled, so it never reported on the target.
        killer.once('exit', (code) => {
          if (code !== 0) killRoot();
        });
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
