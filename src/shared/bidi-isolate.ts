// User text inside a sentence of another direction: a name written right to left would otherwise take the numbers and
// punctuation beside it into its own run. Pure.

// First strong isolate and pop directional isolate, the plain-text form of a bdi element (UAX #9, the HTML Standard's bdi).
const FSI = '\u2068';
const PDI = '\u2069';
const MARKS = /[\u2068\u2069]/g;

/**
 * `text` marked as user text that takes its own direction, for a sentence IsolatedText shows: it draws each marked run as
 * a bdi element. Marks inside `text` are removed first, so a run never ends early.
 */
export const isolated = (text: string): string => `${FSI}${text.replace(MARKS, '')}${PDI}`;

/** A marked sentence without its marks, for an accessible name or a title, which no bidi layout reads. */
export const withoutIsolates = (text: string): string => text.replace(MARKS, '');

export interface IsolatedPart {
  readonly text: string;
  readonly isolated: boolean;
}

/** A marked sentence as its runs in order: the text outside the marks, and each marked run without them. */
export function isolatedParts(text: string): IsolatedPart[] {
  const parts: IsolatedPart[] = [];
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf(FSI, at);
    const close = open < 0 ? -1 : text.indexOf(PDI, open + 1);
    if (close < 0) break;
    if (open > at) parts.push({ text: text.slice(at, open), isolated: false });
    parts.push({ text: text.slice(open + 1, close), isolated: true });
    at = close + 1;
  }
  const rest = withoutIsolates(text.slice(at));
  if (rest !== '') parts.push({ text: rest, isolated: false });
  return parts;
}
