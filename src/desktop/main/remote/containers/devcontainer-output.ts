// The devcontainer CLI's output, untrusted: `--log-format json` lines on stderr become the build log's text lines, and the
// last stdout line is the command's result.
import { stripVTControlCharacters } from 'node:util';
import { MAX_BUILD_LOG_LINE_CHARS, MAX_BUILD_LOG_LINES, type BuildLog } from '../../../preload/overlay-channels';
import { isContainerId, isContainerPath, isContainerUser } from '../../../daemon/container-values';

// The CLI's info level; its trace and debug lines (every docker call it makes) stay out of the build log.
const INFO_LEVEL = 3;
// the most of one stderr line the parser holds before it has its newline
const MAX_PENDING_CHARS = 1024 * 1024;
// characters of the CLI's own error text a failure keeps
export const MAX_MESSAGE_CHARS = 500;

// every control, format or separator character a terminal escape leaves behind once stripVTControlCharacters took the escape
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** A chunk of terminal text as display lines: escapes dropped, split at line ends and carriage returns, blank lines left out. */
export function displayLines(text: string): string[] {
  return stripVTControlCharacters(text)
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(UNSAFE, '').trimEnd().slice(0, MAX_BUILD_LOG_LINE_CHARS))
    .filter((line) => line.trim() !== '');
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The display lines of one stderr line: a JSON log entry's text at info level or above, raw output always; other text as is. */
export function logEntryLines(line: string): string[] {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    // the CLI prints plain text before its logger exists (a usage error, a crash)
    return displayLines(line);
  }
  // plain text that happens to parse as JSON (`42`, `"x"`) is no log entry
  if (!isRecord(entry)) return displayLines(line);
  if (typeof entry['text'] !== 'string') return [];
  const level = typeof entry['level'] === 'number' ? entry['level'] : INFO_LEVEL;
  if (entry['type'] === 'raw') return displayLines(entry['text']);
  if ((entry['type'] === 'text' || entry['type'] === 'start') && level >= INFO_LEVEL) return displayLines(entry['text']);
  return [];
}

/** The build log as an attempt keeps it: the newest MAX_BUILD_LOG_LINES lines and the count of every line. */
export class BuildLogBuffer {
  private lines: string[] = [];
  private total = 0;
  private pending = '';

  /** Takes a stderr chunk; resolves whether a line was added. */
  push(text: string): boolean {
    const parts = (this.pending + text).split('\n');
    this.pending = parts.pop()!.slice(-MAX_PENDING_CHARS);
    return this.addAll(parts);
  }

  /** The text after the last newline, once the stream ended. */
  end(): boolean {
    const rest = this.pending;
    this.pending = '';
    return this.addAll([rest]);
  }

  /** Lines that come from elsewhere (an engine's own stderr), as text. */
  addText(text: string): boolean {
    const lines = displayLines(text);
    this.append(lines);
    return lines.length > 0;
  }

  snapshot(): BuildLog {
    return { lines: [...this.lines], total: this.total };
  }

  private addAll(rawLines: readonly string[]): boolean {
    const lines = rawLines.flatMap((line) => (line.trim() === '' ? [] : logEntryLines(line)));
    this.append(lines);
    return lines.length > 0;
  }

  private append(lines: readonly string[]): void {
    if (lines.length === 0) return;
    this.total += lines.length;
    this.lines = [...this.lines, ...lines].slice(-MAX_BUILD_LOG_LINES);
  }
}

export interface DevcontainerUp {
  readonly containerId: string;
  readonly remoteUser: string;
  readonly remoteWorkspaceFolder: string;
}

export type UpOutcome = { readonly ok: true; readonly up: DevcontainerUp } | { readonly ok: false; readonly message: string };

/** Untrusted text (the CLI's, an engine's stderr, a repository's values) as a failure's one-line message. */
export const shownMessage = (text: string): string => displayLines(text).join(' ').slice(0, MAX_MESSAGE_CHARS);

// The last non-blank stdout line, which the CLI writes as its one result object.
function resultObject(stdout: string): Record<string, unknown> | undefined {
  const last = stdout.split(/\r?\n/).filter((line) => line.trim() !== '').at(-1);
  if (last === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(last);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** `devcontainer up`'s result: success with a checked container id, user and folder, else the CLI's own message. */
export function parseUpResult(stdout: string, code: number | null): UpOutcome {
  const result = resultObject(stdout);
  if (!result) return { ok: false, message: `devcontainer up exited with ${String(code)} and printed no result` };
  if (result['outcome'] !== 'success') {
    const parts = [result['message'], result['description']].filter((part): part is string => typeof part === 'string' && part.trim() !== '');
    return { ok: false, message: shownMessage(parts.join(': ')) || `devcontainer up exited with ${String(code)}` };
  }
  const { containerId, remoteUser, remoteWorkspaceFolder } = result;
  if (!isContainerId(containerId) || !isContainerUser(remoteUser) || !isContainerPath(remoteWorkspaceFolder)) return { ok: false, message: 'devcontainer up answered a container id, user or folder Damocles does not take' };
  return { ok: true, up: { containerId, remoteUser, remoteWorkspaceFolder } };
}

/** `devcontainer read-configuration`'s result object, for the trust gate to read as untrusted input. */
export function parseReadConfiguration(stdout: string, code: number | null): { readonly ok: true; readonly resolved: unknown } | { readonly ok: false; readonly message: string } {
  const result = resultObject(stdout);
  if (!result) return { ok: false, message: `devcontainer read-configuration exited with ${String(code)} and printed no result` };
  if (result['outcome'] === 'error') {
    const parts = [result['message'], result['description']].filter((part): part is string => typeof part === 'string' && part.trim() !== '');
    return { ok: false, message: shownMessage(parts.join(': ')) || `devcontainer read-configuration exited with ${String(code)}` };
  }
  if (code !== 0) return { ok: false, message: `devcontainer read-configuration exited with ${String(code)}` };
  return { ok: true, resolved: result };
}
