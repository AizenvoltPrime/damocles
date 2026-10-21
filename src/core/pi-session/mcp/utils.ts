/*
 * Portions of this file are lifted from pi-mcp-adapter (MIT).
 * Copyright (c) 2026 Nico Bailon. See THIRD-PARTY-NOTICES.md.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
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
