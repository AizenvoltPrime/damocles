import { GitError, GitUntrustedError, RemoteCancelledError, StashKeptError, SyncBranchChangedError, type StashKeptOutcome, type SyncBranch } from '../../core/scm/errors';
import { WriteRefusedError, type WriteRefusal } from '../workspace/file-system';
import type { ErrorCodec, Fault } from './endpoint';
import { MAX_MESSAGE_CHARS } from './messages';
import { either, INVALID, int, localized, maybe, nonEmpty, obj, oneOf, str, type Parser } from './schema';
import { englishText, LocalizedError, type LocalizedText } from '../../shared/localized-text';

// git's stderr is what the host shows of a failure (gitErrorText); its stdout stays on core's side.
const MAX_STDERR_CHARS = 1024 * 1024;

const ref = nonEmpty(64 * 1024);
const syncBranch: Parser<SyncBranch> = obj({ branch: ref, remote: ref, upstreamBranch: ref });
const gitFailure = obj({ exitCode: maybe(int(-(2 ** 31), 2 ** 32)), stderr: str(MAX_STDERR_CHARS) });
const nul: Parser<null> = (raw) => (raw === null ? null : INVALID);
const text = localized(MAX_MESSAGE_CHARS);
// A system error's code (ENOSPC, EACCES), which the other side words in its own language.
const ERRNO_CODE = /^E[A-Z0-9]{1,31}$/;

function errnoCodeOf(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && ERRNO_CODE.test(code) ? code : undefined;
}

const FAULTS = {
  GitError: gitFailure,
  GitUntrustedError: obj({}),
  RemoteCancelledError: obj({}),
  StashKeptError: obj({
    text,
    outcome: oneOf(['ok', 'conflict', 'failed', 'cancelled'] as const satisfies readonly StashKeptOutcome[]),
    stash: maybe(ref),
    cause: maybe(obj({ message: str(MAX_MESSAGE_CHARS), git: maybe(gitFailure) })),
  }),
  SyncBranchChangedError: obj({ text, stage: oneOf(['pull', 'push'] as const), confirmed: syncBranch, found: either(syncBranch, nul) }),
  LocalizedError: obj({ text }),
  WriteRefusedError: obj({ refusal: oneOf(['outsideProject', 'outsideFile', 'replaced', 'notAFile', 'diskFull'] as const satisfies readonly WriteRefusal[]) }),
  Errno: obj({ code: (raw: unknown) => (typeof raw === 'string' && ERRNO_CODE.test(raw) ? raw : INVALID) }),
};

const gitData = (err: GitError): { exitCode: number | null; stderr: string } => ({ exitCode: err.exitCode, stderr: err.stderr.slice(-MAX_STDERR_CHARS) });
const causeData = (cause: unknown): { message: string; git?: { exitCode: number | null; stderr: string } } => ({
  message: (cause instanceof Error ? cause.message : String(cause)).slice(0, MAX_MESSAGE_CHARS),
  ...(cause instanceof GitError ? { git: gitData(cause) } : {}),
});

/**
 * The errors the host acts on by class (scm-host.ts, ref-flows.ts, document-service.ts), carried by name with their own fields and rebuilt on the
 * other side, any other error with a system error code as that code (Errno), and an error whose text is core's (LocalizedError)
 * as that text; every other error crosses as its message. Only these names are ever rebuilt. `render` puts a rebuilt error's
 * text in the receiving side's language as its message (desktop main's); a side that only passes errors on keeps English.
 */
export function errorCodec(render: (text: LocalizedText) => string = englishText): ErrorCodec {
  // the message main shows, which a daemon passing the error on never reads
  const rendered = <E extends LocalizedError>(err: E): E => Object.assign(err, { message: render(err.text) });
  return {
    encode: (err, log): Fault | undefined => {
      if (err instanceof GitError) return { name: 'GitError', data: gitData(err) };
      if (err instanceof GitUntrustedError) return { name: 'GitUntrustedError', data: {} };
      if (err instanceof RemoteCancelledError) return { name: 'RemoteCancelledError', data: {} };
      // decode takes a text only through `text`, so one it refuses crosses as the error's message, never as a fault
      const sendable = (localizedError: LocalizedError): boolean => {
        if (text(localizedError.text) !== INVALID) return true;
        log(`[core-protocol] a ${localizedError.name}'s text is outside the wire's LocalizedText, so it crosses as its message`);
        return false;
      };
      if (err instanceof StashKeptError) {
        if (!sendable(err)) return undefined;
        return {
          name: 'StashKeptError',
          data: { text: err.text, outcome: err.outcome, stash: err.stash, cause: err.cause === undefined ? undefined : causeData(err.cause) },
        };
      }
      if (err instanceof SyncBranchChangedError) {
        return sendable(err) ? { name: 'SyncBranchChangedError', data: { text: err.text, stage: err.stage, confirmed: err.confirmed, found: err.found } } : undefined;
      }
      if (err instanceof WriteRefusedError) return { name: 'WriteRefusedError', data: { refusal: err.refusal } };
      const code = errnoCodeOf(err);
      if (code !== undefined) return { name: 'Errno', data: { code } };
      if (err instanceof LocalizedError) return sendable(err) ? { name: 'LocalizedError', data: { text: err.text } } : undefined;
      return undefined;
    },
    decode: (fault, message) => {
      const cut = message.slice(0, MAX_MESSAGE_CHARS);
      switch (fault.name) {
        case 'GitError': {
          const data = FAULTS.GitError(fault.data);
          return data === INVALID ? undefined : new GitError(cut, data.exitCode ?? null, '', data.stderr);
        }
        case 'GitUntrustedError':
          return FAULTS.GitUntrustedError(fault.data) === INVALID ? undefined : new GitUntrustedError();
        case 'RemoteCancelledError':
          return FAULTS.RemoteCancelledError(fault.data) === INVALID ? undefined : new RemoteCancelledError();
        case 'StashKeptError': {
          const data = FAULTS.StashKeptError(fault.data);
          if (data === INVALID) return undefined;
          const cause = data.cause && (data.cause.git ? new GitError(data.cause.message, data.cause.git.exitCode ?? null, '', data.cause.git.stderr) : new Error(data.cause.message));
          return rendered(new StashKeptError(data.text, data.outcome, data.stash, cause));
        }
        case 'SyncBranchChangedError': {
          const data = FAULTS.SyncBranchChangedError(fault.data);
          return data === INVALID ? undefined : rendered(new SyncBranchChangedError(data.text, data.stage, data.confirmed, data.found));
        }
        case 'WriteRefusedError': {
          const data = FAULTS.WriteRefusedError(fault.data);
          return data === INVALID ? undefined : new WriteRefusedError(cut, data.refusal);
        }
        case 'Errno': {
          const data = FAULTS.Errno(fault.data);
          return data === INVALID ? undefined : Object.assign(new Error(cut), { code: data.code });
        }
        case 'LocalizedError': {
          const data = FAULTS.LocalizedError(fault.data);
          return data === INVALID ? undefined : rendered(new LocalizedError(data.text));
        }
        default:
          return undefined;
      }
    },
  };
}

export const ERROR_CODEC: ErrorCodec = errorCodec();
