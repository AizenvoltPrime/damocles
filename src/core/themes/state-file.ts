// How the theme store reads its own files (docs/invariants.md "Desktop themes", Storage): each through one handle and within
// the size its writer keeps to, and the two versioned state files, appearance.json and projects.json, by one rule.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { LocalizedError, type LocalizedText } from '../../shared/localized-text';
import { MAX_STATE_FILE_BYTES } from '../../shared/themes/limits';
import { parseStoredJson } from '../../shared/themes/stored-json';
import { l } from '../l10n';
import type { ThemePathRule } from './network-rule';

export { MAX_STATE_FILE_BYTES };

/** A file read refused before its text was read: it is not a regular file, or it is past the size its writer keeps to. */
export class UnreadableFile extends LocalizedError {
  readonly reason: 'notFile' | 'tooLarge';

  constructor(reason: 'notFile' | 'tooLarge', text: LocalizedText) {
    super(text);
    this.name = 'UnreadableFile';
    this.reason = reason;
  }
}

/** The text of the regular file `file` of at most `cap` bytes, sized and read through one handle. */
export async function readCapped(file: string, cap: number): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new UnreadableFile('notFile', l('{0} is not a file.', path.basename(file)));
    if (stat.size > cap) throw new UnreadableFile('tooLarge', l('{0} is larger than {1} MB.', path.basename(file), String(cap / 1024 / 1024)));
    const buffer = Buffer.allocUnsafe(stat.size);
    let at = 0;
    while (at < buffer.length) {
      const { bytesRead } = await handle.read(buffer, at, buffer.length - at, at);
      if (bytesRead === 0) break;
      at += bytesRead;
    }
    return buffer.toString('utf8', 0, at);
  } finally {
    await handle.close();
  }
}

/** `file`'s text within `cap`; null when there is no file. */
export async function readCappedOrNull(file: string, cap: number): Promise<string | null> {
  try {
    return await readCapped(file, cap);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * A versioned state file's text: `ok` with its object when it states `version`, `other` when it states another version
 * number, which a newer Damocles owns, and `bad` when it is no JSON object stating a version, which nothing owns.
 */
export function readVersioned(text: string, version: number): { readonly kind: 'ok'; readonly json: Record<string, unknown> } | { readonly kind: 'other' | 'bad' } {
  let json: unknown;
  try {
    json = parseStoredJson(text);
  } catch {
    return { kind: 'bad' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { kind: 'bad' };
  const record = json as Record<string, unknown>;
  if (typeof record['version'] !== 'number') return { kind: 'bad' };
  return record['version'] === version ? { kind: 'ok', json: record } : { kind: 'other' };
}

/**
 * The object of the versioned state file `file` for a writer to change; undefined for a file to start again: a missing one,
 * and one that is `bad`, which is copied to `<file>.bad` first. A file of another version is refused and left as it is.
 */
export async function editableState(file: string, version: number, rule: ThemePathRule, log?: (line: string) => void): Promise<Record<string, unknown> | undefined> {
  await rule.writable(file);
  const text = await readCappedOrNull(file, MAX_STATE_FILE_BYTES);
  if (text === null) return undefined;
  const parsed = readVersioned(text, version);
  if (parsed.kind === 'ok') return parsed.json;
  if (parsed.kind === 'other') {
    throw new LocalizedError(l('{0} was written by a newer Damocles, so this one leaves it as it is. Update Damocles to change it.', path.basename(file)));
  }
  const bad = `${file}.bad`;
  await rule.writable(bad);
  await fs.copyFile(file, bad);
  log?.(`[themes] ${file} is not a JSON object stating its version, so it was copied to ${bad} and starts again`);
  return undefined;
}
