import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from '../logger';

// pi rewrites auth.json in place (truncate, then one write of the whole JSON object), so a read that lands
// in between is empty or an unterminated prefix and fails to parse. Retrying briefly lets the write land.
const READ_ATTEMPTS = 5;
const RETRY_DELAY_MS = 20;

/** The last content this process parsed, per auth path; it may be older than what is on disk now. */
const lastRead = new Map<string, Record<string, unknown> | undefined>();
/** Text that still failed to parse after every retry, so a file that stays broken costs no further retry sleeps. */
const settledBadText = new Map<string, string>();
/** The failure last logged per reader, so a file that stays broken is logged once, not on every read. */
const loggedFailures = new Map<string, string>();

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

// Synchronous because the settings panel's open path reads auth state synchronously.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseAuth(text: string, authPath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${authPath} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

/**
 * Parse `<agentDir>/auth.json` without taking pi's lock: pi's writers retry only ELOCKED, so a reader's lock
 * can fail pi's own write on Windows. Undefined when there is no file. Text that does not parse is re-read a
 * few times; if it still does not parse, returns the last content this process parsed, or throws when there
 * is none.
 */
export function readAuthFile(agentDir: string): Record<string, unknown> | undefined {
  const authPath = path.resolve(agentDir, 'auth.json');
  for (let attempt = 1; ; attempt++) {
    let text: string;
    try {
      text = fs.readFileSync(authPath, 'utf8');
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err;
      lastRead.set(authPath, undefined);
      settledBadText.delete(authPath);
      loggedFailures.clear();
      return undefined;
    }
    try {
      const parsed = parseAuth(text, authPath);
      lastRead.set(authPath, parsed);
      settledBadText.delete(authPath);
      loggedFailures.clear();
      return parsed;
    } catch (err) {
      const settled = settledBadText.get(authPath) === text;
      if (!settled && attempt < READ_ATTEMPTS) {
        sleepSync(RETRY_DELAY_MS);
        continue;
      }
      settledBadText.set(authPath, text);
      if (lastRead.has(authPath)) return lastRead.get(authPath);
      throw err;
    }
  }
}

/**
 * Logs why auth.json could not be read, by error name and code only: a JSON.parse message quotes the file's
 * text, which holds tokens. Logs again only after a successful read or a different failure.
 */
export function logAuthReadFailure(reader: string, err: unknown, consequence: string): void {
  const code = errorCode(err);
  const summary = `${err instanceof Error ? err.name : typeof err}${code !== undefined ? ` ${code}` : ''}`;
  if (loggedFailures.get(reader) === summary) return;
  loggedFailures.set(reader, summary);
  log(`[${reader}] auth.json unreadable (${summary}); ${consequence}`);
}
