// A terminal host's own list of its terminals, <runDir>/terminal-hosts/<pid>.terminals, which the host rewrites at its start
// and at each terminal's spawn, start and exit, so a daemon that never attached to it still lists them and proves each process
// before a kill (docs/invariants.md "Remote terminals outlive their clients and their daemon"). Every later daemon reads it as
// part of the terminal host contract (token.ts), so its fields only grow and a reader ignores the ones it does not know.
import { promises as fs } from 'node:fs';
import { renameWithRetry } from '../../core/config/rename-retry';
import { hostTerminalsFile, hostTerminalsTemp, type RunPaths } from '../daemon/token';
import { nonEmpty, INVALID } from '../core-protocol/schema';
import { DAEMON_TO_TERMINAL_HOST, MAX_HOSTED_TERMINALS, type HostedTerminal } from './host-messages';

// MAX_HOSTED_TERMINALS entries of 128 KiB each; the frozen bounds allow more, which only a view or a key no client sends reaches
export const MAX_TERMINALS_FILE_BYTES: number = 32 * 1024 * 1024;
const MAX_START_CHARS = 256;

export interface PersistedTerminal extends HostedTerminal {
  // process-identity.ts startIdentity of the shell; absent while its pid is 0 or when it could not be read
  readonly start?: string;
}

export interface HostTerminals {
  // startIdentity of the host itself; absent when it could not be read
  readonly hostStart?: string;
  readonly terminals: readonly PersistedTerminal[];
}

const start = nonEmpty(MAX_START_CHARS);
// a list answer's terminal, by the frozen parser, so the file holds exactly what attach would answer
const hostedTerminal = (raw: unknown): HostedTerminal | undefined => {
  const listed = DAEMON_TO_TERMINAL_HOST.requests.list.result({ terminals: [raw] });
  return listed === INVALID ? undefined : listed.terminals[0];
};

// the content, or why the whole file is refused; dropped counts the entries left out
function parse(text: string): { readonly content: HostTerminals; readonly dropped: number } | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return `it does not parse: ${err.message}`;
    throw err;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'it holds no object';
  const { hostStart, terminals } = raw as Record<string, unknown>;
  if (!Array.isArray(terminals) || terminals.length > MAX_HOSTED_TERMINALS) return `it holds no list of at most ${MAX_HOSTED_TERMINALS} terminals`;
  if (hostStart !== undefined && start(hostStart) === INVALID) return 'its host identity is malformed';
  const kept: PersistedTerminal[] = [];
  for (const entry of terminals as unknown[]) {
    const terminal = hostedTerminal(entry);
    const shellStart = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>)['start'] : undefined;
    if (!terminal || (shellStart !== undefined && start(shellStart) === INVALID) || kept.some((other) => other.id === terminal.id)) continue;
    kept.push(shellStart === undefined ? terminal : { ...terminal, start: shellStart as string });
  }
  return { content: { ...(hostStart !== undefined ? { hostStart: hostStart as string } : {}), terminals: kept }, dropped: terminals.length - kept.length };
}

/** The file's content, or undefined when it is refused whole. */
export function parseHostTerminals(text: string): HostTerminals | undefined {
  const parsed = parse(text);
  return typeof parsed === 'string' ? undefined : parsed.content;
}

/** The host's terminals file; undefined, with a log line naming why, when there is none or it is refused. Never throws. */
export async function readHostTerminals(paths: RunPaths, pid: number, log: (line: string) => void): Promise<HostTerminals | undefined> {
  const refused = (reason: string): undefined => {
    log(`[terminal] the terminals file of the terminal host ${pid} is refused: ${reason}`);
    return undefined;
  };
  let text: string;
  try {
    const handle = await fs.open(hostTerminalsFile(paths, pid), 'r');
    try {
      const { size } = await handle.stat();
      if (size > MAX_TERMINALS_FILE_BYTES) return refused(`it holds ${size} bytes, more than ${MAX_TERMINALS_FILE_BYTES}`);
      text = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return refused(`it cannot be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = parse(text);
  if (typeof parsed === 'string') return refused(parsed);
  if (parsed.dropped > 0) log(`[terminal] the terminals file of the terminal host ${pid} names ${parsed.dropped} terminals outside its contract; they are left out`);
  return parsed.content;
}

/**
 * Replaces the file whole: a temporary file of the user's alone beside it, then a rename, so a reader sees one or the other.
 * A list past maxBytes throws a RangeError, which no later try of that list fixes.
 */
export async function writeHostTerminals(file: string, content: HostTerminals, maxBytes: number = MAX_TERMINALS_FILE_BYTES): Promise<void> {
  const text = `${JSON.stringify(content)}\n`;
  const bytes = Buffer.byteLength(text);
  if (bytes > maxBytes) throw new RangeError(`the terminals file would hold ${bytes} bytes, more than ${maxBytes} bytes`);
  const temp = hostTerminalsTemp(file);
  try {
    await fs.writeFile(temp, text, { mode: 0o600 });
    // Windows refuses a rename over a file another process holds open, a daemon's read or an indexer's
    await renameWithRetry(temp, file);
  } catch (err) {
    await fs.rm(temp, { force: true }).catch((rmErr: unknown) => {
      throw new Error(`${err instanceof Error ? err.message : String(err)}; removing ${temp} failed too: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`);
    });
    throw err;
  }
}
