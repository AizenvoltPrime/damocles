// The overlay QuickInput's validation kinds, run by the overlay as the user types and by main again on the answer.

import { hasUnsafeWindowsSegment } from './relative-path';

export const INPUT_VALIDATIONS = ['branchName', 'tagName', 'path', 'remoteName', 'portTarget', 'localPort'] as const;
export type InputValidation = (typeof INPUT_VALIDATIONS)[number];

// Must stay equal to MAX_RELATIVE_PATH_LENGTH in src/shared/relative-path.ts.
export const MAX_INPUT_VALUE_LENGTH = 4096;
// A remote name's characters, which core's isRemoteName (src/core/scm/remotes.ts) checks too.
export const MAX_REMOTE_NAME_LENGTH = 100;

// Each code has a message under quickInput.invalid in the shell locales; char names the offending text.
export type InputProblem =
  | { readonly code: 'empty' | 'tooLong' | 'control' | 'space' | 'doubleDot' | 'slashEdge' | 'doubleSlash' | 'dotPart' | 'lockPart' | 'trailingDot' | 'atBrace' | 'at' | 'leadingDash' | 'head' }
  | { readonly code: 'char'; readonly char: string }
  | { readonly code: 'absolute' | 'backslash' | 'outside' | 'notNormalized' | 'windowsName' }
  | { readonly code: 'portTarget' | 'portDigits' | 'portRange' };

export interface InputPlatform {
  // a path also passes hasUnsafeWindowsSegment, as main's and core's checks on Windows do
  readonly windows: boolean;
}

const SPACE = / /;
const REF_FORBIDDEN = /[~^:?*[\\]/;

// ASCII control characters, DEL included
const hasControl = (value: string): boolean => [...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f);

/** git check-ref-format's rules (refs.c check_refname_format) for the part after refs/heads/ or refs/tags/. */
function refNameProblem(name: string): InputProblem | undefined {
  if (hasControl(name)) return { code: 'control' };
  if (SPACE.test(name)) return { code: 'space' };
  const forbidden = REF_FORBIDDEN.exec(name);
  if (forbidden) return { code: 'char', char: forbidden[0] };
  if (name.includes('..')) return { code: 'doubleDot' };
  if (name.includes('@{')) return { code: 'atBrace' };
  if (name === '@') return { code: 'at' };
  if (name.startsWith('/') || name.endsWith('/')) return { code: 'slashEdge' };
  if (name.includes('//')) return { code: 'doubleSlash' };
  const parts = name.split('/');
  if (parts.some((part) => part.startsWith('.'))) return { code: 'dotPart' };
  if (parts.some((part) => part.endsWith('.lock'))) return { code: 'lockPart' };
  if (name.endsWith('.')) return { code: 'trailingDot' };
  return undefined;
}

function pathProblem(value: string, platform: InputPlatform): InputProblem | undefined {
  if (hasControl(value)) return { code: 'control' };
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return { code: 'absolute' };
  if (value.includes('\\')) return { code: 'backslash' };
  const parts = value.split('/');
  if (parts.includes('..')) return { code: 'outside' };
  if (parts.some((part) => part === '' || part === '.')) return { code: 'notNormalized' };
  if (platform.windows && hasUnsafeWindowsSegment(value)) return { code: 'windowsName' };
  return undefined;
}

/**
 * A remote name the engine accepts, stricter than git: an ASCII letter or digit, then letters, digits, '.', '_' or '-', never
 * '..', a trailing '.' or '.lock', so it can never be read as an option or a refspec. Must match isRemoteName in
 * src/core/scm/remotes.ts.
 */
function remoteNameProblem(name: string): InputProblem | undefined {
  if (name.length > MAX_REMOTE_NAME_LENGTH) return { code: 'tooLong' };
  if (hasControl(name)) return { code: 'control' };
  if (SPACE.test(name)) return { code: 'space' };
  if (name.startsWith('-')) return { code: 'leadingDash' };
  const forbidden = /^[^A-Za-z0-9]|[^A-Za-z0-9._-]/.exec(name);
  if (forbidden) return { code: 'char', char: forbidden[0] };
  if (name.includes('..')) return { code: 'doubleDot' };
  if (name.endsWith('.lock')) return { code: 'lockPart' };
  if (name.endsWith('.')) return { code: 'trailingDot' };
  return undefined;
}

// VS Code's parseAddress (tunnelModel.ts): an optional host of dot-separated [A-Za-z0-9_-] labels and a colon, then the port.
// No label starts with '-', as in DNS, so the host is never option-like, which the daemon's ports.connect parser refuses.
const PORT_TARGET = /^(?:([A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_][A-Za-z0-9_-]*)*):)?([0-9]+)$/;
// A DNS name's length limit, which also bounds the host part main passes on.
export const MAX_PORT_TARGET_HOST_LENGTH = 253;
const MAX_PORT = 65535;

const isPortNumber = (digits: string): boolean => digits.length <= 5 && Number(digits) >= 1 && Number(digits) <= MAX_PORT;

/** A port, or host:port for an address the target reaches; the host is absent for a bare port, the target's own loopback. */
export function parsePortTarget(value: string): { readonly host?: string; readonly port: number } | undefined {
  const match = PORT_TARGET.exec(value);
  if (!match || !isPortNumber(match[2]!)) return undefined;
  const host = match[1];
  if (host !== undefined && host.length > MAX_PORT_TARGET_HOST_LENGTH) return undefined;
  return host === undefined ? { port: Number(match[2]) } : { host, port: Number(match[2]) };
}

/** VS Code's ChangeLocalPortAction rule: digits only, 1 to 65535. */
export function parseLocalPort(value: string): number | undefined {
  return /^[0-9]+$/.test(value) && isPortNumber(value) ? Number(value) : undefined;
}

function portTargetProblem(value: string): InputProblem | undefined {
  const match = PORT_TARGET.exec(value);
  if (!match || (match[1] !== undefined && match[1].length > MAX_PORT_TARGET_HOST_LENGTH)) return { code: 'portTarget' };
  return isPortNumber(match[2]!) ? undefined : { code: 'portRange' };
}

function localPortProblem(value: string): InputProblem | undefined {
  if (!/^[0-9]+$/.test(value)) return { code: 'portDigits' };
  return isPortNumber(value) ? undefined : { code: 'portRange' };
}

/** What is wrong with `value` for `kind` on `platform`, or undefined when it is valid. */
export function inputProblem(kind: InputValidation, value: string, platform: InputPlatform): InputProblem | undefined {
  if (value.length === 0) return { code: 'empty' };
  if (value.length > MAX_INPUT_VALUE_LENGTH) return { code: 'tooLong' };
  switch (kind) {
    case 'path':
      return pathProblem(value, platform);
    case 'remoteName':
      return remoteNameProblem(value);
    case 'portTarget':
      return portTargetProblem(value);
    case 'localPort':
      return localPortProblem(value);
    case 'branchName':
      // strbuf_check_branch_ref refuses a leading '-' and HEAD
      if (value.startsWith('-')) return { code: 'leadingDash' };
      if (value === 'HEAD') return { code: 'head' };
      return refNameProblem(value);
    case 'tagName':
      // a leading '-' could read as an option where the engine names the tag
      if (value.startsWith('-')) return { code: 'leadingDash' };
      return refNameProblem(value);
  }
}
