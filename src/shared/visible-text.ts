import type { LocalizedArg, LocalizedText } from './localized-text';

// C0 controls but tab (whitespace, as in a commit message), C1 controls, the bidi marks, embeddings, overrides and isolates, the zero-width and invisible operator characters, the
// Mongolian vowel separator, the interlinear annotation marks, variation selectors, the tag characters (which carry ASCII
// unseen) and the line and paragraph separators, which can make a file or ref name read as another or hide text.
// eslint-disable-next-line no-control-regex, no-misleading-character-class
const HIDDEN_CHARACTERS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufe00-\ufe0f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
// eslint-disable-next-line no-misleading-character-class
const HIDDEN_CHARACTER = new RegExp(HIDDEN_CHARACTERS.source, 'u');

const escaped = (char: string): string => `\\u{${char.codePointAt(0)!.toString(16).toUpperCase()}}`;

// One U+FE0E or U+FE0F right after a visible non-ASCII character stays (its emoji or text presentation, as in a gitmoji
// subject; VS Code's unicode highlighter allows it too); every other selector, a run of them included, is escaped.
function shownAs(char: string, offset: number, text: string): string {
  if (char !== '\uFE0E' && char !== '\uFE0F') return escaped(char);
  const before = [...text.slice(Math.max(0, offset - 2), offset)].at(-1);
  return before !== undefined && before.codePointAt(0)! > 0x7f && !HIDDEN_CHARACTER.test(before) ? char : escaped(char);
}

/** Repository text (a path, a branch, a subject) as Damocles shows it: each control or bidi character but tab as its visible `\u{…}` escape. */
export const visibleText = (text: string): string => text.replace(HIDDEN_CHARACTERS, shownAs);

/** Multi-line repository text (a commit's message or diff) the same way, keeping tabs and line breaks; CRLF reads as LF. */
export const visibleLines = (text: string): string =>
  text.replace(/\r\n/g, '\n').replace(HIDDEN_CHARACTERS, (char: string, offset: number, whole: string) => (char === '\n' ? char : shownAs(char, offset, whole)));

/** `text` with every string argument, nested ones included, as `visibleLines` shows it; the catalog keys are Damocles' own. */
export function visibleArgs(text: LocalizedText): LocalizedText {
  if (text.args === undefined) return text;
  return { message: text.message, args: text.args.map((arg): LocalizedArg => (typeof arg === 'string' ? visibleLines(arg) : typeof arg === 'object' && 'message' in arg ? visibleArgs(arg) : arg)) };
}
