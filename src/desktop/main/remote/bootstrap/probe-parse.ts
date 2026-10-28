// Stage 1's status lines, `@@DAMOCLES {json}` on its stdout, until the bridge line hands stdout to the protocol. Text a
// target produces crosses only as a code plus parameters main localizes, so every line is validated before it is used.
import type { HostNotice, SshFailureCode } from '../../../preload/overlay-channels';
import { SERVER_TARGETS, type ServerTarget } from '../server-manifest-format';

export const STAGE_MARKER = '@@DAMOCLES ';
// a status line, or anything a login script printed, longer than this ends the attempt
export const MAX_STAGE_LINE_BYTES: number = 64 * 1024;
const MAX_PARAM_CHARS = 4096;
const MAX_PARAMS = 8;

export type ProbeFailureCode = Extract<SshFailureCode,
  'unsupportedOs' | 'glibcTooOld' | 'glibcxxMissing' | 'kernelTooOld' | 'macosTooOld' | 'windowsBuildTooOld' | 'nixLdMissing' | 'noexec' | 'lowSpace' | 'installFolderUnsafe' | 'hashMismatch' | 'downloadAndUploadFailed' | 'selfTestFailed' | 'bridgeFailed' | 'unknown'>;
export type ProbeNoticeCode = 'noLinger' | 'lowInotify' | 'noGitBash' | 'wmiBlocked';

// The failures stage 1 reports, with the parameters each one carries; a reason may always be added.
export const PROBE_FAILURES: Readonly<Record<ProbeFailureCode, readonly string[]>> = {
  unsupportedOs: ['os', 'arch'],
  glibcTooOld: ['found', 'needed'],
  glibcxxMissing: [],
  kernelTooOld: ['found', 'needed'],
  macosTooOld: ['found', 'needed'],
  windowsBuildTooOld: ['found', 'needed'],
  nixLdMissing: [],
  noexec: ['folder'],
  lowSpace: ['folder', 'freeMb', 'neededMb'],
  installFolderUnsafe: ['folder'],
  hashMismatch: [],
  downloadAndUploadFailed: [],
  selfTestFailed: [],
  bridgeFailed: ['reason'],
  unknown: ['reason'],
};

export const PROBE_NOTICES: Readonly<Record<ProbeNoticeCode, readonly string[]>> = {
  noLinger: ['user'],
  lowInotify: ['limit', 'suggested'],
  noGitBash: [],
  wmiBlocked: [],
};

export type StageParams = Readonly<Record<string, string | number>>;

export type StageMessage =
  | { readonly kind: 'step'; readonly step: 'checking' | 'installing' | 'starting' }
  | { readonly kind: 'progress'; readonly fraction: number }
  | { readonly kind: 'notice'; readonly notice: HostNotice & { readonly code: ProbeNoticeCode } }
  | { readonly kind: 'fail'; readonly code: ProbeFailureCode; readonly params: StageParams }
  | { readonly kind: 'probe'; readonly target: ServerTarget; readonly install: string }
  | { readonly kind: 'upload' }
  // a download try that failed; the stage retries, then asks for the upload
  | { readonly kind: 'downloadFailed'; readonly attempt: number; readonly reason: string }
  | { readonly kind: 'settled' }
  | { readonly kind: 'bridge' };

export class StageProtocolError extends Error {
  override readonly name = 'StageProtocolError';
}

const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
// one first try plus three retries
const MAX_DOWNLOAD_ATTEMPTS = 4;
// `http<status>`, or a .NET WebExceptionStatus name camel-cased
const DOWNLOAD_FAILURE_REASON = /^(?:http\d{3}|[a-z][A-Za-z]{0,39})$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isSafeText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !UNSAFE_TEXT.test(value);

// Exactly the named keys, each a bounded plain string or a finite number; a `reason` may be left out.
function parseParams(raw: unknown, keys: readonly string[]): StageParams | undefined {
  if (!isRecord(raw)) return undefined;
  const entries = Object.entries(raw);
  if (entries.length > MAX_PARAMS) return undefined;
  const params: Record<string, string | number> = {};
  for (const [key, value] of entries) {
    if (!keys.includes(key) && key !== 'reason' && key !== 'target') return undefined;
    if (typeof value === 'number' ? !Number.isFinite(value) : !isSafeText(value, MAX_PARAM_CHARS)) return undefined;
    Object.defineProperty(params, key, { value, enumerable: true });
  }
  return keys.every((key) => key === 'reason' || Object.hasOwn(params, key)) ? params : undefined;
}

