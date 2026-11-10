// A single-pass CSS reader for the parts design mode needs: custom properties in `:root` and `@theme` blocks, `@font-face`
// rules and top-level `@import`s. Linear in the input; it never backtracks and treats anything it does not understand as text.

export interface CssDeclaration {
  readonly name: string;
  readonly value: string;
  /** 1-based line of the declaration's name. */
  readonly line: number;
}

export interface CssFontFace {
  readonly family: string | undefined;
  /** Each `url(...)` of its `src`, unquoted, in order. */
  readonly urls: readonly string[];
  /** Every declaration of the rule, in order. */
  readonly declarations: readonly CssDeclaration[];
  readonly line: number;
}

export interface CssScan {
  /** Custom properties declared directly in a `:root` rule or an `@theme` block (`@theme inline`, `@theme static` included). */
  readonly tokens: readonly CssDeclaration[];
  readonly fontFaces: readonly CssFontFace[];
  /** Every declaration of every rule, in the order the rules close. */
  readonly declarations: readonly CssDeclaration[];
  /** The file imports Tailwind (`@import "tailwindcss"`, `@tailwind`). */
  readonly tailwind: boolean;
  /** The URL of each top-level `@import`, in its string or `url()` form, unquoted. */
  readonly imports: readonly string[];
}

interface Block {
  readonly kind: 'tokens' | 'font-face' | 'other';
  readonly line: number;
}

function blockKind(prelude: string): Block['kind'] {
  const text = prelude.trim().replace(/\s+/g, ' ').toLowerCase();
  if (text === '@font-face') return 'font-face';
  if (text === '@theme' || text.startsWith('@theme ')) return 'tokens';
  if (text.split(',').some((selector) => selector.trim() === ':root')) return 'tokens';
  return 'other';
}

/** Splits `text` at top-level `;` into declarations, keeping parentheses and strings whole. */
export function declarationsOf(text: string, firstLine: number): CssDeclaration[] {
  const declarations: CssDeclaration[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  let line = firstLine;
  let startLine = firstLine;
  const flush = (end: number): void => {
    const raw = text.slice(start, end);
    const colon = raw.indexOf(':');
    if (colon > 0) {
      const name = raw.slice(0, colon).trim();
      const value = withoutImportant(raw.slice(colon + 1).trim());
      const leading = raw.slice(0, raw.length - raw.trimStart().length);
      let lineOfName = startLine;
      for (const ch of leading) if (ch === '\n') lineOfName++;
      if (name !== '' && value !== '') declarations.push({ name, value, line: lineOfName });
    }
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\n') line++;
    if (quote !== '') {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) {
      flush(i);
      start = i + 1;
      startLine = line;
    }
  }
  flush(text.length);
  return declarations;
}

/** `value` without a trailing `!important`, read without a pattern that could backtrack over spaces. */
function withoutImportant(value: string): string {
  return value.toLowerCase().endsWith('!important') ? value.slice(0, -'!important'.length).trimEnd() : value;
}

const URL_PATTERN = /url\(([^()]*)\)/gi;

/** Every `url(...)` in a declaration value, trimmed and unquoted. */
export function cssUrls(value: string): string[] {
  const urls: string[] = [];
  for (const match of value.matchAll(URL_PATTERN)) {
    const inner = (match[1] ?? '').trim();
    const quoted = inner.length >= 2 && (inner[0] === '"' || inner[0] === "'") && inner.at(-1) === inner[0];
    urls.push(quoted ? inner.slice(1, -1) : inner);
  }
  return urls.filter((url) => url !== '');
}

/**
 * The strings an `image-set()` (or `-webkit-image-set()`) lists bare, such as `image-set("a.png" 1x)`, which load as a `url()`
 * would; its `url()`s are `cssUrls`'. One pass: a call is read to its closing parenthesis and the search goes on after it.
 */
export function imageSetStrings(value: string): string[] {
  const strings: string[] = [];
  const lower = value.toLowerCase();
  for (let at = lower.indexOf('image-set('); at !== -1; at = lower.indexOf('image-set(', at)) {
    let depth = 1;
    let i = at + 'image-set('.length;
    for (; i < value.length && depth > 0; i++) {
      const ch = value[i]!;
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === '"' || ch === "'") {
        let end = i + 1;
        while (end < value.length && value[end] !== ch) end += value[end] === '\\' ? 2 : 1;
        if (depth === 1) strings.push(value.slice(i + 1, end));
        i = end;
      }
    }
    at = i;
  }
  return strings.filter((text) => text !== '');
}

/** Every resource a declaration value loads: its `url()`s and the bare strings of its `image-set()`s. */
export function cssResourceRefs(value: string): string[] {
  return [...cssUrls(value), ...imageSetStrings(value)];
}

/**
 * Reads `css` once. Comments are skipped, strings kept whole; a declaration counts only when it sits directly in a
 * tokens block, so `--x` inside `.dark { }` nested in `:root` does not.
 */
