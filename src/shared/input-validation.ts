// The overlay QuickInput's validation kinds, run by the overlay as the user types and by main again on the answer.

import { hasUnsafeWindowsSegment } from './relative-path';

export const INPUT_VALIDATIONS = ['branchName', 'path'] as const;
export type InputValidation = (typeof INPUT_VALIDATIONS)[number];

// Must stay equal to MAX_RELATIVE_PATH_LENGTH in src/shared/relative-path.ts.
export const MAX_INPUT_VALUE_LENGTH = 4096;

// Each code has a message under quickInput.invalid in the shell locales; char names the offending text.
export type InputProblem =
  | { readonly code: 'empty' | 'tooLong' | 'control' | 'space' | 'doubleDot' | 'slashEdge' | 'doubleSlash' | 'dotPart' | 'lockPart' | 'trailingDot' | 'atBrace' | 'at' | 'leadingDash' | 'head' }
  | { readonly code: 'char'; readonly char: string }
  | { readonly code: 'absolute' | 'backslash' | 'outside' | 'notNormalized' | 'windowsName' };

export interface InputPlatform {
  // a path also passes hasUnsafeWindowsSegment, as main's and core's checks on Windows do
  readonly windows: boolean;
}

const SPACE = / /;
const REF_FORBIDDEN = /[~^:?*[\\]/;

// ASCII control characters, DEL included
const hasControl = (value: string): boolean => [...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f);

/** git check-ref-format's rules (refs.c check_refname_format) for the part after refs/heads/. */
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

/** What is wrong with `value` for `kind` on `platform`, or undefined when it is valid. */
export function inputProblem(kind: InputValidation, value: string, platform: InputPlatform): InputProblem | undefined {
  if (value.length === 0) return { code: 'empty' };
  if (value.length > MAX_INPUT_VALUE_LENGTH) return { code: 'tooLong' };
  switch (kind) {
    case 'path':
      return pathProblem(value, platform);
    case 'branchName':
      // strbuf_check_branch_ref refuses a leading '-' and HEAD
      if (value.startsWith('-')) return { code: 'leadingDash' };
      if (value === 'HEAD') return { code: 'head' };
      return refNameProblem(value);
  }
}