function parseMessage(raw: unknown): StageMessage | undefined {
  if (!isRecord(raw)) return undefined;
  if (Object.keys(raw).length === 1 && typeof raw['progress'] === 'number') {
    const fraction = raw['progress'];
    return fraction >= 0 && fraction <= 1 ? { kind: 'progress', fraction } : undefined;
  }
  switch (raw['kind']) {
    case 'step': {
      const step = raw['step'];
      return step === 'checking' || step === 'installing' || step === 'starting' ? { kind: 'step', step } : undefined;
    }
    case 'notice': {
      const code = raw['code'];
      if (typeof code !== 'string' || !Object.hasOwn(PROBE_NOTICES, code)) return undefined;
      const params = parseParams(raw['params'], PROBE_NOTICES[code as ProbeNoticeCode]);
      return params ? { kind: 'notice', notice: { code: code as ProbeNoticeCode, params } } : undefined;
    }
    case 'fail': {
      const code = raw['code'];
      if (typeof code !== 'string' || !Object.hasOwn(PROBE_FAILURES, code)) return undefined;
      const params = parseParams(raw['params'], PROBE_FAILURES[code as ProbeFailureCode]);
      return params ? { kind: 'fail', code: code as ProbeFailureCode, params } : undefined;
    }
    case 'probe': {
      const { target, install } = raw;
      if (typeof target !== 'string' || !(SERVER_TARGETS as readonly string[]).includes(target) || !isSafeText(install, MAX_PARAM_CHARS) || install === '') return undefined;
      return { kind: 'probe', target: target as ServerTarget, install };
    }
    case 'downloadFailed': {
      const { attempt, reason } = raw;
      const valid = Object.keys(raw).length === 3 && Number.isInteger(attempt) && (attempt as number) >= 1 && (attempt as number) <= MAX_DOWNLOAD_ATTEMPTS
        && typeof reason === 'string' && DOWNLOAD_FAILURE_REASON.test(reason);
      return valid ? { kind: 'downloadFailed', attempt: attempt as number, reason: reason as string } : undefined;
    }
    case 'upload':
    case 'settled':
    case 'bridge':
      return Object.keys(raw).length === 1 ? { kind: raw['kind'] } : undefined;
    default:
      return undefined;
  }
}

/**
 * One line of stage 1's stdout: a status message, or undefined for a line without the marker (a login script's output). A
 * marked line that is not one of the messages throws, since only stage 1 writes the marker.
 */
export function parseStageLine(line: string): StageMessage | undefined {
  const at = line.indexOf(STAGE_MARKER);
  if (at < 0) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(at + STAGE_MARKER.length));
  } catch {
    throw new StageProtocolError('a status line that is not JSON');
  }
  const message = parseMessage(raw);
  if (!message) throw new StageProtocolError('a status line outside the stage protocol');
  return message;
}

export interface StageLine {
  readonly text: string;
  // undefined for a line without the marker
  readonly message: StageMessage | undefined;
}

export interface StageOutput {
  /**
   * The complete lines in chunk, each parsed once, in order up to the first that breaks the protocol, which ends the output
   * as error; once the bridge line arrived, the bytes after it, which belong to the protocol.
   */
  push(chunk: Uint8Array): { readonly lines: readonly StageLine[]; readonly rest?: Uint8Array; readonly error?: StageProtocolError };
}

const tooLong = (): StageProtocolError => new StageProtocolError(`a line of stage output passed ${MAX_STAGE_LINE_BYTES} bytes`);

/** Splits stage 1's stdout into lines up to and including the bridge line; later bytes are never read as text. */
export function createStageOutput(): StageOutput {
  let pending = Buffer.alloc(0);
  let bridged = false;
  return {
    push(chunk) {
      if (bridged) return { lines: [], rest: chunk };
      pending = Buffer.concat([pending, chunk]);
      const lines: StageLine[] = [];
      for (let end = pending.indexOf(0x0a); end >= 0; end = pending.indexOf(0x0a)) {
        if (end > MAX_STAGE_LINE_BYTES) return { lines, error: tooLong() };
        const text = pending.subarray(0, end).toString('utf8').replace(/\r$/, '');
        pending = pending.subarray(end + 1);
        let message: StageMessage | undefined;
        try {
          message = parseStageLine(text);
        } catch (err) {
          if (!(err instanceof StageProtocolError)) throw err;
          return { lines, error: err };
        }
        lines.push({ text, message });
        if (message?.kind === 'bridge') {
          bridged = true;
          const rest = pending;
          pending = Buffer.alloc(0);
          return { lines, rest };
        }
      }
      if (pending.length > MAX_STAGE_LINE_BYTES) return { lines, error: tooLong() };
      return { lines };
    },
  };
}