export function scanCss(css: string): CssScan {
  const tokens: CssDeclaration[] = [];
  const fontFaces: CssFontFace[] = [];
  const all: CssDeclaration[] = [];
  let tailwind = false;
  const imports: string[] = [];
  const stack: { block: Block; bodyLine: number; text: string[] }[] = [];
  let preludeStart = 0;
  let line = 1;
  let quote = '';
  // Body text of the innermost block, without its nested blocks, built as the scan leaves each nested block.
  const appendBody = (from: number, to: number): void => {
    const top = stack[stack.length - 1];
    if (top) top.text.push(css.slice(from, to));
  };
  let segmentStart = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]!;
    if (ch === '\n') {
      line++;
      continue;
    }
    if (quote !== '') {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? css.length : end + 2;
      for (let j = i; j < stop; j++) if (css[j] === '\n') line++;
      appendBody(segmentStart, i);
      segmentStart = stop;
      if (stack.length === 0) preludeStart = stop;
      i = stop - 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ';' && stack.length === 0) {
      const statement = css.slice(preludeStart, i).trim().replace(/\s+/g, ' ');
      if (/^@import (?:url\( ?)?["']tailwindcss["']/i.test(statement) || /^@tailwind\b/i.test(statement)) tailwind = true;
      const imported = importUrl(statement);
      if (imported !== undefined) imports.push(imported);
      preludeStart = i + 1;
      continue;
    }
    if (ch === '{') {
      const top = stack[stack.length - 1];
      // A nested block's prelude is the text since the last `;` or `}` of its parent's body.
      const prelude = top ? lastStatement(css.slice(segmentStart, i)) : css.slice(preludeStart, i);
      if (top) appendBody(segmentStart, i - prelude.length);
      stack.push({ block: { kind: blockKind(prelude), line }, bodyLine: line, text: [] });
      segmentStart = i + 1;
      continue;
    }
    if (ch === '}') {
      const closing = stack.pop();
      if (!closing) {
        preludeStart = i + 1;
        segmentStart = i + 1;
        continue;
      }
      closing.text.push(css.slice(segmentStart, i));
      const body = closing.text.join('');
      const declarations = declarationsOf(body, closing.bodyLine);
      all.push(...declarations);
      if (closing.block.kind === 'tokens') tokens.push(...declarations.filter((d) => d.name.startsWith('--')));
      if (closing.block.kind === 'font-face') {
        const family = declarations.find((d) => d.name.toLowerCase() === 'font-family')?.value.replace(/^["']|["']$/g, '');
        const urls = declarations.filter((d) => d.name.toLowerCase() === 'src').flatMap((d) => cssUrls(d.value));
        fontFaces.push({ family, urls, declarations, line: closing.block.line });
      }
      segmentStart = i + 1;
      if (stack.length === 0) preludeStart = i + 1;
    }
  }
  return { tokens, fontFaces, declarations: all, tailwind, imports };
}

/** The URL an `@import` statement (whitespace collapsed) names, in its string or `url()` form; undefined for any other statement. */
function importUrl(statement: string): string | undefined {
  if (!statement.toLowerCase().startsWith('@import ')) return undefined;
  const rest = statement.slice('@import '.length);
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    const end = rest.indexOf(quote, 1);
    return end === -1 ? rest.slice(1) : rest.slice(1, end);
  }
  return rest.toLowerCase().startsWith('url(') ? cssUrls(rest)[0] : undefined;
}

const isNameChar = (code: number): boolean =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45 || code === 95;
// the longest function name a caller drops
const MAX_CALL_NAME = 8;

/** The index just past the string that opens at `start`, or the end of `text` when it never closes. */
function stringEnd(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i + 1;
  }
  return text.length;
}

/** The index just past the `)` that closes the `(` at `open`, strings and nested parentheses skipped, or the end of `text`. */
function callEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") i = stringEnd(text, i) - 1;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i + 1;
  }
  return text.length;
}

/**
 * `value` with each call of a function in `names` (lower case) taken out whole, its nested parentheses and strings included,
 * and with `strings` every other quoted string too; each is replaced by a space. One pass, linear in `value`.
 */
export function withoutCalls(value: string, names: ReadonlySet<string>, strings = false): string {
  let out = '';
  let copied = 0;
  let word = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '"' || ch === "'") {
      const end = stringEnd(value, i);
      if (strings) {
        out += `${value.slice(copied, i)} `;
        copied = end;
      }
      i = end - 1;
      word = end;
    } else if (ch === '(' && i - word <= MAX_CALL_NAME && names.has(value.slice(word, i).toLowerCase())) {
      const end = callEnd(value, i);
      out += `${value.slice(copied, word)} `;
      copied = end;
      i = end - 1;
      word = end;
    } else if (!isNameChar(value.charCodeAt(i))) {
      word = i + 1;
    }
  }
  return out + value.slice(copied);
}

/** The text after the last `;` in `text`, the prelude of a block nested in a declaration list. */
function lastStatement(text: string): string {
  const semicolon = text.lastIndexOf(';');
  return semicolon === -1 ? text : text.slice(semicolon + 1);
}
