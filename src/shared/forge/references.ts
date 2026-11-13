// Issue and merge request references in commit messages (docs/invariants.md "GitHub and GitLab accounts", references):
// `#123`, GitHub's `GH-123`, GitLab's `!45`, and `owner/repo#12` (GitLab: `group/sub/project#12`). Commit text is hostile, so
// the scanner reads each character a bounded number of times and uses no regular expression over the whole text. A reference
// links by its syntax alone; whether its issue or project exists is the server's page to say.

export type ReferenceKind = 'github' | 'gitlab';

export interface ForgeReference {
  readonly sigil: '#' | '!';
  readonly number: number;
  /** 'owner/repo' (GitLab: group/sub/project) when the reference names another project. */
  readonly path?: string;
}

export interface ReferenceSegment {
  readonly text: string;
  readonly reference?: ForgeReference;
}

/** The largest number a reference carries: GitHub's and GitLab's ids are 32-bit signed integers. */
export const MAX_REFERENCE_NUMBER = 2_147_483_647;
/** The references one text links; the rest stay plain text, so a hostile message cannot fill a row with controls. */
export const MAX_LINKED_REFERENCES = 200;
const MAX_SEGMENTS = 20;
const MAX_SEGMENT_CHARS = 255;

const isSpace = (code: number): boolean => code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0;
const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;
const isSegmentChar = (code: number): boolean =>
  (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || isDigit(code) || code === 0x5f || code === 0x2e || code === 0x2d;
// whitespace, '(' and '['; none of them can be part of a reference, which lets the scanner skip what it already read
const isBefore = (code: number): boolean => isSpace(code) || code === 0x28 || code === 0x5b;
// whitespace and . , ; : ) ] ! ?
const isAfter = (code: number): boolean =>
  isSpace(code) || code === 0x2e || code === 0x2c || code === 0x3b || code === 0x3a || code === 0x29 || code === 0x5d || code === 0x21 || code === 0x3f;

/** A cross-project path: 2 to 20 segments of letters, digits, '_', '.' and '-', never '.' or '..'; GitHub's exactly owner/repo. */
export function isReferencePath(path: string, kind?: ReferenceKind): boolean {
  const segments = path.split('/');
  if (segments.length < 2 || segments.length > MAX_SEGMENTS || (kind === 'github' && segments.length !== 2)) return false;
  for (const segment of segments) {
    if (segment.length === 0 || segment.length > MAX_SEGMENT_CHARS || segment === '.' || segment === '..') return false;
    for (let index = 0; index < segment.length; index++) if (!isSegmentChar(segment.charCodeAt(index))) return false;
  }
  return true;
}

/** How the reference reads: `#123`, `!45`, `owner/repo#12`. */
export function referenceLabel(reference: ForgeReference): string {
  return `${reference.path ?? ''}${reference.sigil}${reference.number}`;
}

/** The end of the digits after a sigil at sigilAt, with their value; undefined end when they are no reference number. */
function numberAt(text: string, sigilAt: number): { readonly stop: number; readonly value?: number } {
  let at = sigilAt + 1;
  while (at < text.length && isDigit(text.charCodeAt(at))) at++;
  const digits = at - sigilAt - 1;
  if (digits === 0 || digits > 10 || text.charCodeAt(sigilAt + 1) === 0x30) return { stop: Math.max(at, sigilAt + 1) };
  if (at < text.length && !isAfter(text.charCodeAt(at))) return { stop: at };
  const value = Number(text.slice(sigilAt + 1, at));
  return value <= MAX_REFERENCE_NUMBER ? { stop: at, value } : { stop: at };
}

const isSigil = (code: number, kind: ReferenceKind): boolean => code === 0x23 || (code === 0x21 && kind === 'gitlab');

// GitHub's GH-123, its own issue or pull request; the '-' stands where numberAt expects the sigil
const isGithubPrefix = (text: string, start: number, kind: ReferenceKind): boolean =>
  kind === 'github' && text.charCodeAt(start) === 0x47 && text.charCodeAt(start + 1) === 0x48 && text.charCodeAt(start + 2) === 0x2d;

/** The reference starting at start, or where reading stopped; no reference can start between start and stop. */
function matchAt(text: string, start: number, kind: ReferenceKind): { readonly stop: number; readonly reference?: ForgeReference } {
  const first = text.charCodeAt(start);
  if (isSigil(first, kind)) {
    const { stop, value } = numberAt(text, start);
    return value !== undefined ? { stop, reference: { sigil: first === 0x21 ? '!' : '#', number: value } } : { stop };
  }
  if (isGithubPrefix(text, start, kind)) {
    const { stop, value } = numberAt(text, start + 2);
    if (value !== undefined) return { stop, reference: { sigil: '#', number: value } };
  }
  if (!isSegmentChar(first)) return { stop: start + 1 };
  let at = start;
  while (at < text.length && (isSegmentChar(text.charCodeAt(at)) || text.charCodeAt(at) === 0x2f)) at++;
  if (at >= text.length || !isSigil(text.charCodeAt(at), kind)) return { stop: at };
  const path = text.slice(start, at);
  const { stop, value } = numberAt(text, at);
  if (value === undefined || !isReferencePath(path, kind)) return { stop };
  return { stop, reference: { sigil: text.charCodeAt(at) === 0x21 ? '!' : '#', number: value, path } };
}

/**
 * Splits text into plain and reference segments, at most MAX_LINKED_REFERENCES references; '!' links only for 'gitlab' and
 * `GH-123` only for 'github'. Concatenating every segment.text gives text back.
 */
export function scanReferences(text: string, kind: ReferenceKind): readonly ReferenceSegment[] {
  const segments: ReferenceSegment[] = [];
  let plainFrom = 0;
  let at = 0;
  let linked = 0;
  while (at < text.length && linked < MAX_LINKED_REFERENCES) {
    if (at > 0 && !isBefore(text.charCodeAt(at - 1))) {
      at++;
      continue;
    }
    const match = matchAt(text, at, kind);
    if (match.reference) {
      if (at > plainFrom) segments.push({ text: text.slice(plainFrom, at) });
      segments.push({ text: text.slice(at, match.stop), reference: match.reference });
      plainFrom = match.stop;
      linked++;
    }
    at = Math.max(at + 1, match.stop);
  }
  if (plainFrom < text.length) segments.push({ text: text.slice(plainFrom) });
  return segments;
}
