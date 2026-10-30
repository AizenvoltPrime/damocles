// The errors source control's engine throws that its host acts on, and the text it shows for any of them. Stateless, so desktop
// main imports them to rebuild what crosses the core protocol (src/desktop/core-protocol/errors.ts).
import { visibleLines } from '../../shared/visible-text';
import { LocalizedError, type LocalizedText } from '../../shared/localized-text';

// Any scheme://userinfo@ loses its userinfo: tokens and passwords ride in remote URLs.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi;

export function redactUrls(text: string): string {
  return text.replace(URL_USERINFO, '$1');
}

export class GitError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;

  constructor(message: string, exitCode: number | null, stdout: string, stderr: string) {
    super(message);
    this.name = 'GitError';
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

// A failure main offers an action for, read from git's stderr where the GitError carries it; the stderr itself stays text
// git printed, and only this code decides the action.
export type GitFailureCode = 'publickeyDenied';

export function gitFailureCode(err: unknown): GitFailureCode | undefined {
  // OpenSSH's "Permission denied (publickey)." or "(publickey,password)." when no offered key was accepted
  return err instanceof GitError && /Permission denied \(publickey[,)]/.test(err.stderr) ? 'publickeyDenied' : undefined;
}

// The engine runs no git for a project that is not trusted (D8); the runner refuses as the last line.
export class GitUntrustedError extends Error {
  constructor() {
    super('Source control runs no git in an untrusted project');
    this.name = 'GitUntrustedError';
  }
}

// The user cancelled a running fetch, pull, push, sync or clone: its process tree is dead and nothing tells the user.
export class RemoteCancelledError extends Error {
  constructor() {
    super('The remote operation was cancelled');
    this.name = 'RemoteCancelledError';
  }
}

export type StashKeptOutcome = 'ok' | 'conflict' | 'failed' | 'cancelled';

// Thrown instead of the operation's own outcome, so the user always learns the changes stay in the stash list.
export class StashKeptError extends LocalizedError {
  readonly outcome: StashKeptOutcome;
  // undefined when refs/stash could not be read after the push
  readonly stash: string | undefined;
  constructor(text: LocalizedText, outcome: StashKeptOutcome, stash: string | undefined, cause?: unknown) {
    super(text, cause === undefined ? undefined : { cause });
    this.name = 'StashKeptError';
    this.outcome = outcome;
    this.stash = stash;
  }
}

export interface SyncBranch {
  readonly branch: string;
  readonly remote: string;
  readonly upstreamBranch: string;
}

export class SyncBranchChangedError extends LocalizedError {
  readonly stage: 'pull' | 'push';
  readonly confirmed: SyncBranch;
  readonly found: SyncBranch | null;
  constructor(text: LocalizedText, stage: 'pull' | 'push', confirmed: SyncBranch, found: SyncBranch | null) {
    super(text);
    this.name = 'SyncBranchChangedError';
    this.stage = stage;
    this.confirmed = confirmed;
    this.found = found;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// git's own words for a failed call, fit for a notice and a log line: its error and fatal lines, else its first stderr lines
// (progress and hints come first), else the error's message; URL userinfo redacted, control and bidi characters as escapes
export function gitErrorText(err: unknown): string {
  if (err instanceof GitError) {
    const lines = err.stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
    const errors = lines.filter((line) => /^(error|fatal):/.test(line));
    if (lines.length > 0) return visibleLines(redactUrls((errors.length > 0 ? errors : lines).slice(0, 3).join(' ')));
  }
  return visibleLines(redactUrls(errorText(err)));
}
