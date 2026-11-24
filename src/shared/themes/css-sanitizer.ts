// A theme's custom CSS, cut to what may restyle its content areas (docs/invariants.md "Theme CSS and trusted regions").
// Pure: core, main and the renderers import it. Only css-tree's tokenizer, parser, walker and generator entries: the root
// entry loads the lexer's data through createRequire, which a bundled copy cannot run.
import parse from 'css-tree/parser';
import walk from 'css-tree/walker';
import generate from 'css-tree/generator';
import { tokenize, tokenTypes } from 'css-tree/tokenizer';
import type { Atrule, AttributeSelector, CssNode, Declaration, FunctionNode, MediaQuery, PseudoClassSelector, Rule, Selector } from 'css-tree';
import { isStillDataImage } from './data-image';
import { bundledFamily } from './fonts';
import { CSS_REGIONS, type CssRegion, type ThemeFile } from './schema';
import { isColorToken } from './tokens';
import {
  CSS_DROPPED_TEXT_CHARS, CSS_MAX_DATA_URL_CHARS, CSS_MAX_RULES, CSS_MAX_SELECTOR_CHARS, CSS_MIN_TEXT_ALPHA, CSS_REGION_LIMIT_BYTES, CSS_TOTAL_LIMIT_BYTES,
  type CssDropReason, type CssDroppedPart,
} from './css-types';

export {
  CSS_DROP_REASONS, CSS_MAX_DATA_URL_CHARS, CSS_MAX_RULES, CSS_MAX_SELECTOR_CHARS, CSS_REGION_LIMIT_BYTES, CSS_TOTAL_LIMIT_BYTES, type CssDropReason, type CssDroppedPart,
} from './css-types';

export interface SanitizedThemeCss {
  // each region's source with the dropped parts cut out: what core stores in theme.json
  readonly kept: Partial<Record<CssRegion, string>>;
  // each region's rules wrapped in the user layer and its scope: what a page paints
  readonly scoped: Partial<Record<CssRegion, string>>;
  // the first CSS_MAX_DROPPED dropped parts
  readonly dropped: readonly CssDroppedPart[];
  // how many more parts were dropped than `dropped` lists
  readonly droppedMore: number;
}

// Open blocks, functions, parentheses and brackets at any one point; the parser, walker and generator recurse once per level.
export const CSS_MAX_NESTING = 32;
export const CSS_MAX_DROPPED = 100;
// Comma-separated layers of one background or shadow declaration.
export const CSS_MAX_LAYERS = 8;

// Must match the protected layer's selectors in src/webview/style.css and the scope roots' attributes.
const SCOPE_LIMIT = '[data-trusted], [data-trusted-mark], .monaco-editor, .xterm';
// An unprefixed selector in @scope also matches the root, whose own shadow or outline would paint outside its paint clip.
const SCOPE_DESCENDANT = ':where(:scope) ';

/** The font families a theme's CSS may name besides Damocles' own tokens and the generic families: the ones its style declares. */
export function themeCssFamilies(theme: Pick<ThemeFile, 'style'>): string[] {
  return Object.values(theme.style?.fonts ?? {}).flatMap((choice) => {
    if (choice === undefined) return [];
    return ['installed' in choice ? choice.installed : bundledFamily(choice.asset, choice.family)];
  });
}

/**
 * Keeps what the allowlist admits of each region and lists the rest. Never throws, and one input has one answer. `scoped` is
 * regenerated from the kept source and painted only when it parses back into the nodes that were checked, so sanitizing `kept`
 * drops nothing and yields the same `scoped`; a region where that would not hold is dropped whole. The limits count `kept`.
 */
export function sanitizeThemeCss(css: Partial<Record<CssRegion, string | null>>, options: { readonly families: readonly string[] }): SanitizedThemeCss {
  const kept: Partial<Record<CssRegion, string>> = {};
  const scoped: Partial<Record<CssRegion, string>> = {};
  const dropped: CssDroppedPart[] = [];
  let droppedMore = 0;
  const families = new Set(options.families.map(asciiLower));
  let rules = CSS_MAX_RULES;
  let total = 0;
  for (const region of CSS_REGIONS) {
    const source = css[region];
    if (typeof source !== 'string' || source.trim() === '') continue;
    const result = sanitizeRegion(source, families, rules, CSS_TOTAL_LIMIT_BYTES - total);
    for (const part of result.drops) {
      if (dropped.length < CSS_MAX_DROPPED) dropped.push({ region, ...part });
      else droppedMore += 1;
    }
    if (result.kept === undefined) continue;
    rules -= result.rules;
    total += utf8Bytes(result.kept);
    kept[region] = result.kept;
    if (result.css !== '') scoped[region] = `@layer damocles-user { @scope ([data-theme-scope~="${region}"]) to (${SCOPE_LIMIT}) { ${result.css} } }`;
  }
  return { kept, scoped, dropped, droppedMore };
}

interface Drop { readonly reason: CssDropReason; readonly text: string; readonly line?: number }
interface Edit { readonly start: number; readonly end: number; readonly text: string }
type RegionResult = { readonly drops: readonly Drop[]; readonly kept?: undefined } | { readonly drops: readonly Drop[]; readonly kept: string; readonly css: string; readonly rules: number };

function sanitizeRegion(source: string, families: ReadonlySet<string>, rules: number, room: number): RegionResult {
  const whole = (reason: CssDropReason): RegionResult => ({ drops: [{ reason, text: excerpt(source) }] });
  if (utf8Bytes(source) > CSS_REGION_LIMIT_BYTES) return whole('regionTooLarge');
  if (tooDeep(source)) return whole('parseError');
  try {
    const first = analyze(source, families, rules);
    const cleaned = applyEdits(source, first.edits);
    if (cleaned.trim() === '') return { drops: first.drops };
    const bytes = utf8Bytes(cleaned);
    if (bytes > CSS_REGION_LIMIT_BYTES) return whole('regionTooLarge');
    if (bytes > room) return whole('totalTooLarge');
    const second = first.edits.length === 0 ? first : analyze(cleaned, families, Number.POSITIVE_INFINITY);
    if (second.drops.length > 0 || second.edits.length > 0) return whole('parseError');
    // The painted text must read back as the checked nodes and can never close its style element.
    const painted = analyze(second.plain, families, Number.POSITIVE_INFINITY);
    const same = painted.drops.length === 0 && painted.edits.length === 0 && painted.plain === second.plain && painted.signature === second.signature;
    if (!same || painted.scoped.includes('</')) return whole('parseError');
    return { drops: first.drops, kept: cleaned, css: painted.scoped, rules: second.rules };
  } catch {
    return whole('parseError');
  }
}

const CLOSERS: ReadonlyMap<number, number> = new Map([
  [tokenTypes.Function, tokenTypes.RightParenthesis],
  [tokenTypes.LeftParenthesis, tokenTypes.RightParenthesis],
  [tokenTypes.LeftSquareBracket, tokenTypes.RightSquareBracket],
  [tokenTypes.LeftCurlyBracket, tokenTypes.RightCurlyBracket],
]);

/** Whether `source` nests past CSS_MAX_NESTING. Reads tokens only, so its own work does not depend on the nesting. */
function tooDeep(source: string): boolean {
  const open: number[] = [];
  let deep = false;
  tokenize(source, (type) => {
    const closer = CLOSERS.get(type);
    if (closer !== undefined) {
      open.push(closer);
      if (open.length > CSS_MAX_NESTING) deep = true;
    } else if (open.length > 0 && open[open.length - 1] === type) open.pop();
  });
  return deep;
}

// What a kept part paints: its text, the same with every selector made a descendant of the scope root, and the nodes it was
// checked as, which the painted text must read back as.
interface Painted { readonly plain: string; readonly scoped: string; readonly signature: unknown }
interface Analysis { readonly drops: Drop[]; readonly edits: Edit[]; readonly plain: string; readonly scoped: string; readonly signature: string; readonly rules: number }

function analyze(source: string, families: ReadonlySet<string>, budget: number): Analysis {
  // css-tree does not throw on bad input: it keeps what it could not read as Raw nodes, which are dropped
  const ast = parse(source, { positions: true, parseCustomProperty: false });
  const ctx: Ctx = { source, families, rulesLeft: budget, rules: 0, drops: [], edits: [] };
  const out = ast.type === 'StyleSheet' ? block(ctx, ast.children.toArray(), undefined) : { plain: '', scoped: '', signature: [] };
  return { drops: ctx.drops, edits: ctx.edits, plain: out.plain, scoped: out.scoped, signature: JSON.stringify(out.signature), rules: ctx.rules };
}

interface Ctx {
  readonly source: string;
  readonly families: ReadonlySet<string>;
  rulesLeft: number;
  // the style rules kept
  rules: number;
  readonly drops: Drop[];
  readonly edits: Edit[];
}

const span = (node: CssNode): { start: number; end: number } => ({ start: node.loc?.start.offset ?? 0, end: node.loc?.end.offset ?? 0 });

function drop(ctx: Ctx, node: CssNode, reason: CssDropReason, text?: string): void {
  const { start, end } = span(node);
  ctx.drops.push({ reason, text: excerpt(text ?? ctx.source.slice(start, end)), ...(node.loc ? { line: node.loc.start.line } : {}) });
}

// A dropped part is cut up to the next part, so its semicolon and the space after it go with it, but never a comment.
function cut(ctx: Ctx, node: CssNode, to: number): void {
  const { start, end } = span(node);
  const comment = ctx.source.slice(end, to).indexOf('/*');
  ctx.edits.push({ start, end: comment < 0 ? Math.max(end, to) : end + comment, text: '' });
}

/** What a list of top-level or at-rule block children paints; `end` is the block's closing brace. */
function block(ctx: Ctx, children: CssNode[], end: number | undefined): Painted {
  let plain = '';
  let scoped = '';
  const signature: unknown[] = [];
  children.forEach((child, i) => {
    const next = children[i + 1];
    let out: Painted | undefined;
    switch (child.type) {
      case 'Comment':
      case 'CDO':
      case 'CDC':
        return;
      case 'Rule':
        out = rule(ctx, child);
        break;
      case 'Atrule':
        out = atrule(ctx, child);
        break;
      default:
        drop(ctx, child, 'parseError');
    }
    if (out === undefined) {
      cut(ctx, child, next ? span(next).start : end ?? span(child).end);
      return;
    }
    plain += out.plain;
    scoped += out.scoped;
    signature.push(out.signature);
  });
  return { plain, scoped, signature };
}

const blockEnd = (ctx: Ctx, node: CssNode): number => {
  const { end } = span(node);
  return ctx.source[end - 1] === '}' ? end - 1 : end;
};

function rule(ctx: Ctx, node: Rule): Painted | undefined {
  if (node.prelude.type !== 'SelectorList') {
    drop(ctx, node, 'parseError');
    return undefined;
  }
  const items = node.prelude.children.toArray();
  const keptItems: Array<Canonical & { readonly source: string }> = [];
  for (const item of items) {
    if (item.type !== 'Selector') {
      drop(ctx, item, 'parseError');
      continue;
    }
    const reason = selectorReason(item);
    const written = reason === undefined ? canonical(item) : undefined;
    if (reason !== undefined) drop(ctx, item, reason);
    else if (written === undefined) drop(ctx, item, 'parseError');
    else if (written.text.length > CSS_MAX_SELECTOR_CHARS) drop(ctx, item, 'selectorTooLong');
    else keptItems.push({ ...written, source: ctx.source.slice(span(item).start, span(item).end) });
  }
  if (keptItems.length === 0) return undefined;
  if (ctx.rulesLeft <= 0) {
    drop(ctx, node, 'tooManyRules', ctx.source.slice(span(node).start, span(node.block).start));
    return undefined;
  }
  ctx.rulesLeft -= 1;
  ctx.rules += 1;
  // joined without a space, so the kept source is never longer than what it was cut from
  if (keptItems.length < items.length) ctx.edits.push({ ...span(node.prelude), text: keptItems.map((item) => item.source).join(',') });
  const children = node.block.children.toArray();
  const declarations: Canonical[] = [];
  children.forEach((child, i) => {
    const next = children[i + 1];
    // an empty declaration (`;;`) is nothing to Chromium either
    if (child.type === 'Comment' || (child.type === 'Raw' && /^[\s;]*$/.test(child.value))) return;
    const out = child.type === 'Declaration' ? declaration(ctx, child) : undefined;
    if (out !== undefined) {
      declarations.push(out);
      return;
    }
    if (child.type !== 'Declaration') drop(ctx, child, child.type === 'Raw' && !child.value.includes('{') ? 'parseError' : 'nestedRule');
    cut(ctx, child, next ? span(next).start : blockEnd(ctx, node.block));
  });
  const body = `{${declarations.map((item) => item.text).join(';')}}`;
  return {
    plain: `${keptItems.map((item) => item.text).join(',')}${body}`,
    scoped: `${keptItems.map((item) => `${SCOPE_DESCENDANT}${item.text}`).join(',')}${body}`,
    signature: ['rule', keptItems.map((item) => item.signature), declarations.map((item) => item.signature)],
  };
}

function atrule(ctx: Ctx, node: Atrule): Painted | undefined {
  const name = asciiLower(decodeCssEscapes(node.name));
  const prelude = node.prelude;
  const head = (): string => ctx.source.slice(span(node).start, node.block ? span(node.block).start : span(node).end);
  if ((name !== 'media' && name !== 'supports' && name !== 'container') || node.block === null) {
    drop(ctx, node, 'atRule', head());
    return undefined;
  }
  const reason = prelude === null || prelude.type === 'Raw' ? 'parseError' : preludeReason(prelude) ?? (name === 'media' && !mediaAllowed(prelude) ? 'mediaFeature' : undefined);
  const written = reason === undefined && prelude !== null ? canonical(prelude) : undefined;
  if (written === undefined) {
    drop(ctx, node, reason ?? 'parseError', head());
    return undefined;
  }
  const inner = block(ctx, node.block.children.toArray(), blockEnd(ctx, node.block));
  return {
    plain: `@${name} ${written.text}{${inner.plain}}`,
    scoped: `@${name} ${written.text}{${inner.scoped}}`,
    signature: ['at', name, written.signature, inner.signature],
  };
}

// A condition is only tested, never painted, yet the page receives its text: nothing unread and no URL may ride in it.
function preludeReason(prelude: CssNode): CssDropReason | undefined {
  let reason: CssDropReason | undefined;
  walk(prelude, (child) => {
    if (child.type === 'Raw' || child.type === 'GeneralEnclosed') reason ??= 'parseError';
    else if (child.type === 'Url' || (child.type === 'Function' && URL_FUNCTIONS.has(fnName(child)))) reason ??= 'url';
  });
  return reason;
}

const MEDIA_FEATURES: ReadonlySet<string> = new Set(['prefers-reduced-motion', 'prefers-contrast', 'forced-colors', 'hover', 'pointer']);
const MEDIA_TYPES: ReadonlySet<string> = new Set(['all', 'screen', 'print']);

function mediaAllowed(prelude: CssNode): boolean {
  let ok = true;
  walk(prelude, (node) => {
    switch (node.type) {
      case 'AtrulePrelude':
      case 'MediaQueryList':
      case 'Condition':
      case 'Identifier':
        return;
      case 'MediaQuery': {
        const type = (node as MediaQuery).mediaType;
        if (type !== null && !MEDIA_TYPES.has(asciiLower(decodeCssEscapes(type)))) ok = false;
        return;
      }
      case 'Feature':
        if (!MEDIA_FEATURES.has(asciiLower(decodeCssEscapes(node.name))) || (node.value !== null && node.value.type !== 'Identifier')) ok = false;
        return;
      default:
        ok = false;
    }
  });
  return ok;
}

const BANNED_TYPES: ReadonlySet<string> = new Set(['html', 'body']);
// The pseudo-classes of Selectors Level 4 that take no argument and that Chromium reads, sorted. `:root` and `:scope` are
// left out on purpose, as `:host`, `:host-context()` and `:has()` are below: each reaches outside the content. Chromium
// ignores a whole rule for one name it does not read, so a name is added only with a run of themes-css-safety.spec.ts.
export const ALLOWED_CSS_PSEUDO_CLASSES: readonly string[] = [
  'active', 'any-link', 'autofill', 'checked', 'default', 'defined', 'disabled', 'empty', 'enabled', 'first-child', 'first-of-type', 'focus', 'focus-visible',
  'focus-within', 'fullscreen', 'hover', 'in-range', 'indeterminate', 'invalid', 'last-child', 'last-of-type', 'link', 'modal', 'only-child', 'only-of-type',
  'open', 'optional', 'out-of-range', 'picture-in-picture', 'placeholder-shown', 'popover-open', 'read-only', 'read-write', 'required', 'target', 'user-invalid',
  'user-valid', 'valid', 'visited',
];
const PLAIN_PSEUDO_CLASSES: ReadonlySet<string> = new Set(ALLOWED_CSS_PSEUDO_CLASSES);
// The functional ones, by what Chromium takes as the argument: a selector list, An+B with an optional `of` selector list,
// An+B alone, or one identifier (it refuses a string and a list in `:lang()`).
const PSEUDO_CLASS_FUNCTIONS: ReadonlyMap<string, 'selectors' | 'nthOf' | 'nth' | 'identifier'> = new Map([
  ['is', 'selectors'], ['where', 'selectors'], ['not', 'selectors'],
  ['nth-child', 'nthOf'], ['nth-last-child', 'nthOf'], ['nth-of-type', 'nth'], ['nth-last-of-type', 'nth'],
  ['dir', 'identifier'], ['lang', 'identifier'],
] as const);
// Chromium reads these four with one colon as the pseudo-elements they were in CSS 2.
const LEGACY_PSEUDO_ELEMENTS: ReadonlySet<string> = new Set(['before', 'after', 'first-line', 'first-letter']);
const ALLOWED_PSEUDO_ELEMENTS: ReadonlySet<string> = new Set(['selection', 'placeholder', 'marker']);
const BANNED_CLASS_PREFIXES = ['monaco', 'mtk', 'view-line', 'xterm'] as const;
const BANNED_ATTRIBUTE_PREFIXES = ['data-theme-scope', 'data-trusted'] as const;
const COMBINATORS: ReadonlySet<string> = new Set([' ', '>', '+', '~']);

/**
 * A type or attribute name as written, split at its namespace bar (`svg|a`, `*|html`, `|a`). No namespace can be declared
 * here, so Chromium voids a whole rule for any prefix but `*` and the empty one: `allowed` is false for those.
 */
function qualified(raw: string): { readonly allowed: boolean; readonly prefix: string; readonly local: string } {
  let bar = -1;
  for (let at = 0; at < raw.length && bar < 0; at += 1) {
    if (raw[at] === '\\') at += 1;
    else if (raw[at] === '|') bar = at;
  }
  if (bar < 0) return { allowed: true, prefix: '', local: raw };
  const prefix = raw.slice(0, bar + 1);
  return { allowed: prefix === '|' || prefix === '*|', prefix, local: raw.slice(bar + 1) };
}

const localName = (raw: string): string => asciiLower(decodeCssEscapes(qualified(raw).local));

// An empty `:is()` or `:where()` is refused too, though Chromium reads it: it is what Chromium makes of an argument it cut.
function pseudoClassAllowed(node: PseudoClassSelector): boolean {
  const name = asciiLower(decodeCssEscapes(node.name));
  if (node.children === null) return PLAIN_PSEUDO_CLASSES.has(name);
  const takes = PSEUDO_CLASS_FUNCTIONS.get(name);
  const argument = node.children.size === 1 ? node.children.first : null;
  if (takes === undefined || argument === null) return false;
  if (takes === 'selectors') return argument.type === 'SelectorList' && !argument.children.isEmpty;
  if (takes === 'identifier') return argument.type === 'Identifier';
  if (argument.type !== 'Nth') return false;
  return argument.selector === null || (takes === 'nthOf' && argument.selector.type === 'SelectorList' && !argument.selector.children.isEmpty);
}

function selectorReason(selector: Selector): CssDropReason | undefined {
  let reason: CssDropReason | undefined;
  const fail = (next: CssDropReason): void => {
    reason ??= next;
  };
  // how many functional pseudo-classes hold the node: Chromium reads a pseudo-element only outside every one
  let nested = 0;
  const leave = (node: CssNode): void => {
    if (node.type === 'PseudoClassSelector') nested -= 1;
  };
  const enter = (node: CssNode): void => {
    switch (node.type) {
      case 'SelectorList':
      case 'IdSelector':
      case 'Nth':
      case 'AnPlusB':
      case 'Identifier':
      case 'String':
        return;
      case 'Selector': {
        // A leading combinator is relative to the scope root inside @scope, and `+ p` or `~ p` would name the root's siblings.
        // A type selector anywhere but first in its compound is two names css-tree read where Chromium reads none.
        // Chromium reads nothing after a pseudo-element but `:window-inactive`, which no specification names.
        let first = true;
        let open = true;
        let ended = false;
        node.children.forEach((child) => {
          const combinator = child.type === 'Combinator';
          if ((combinator && open) || (child.type === 'TypeSelector' && !first)) fail('selector');
          if (ended) fail('selector');
          first = combinator;
          open = combinator;
          ended = child.type === 'PseudoElementSelector';
        });
        if (open) fail('selector');
        return;
      }
      case 'Combinator':
        if (!COMBINATORS.has(node.name)) fail('selector');
        return;
      case 'TypeSelector':
        if (!qualified(node.name).allowed || BANNED_TYPES.has(localName(node.name))) fail('selector');
        return;
      case 'ClassSelector': {
        const name = asciiLower(decodeCssEscapes(node.name));
        if (BANNED_CLASS_PREFIXES.some((prefix) => name.startsWith(prefix))) fail('selector');
        return;
      }
      case 'AttributeSelector':
        if (attributeBanned(node)) fail('selector');
        return;
      case 'PseudoClassSelector': {
        nested += 1;
        if (LEGACY_PSEUDO_ELEMENTS.has(asciiLower(decodeCssEscapes(node.name)))) fail('pseudoElement');
        else if (!pseudoClassAllowed(node)) fail('selector');
        return;
      }
      case 'PseudoElementSelector':
        if (!ALLOWED_PSEUDO_ELEMENTS.has(asciiLower(decodeCssEscapes(node.name))) || node.children !== null) fail('pseudoElement');
        else if (nested > 0) fail('selector');
        return;
      default:
        fail(node.type === 'Raw' ? 'parseError' : 'selector');
    }
  };
  walk(selector, { enter, leave });
  return reason;
}

// Any `class` attribute selector is dropped: a substring match (`[class*="onaco"]`) reaches the classes the selector bans.
// css-tree reads a second name with no matcher before it as flags (`[data-t\72/**/usted]`), which Chromium reads as the name.
function attributeBanned(node: AttributeSelector): boolean {
  const name = localName(node.name.name);
  if (!qualified(node.name.name).allowed || name === 'class' || BANNED_ATTRIBUTE_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  return node.flags !== null && (node.matcher === null || !ATTRIBUTE_FLAGS.has(asciiLower(decodeCssEscapes(node.flags))));
}

const ATTRIBUTE_FLAGS: ReadonlySet<string> = new Set(['i', 's']);

function declaration(ctx: Ctx, node: Declaration): Canonical | undefined {
  const property = asciiLower(decodeCssEscapes(node.property));
  const check = PROPERTIES.get(property);
  // css-tree keeps any other spelling of `!important` as the word itself; Chromium folds its case and drops anything else
  const important = node.important === true || (typeof node.important === 'string' && asciiLower(decodeCssEscapes(node.important)) === 'important');
  const nodes = node.value.type === 'Raw' ? [] : node.value.children.toArray().filter((child) => child.type !== 'WhiteSpace');
  let reason: CssDropReason | undefined;
  if (check === undefined) reason = 'property';
  // Chromium discards a declaration with no value
  else if (nodes.length === 0 || (typeof node.important === 'string' && !important)) reason = 'parseError';
  else reason = check(nodes, ctx.families);
  const written = reason === undefined ? canonical(node.value) : undefined;
  if (written === undefined) {
    drop(ctx, node, reason ?? 'parseError');
    return undefined;
  }
  // !important is kept: a theme rule needs it against inline styles, and it still loses to an earlier layer's `!important`, the protected layer's first
  return { text: `${property}:${written.text}${important ? '!important' : ''}`, signature: ['declaration', property, important, written.signature] };
}

interface Canonical { readonly text: string; readonly signature: unknown }

// The fields css-tree keeps as written that hold an identifier.
const NAME_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Identifier: ['name'], ClassSelector: ['name'], IdSelector: ['name'], PseudoClassSelector: ['name'], PseudoElementSelector: ['name'],
  Function: ['name'], Feature: ['name'], FeatureFunction: ['feature'], MediaQuery: ['modifier', 'mediaType'], Declaration: ['property'],
};
// Nodes whose own fields are punctuation and numbers, which hold no escape.
const PLAIN_NODES: ReadonlySet<string> = new Set([
  'Selector', 'SelectorList', 'Combinator', 'Nth', 'AnPlusB', 'Value', 'Number', 'Percentage', 'Hash', 'Operator', 'WhiteSpace',
  'AtrulePrelude', 'MediaQueryList', 'Condition', 'FeatureRange', 'SupportsDeclaration', 'Ratio', 'Parentheses', 'Brackets',
]);

/**
 * A checked selector, value or at-rule condition as a page gets it, or undefined when it holds a node this does not know.
 * css-tree keeps names as written and its generator spaces two names apart, which after a hex escape joins them (`n\6f ne` is
 * `none`), so every name is written again from its decoded value: the names painted are the names that were checked.
 */
function canonical(root: CssNode): Canonical | undefined {
  let known = true;
  const stack: unknown[][] = [[]];
  const attributeNames = new Set<CssNode>();
  walk(root, {
    enter(node: CssNode) {
      const entry: unknown[] = [node.type];
      stack[stack.length - 1]!.push(entry);
      stack.push(entry);
      if (!canonicalNode(node, attributeNames)) known = false;
      for (const [key, value] of Object.entries(node)) {
        if (key !== 'type' && key !== 'loc' && (value === null || typeof value !== 'object')) entry.push(key, value);
      }
    },
    leave() {
      stack.pop();
    },
  });
  return known ? { text: generate(root), signature: stack[0] } : undefined;
}

function canonicalNode(node: CssNode, attributeNames: Set<CssNode>): boolean {
  const fields = node as unknown as Record<string, unknown>;
  switch (node.type) {
    case 'TypeSelector': {
      const { prefix, local } = qualified(node.name);
      node.name = `${prefix}${local === '*' ? local : serializeIdentifier(decodeCssEscapes(local))}`;
      return true;
    }
    case 'AttributeSelector': {
      const { prefix, local } = qualified(node.name.name);
      node.name.name = `${prefix}${serializeIdentifier(decodeCssEscapes(local))}`;
      attributeNames.add(node.name);
      if (node.flags !== null) node.flags = asciiLower(decodeCssEscapes(node.flags));
      return true;
    }
    case 'Identifier':
      if (!attributeNames.has(node)) node.name = serializeIdentifier(decodeCssEscapes(node.name));
      return true;
    case 'String':
      Object.assign(node, { type: 'Raw', value: serializeString(node.value) });
      return true;
    case 'Url':
      Object.assign(node, { type: 'Raw', value: `url(${serializeString(node.value)})` });
      return true;
    case 'Dimension': {
      // any other unit is no CSS unit, and one of digits would read back as part of the number
      const unit = decodeCssEscapes(node.unit);
      node.unit = unit;
      return /^[A-Za-z]+$/.test(unit);
    }
    default:
  }
  if (node.type === 'Declaration' && typeof node.important === 'string') return false;
  const names = NAME_FIELDS[node.type];
  if (names === undefined) return PLAIN_NODES.has(node.type) && !Object.values(fields).some((value) => typeof value === 'string' && value.includes('\\'));
  for (const key of names) if (typeof fields[key] === 'string') fields[key] = serializeIdentifier(decodeCssEscapes(fields[key]));
  return true;
}

/** CSSOM's "serialize an identifier": the one spelling of a name, which reads back as that name whatever follows it. */
function serializeIdentifier(name: string): string {
  const chars = [...name];
  let out = '';
  chars.forEach((char, at) => {
    const code = char.codePointAt(0)!;
    const digit = code >= 0x30 && code <= 0x39;
    if (code === 0) out += '\uFFFD';
    else if (code <= 0x1f || code === 0x7f || (digit && (at === 0 || (at === 1 && chars[0] === '-')))) out += `\\${code.toString(16)} `;
    else if (at === 0 && char === '-' && chars.length === 1) out += '\\-';
    else if (code >= 0x80 || digit || char === '-' || char === '_' || /^[A-Za-z]$/.test(char)) out += char;
    else out += `\\${char}`;
  });
  return out;
}

/** CSSOM's "serialize a string", with `</` written `<\/`, the same text, so no string or url can close a style element. */
function serializeString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code === 0) out += '\uFFFD';
    else if (code <= 0x1f || code === 0x7f) out += `\\${code.toString(16)} `;
    else if (char === '"' || char === '\\') out += `\\${char}`;
    else out += char;
  }
  return `${out}"`.replace(/<\//g, '<\\/');
}

type ValueCheck = (nodes: CssNode[], families: ReadonlySet<string>) => CssDropReason | undefined;

const CSS_WIDE: ReadonlySet<string> = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
const ident = (node: CssNode | undefined): string | undefined => (node?.type === 'Identifier' ? asciiLower(decodeCssEscapes(node.name)) : undefined);
const fnName = (node: FunctionNode): string => asciiLower(decodeCssEscapes(node.name));
const num = (raw: string): number => Number(raw);

// px per unit; font-relative units count as their largest likely size so a bound in rem also holds for them.
const LENGTH_PX: Readonly<Record<string, number>> = {
  px: 1, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, in: 96, pc: 16, pt: 4 / 3,
  em: 16, rem: 16, ex: 16, rex: 16, ch: 16, rch: 16, cap: 16, rcap: 16, ic: 16, ric: 16, lh: 40, rlh: 40,
};
const TIME_MS: Readonly<Record<string, number>> = { s: 1000, ms: 1 };
const ANGLE_DEG: Readonly<Record<string, number>> = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };

/** A length in px; undefined for anything that is not one (viewport and container units included). */
function lengthPx(node: CssNode): number | undefined {
  if (node.type === 'Number') return num(node.value) === 0 ? 0 : undefined;
  if (node.type !== 'Dimension') return undefined;
  const factor = LENGTH_PX[asciiLower(decodeCssEscapes(node.unit))];
  return factor === undefined ? undefined : num(node.value) * factor;
}

function timeMs(node: CssNode): number | undefined {
  if (node.type !== 'Dimension') return undefined;
  const factor = TIME_MS[asciiLower(decodeCssEscapes(node.unit))];
  return factor === undefined ? undefined : num(node.value) * factor;
}

interface Grammar {
  // inclusive px bounds of every length; no lengths when absent
  readonly lengths?: { readonly min: number; readonly max: number };
  readonly percentMax?: number;
  // any length, percentage or angle, unbounded (backgrounds)
  readonly anyDimension?: boolean;
  readonly idents?: ReadonlySet<string> | 'any';
  readonly bannedIdents?: ReadonlySet<string>;
  readonly colors?: boolean;
  readonly images?: boolean;
  readonly operators?: string;
  readonly angles?: { readonly min: number; readonly max: number };
  // the most comma-separated layers; unbounded when absent
  readonly layers?: number;
}

const COLOR_FUNCTIONS: ReadonlySet<string> = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark']);
const GRADIENTS: ReadonlySet<string> = new Set(['linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient']);
const EASING_FUNCTIONS: ReadonlySet<string> = new Set(['cubic-bezier', 'steps', 'linear']);
const URL_FUNCTIONS: ReadonlySet<string> = new Set(['url', 'src']);
// Color tokens a palette paints translucent (tints, scrims; a pane at alpha 00 under a wallpaper): never a text color.
const TRANSLUCENT_TOKEN = /^--d-(?:pane-[a-z]+|accent-soft|add|del|scrim)$/;

/**
 * A var() naming one of Damocles' color tokens, with no fallback: a fallback is never parsed, so it could hide anything. A
 * var() is valid wherever it stands until it is computed, so the token is what is typed: a color in a length's place paints
 * nothing, where a length token would pass every length bound.
 */
function tokenVar(node: FunctionNode, allowed: (name: string) => boolean = isColorToken): boolean {
  const args = node.children.toArray().filter((child) => child.type !== 'WhiteSpace');
  return args.length === 1 && args[0]?.type === 'Identifier' && allowed(decodeCssEscapes(args[0].name));
}

// Every node of a value the grammar admits; nested functions are checked through the same rules.
function checkNodes(nodes: readonly CssNode[], grammar: Grammar): CssDropReason | undefined {
  for (const node of nodes) {
    const reason = checkNode(node, grammar);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

function checkNode(node: CssNode, grammar: Grammar): CssDropReason | undefined {
  switch (node.type) {
    case 'WhiteSpace':
      return undefined;
    case 'Identifier': {
      const name = ident(node)!;
      if (grammar.bannedIdents?.has(name)) return 'valueOutOfRange';
      if (grammar.idents === 'any' || grammar.idents?.has(name) || grammar.colors) return undefined;
      return 'valueOutOfRange';
    }
    case 'Number':
    case 'Dimension': {
      if (grammar.anyDimension) return undefined;
      const px = lengthPx(node);
      if (px !== undefined && grammar.lengths) return px >= grammar.lengths.min && px <= grammar.lengths.max ? undefined : 'valueOutOfRange';
      if (node.type === 'Dimension' && grammar.angles) {
        const factor = ANGLE_DEG[asciiLower(decodeCssEscapes(node.unit))];
        const deg = factor === undefined ? undefined : num(node.value) * factor;
        return deg !== undefined && deg >= grammar.angles.min && deg <= grammar.angles.max ? undefined : 'valueOutOfRange';
      }
      return 'valueOutOfRange';
    }
    case 'Percentage':
      if (grammar.anyDimension) return undefined;
      return grammar.percentMax !== undefined && num(node.value) >= 0 && num(node.value) <= grammar.percentMax ? undefined : 'valueOutOfRange';
    case 'Hash':
      return grammar.colors && HEX_COLOR.test(node.value) ? undefined : 'valueOutOfRange';
    case 'Operator':
      return grammar.operators?.includes(node.value) ? undefined : 'valueOutOfRange';
    case 'Url':
      return grammar.images && node.value.length <= CSS_MAX_DATA_URL_CHARS && isStillDataImage(node.value) ? undefined : 'url';
    case 'Function': {
      const name = fnName(node);
      if (URL_FUNCTIONS.has(name)) return 'url';
      if (name === 'var') return grammar.colors && tokenVar(node) ? undefined : 'function';
      if (grammar.colors && COLOR_FUNCTIONS.has(name)) return checkNodes(node.children.toArray(), COLOR_ARGS);
      if (grammar.images && GRADIENTS.has(name)) return checkNodes(node.children.toArray(), COLOR_ARGS);
      return 'function';
    }
    case 'Raw':
      return 'parseError';
    default:
      return 'valueOutOfRange';
  }
}

const HEX_COLOR = /^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// Channel values, keywords of relative and mixed colors (from, in, r, none, srgb, ...), nested colors and token vars; a
// gradient's arguments are the same.
const COLOR_ARGS: Grammar = { anyDimension: true, idents: 'any', colors: true, operators: ',/' };

/** The alpha a color value paints with, as far as the source fixes it; undefined when it cannot be told. */
function alphaOf(node: CssNode | undefined): number | undefined {
  if (node === undefined) return undefined;
  switch (node.type) {
    case 'Identifier':
      return ident(node) === 'transparent' ? 0 : 1;
    case 'Hash': {
      const hex = node.value;
      if (!HEX_COLOR.test(hex)) return undefined;
      if (hex.length === 4) return parseInt(hex[3]! + hex[3]!, 16) / 255;
      if (hex.length === 8) return parseInt(hex.slice(6), 16) / 255;
      return 1;
    }
    case 'Function':
      return functionAlpha(node);
    default:
      return undefined;
  }
}

const alphaValue = (node: CssNode | undefined, origin: number | undefined): number | undefined => {
  if (node?.type === 'Number') return Math.min(1, Math.max(0, num(node.value)));
  if (node?.type === 'Percentage') return Math.min(1, Math.max(0, num(node.value) / 100));
  if (node?.type === 'Identifier') return ident(node) === 'alpha' ? origin : ident(node) === 'none' ? 0 : undefined;
  return undefined;
};

function splitCommas(nodes: readonly CssNode[]): CssNode[][] {
  const groups: CssNode[][] = [[]];
  for (const node of nodes) {
    if (node.type === 'Operator' && node.value === ',') groups.push([]);
    else if (node.type !== 'WhiteSpace') groups[groups.length - 1]!.push(node);
  }
  return groups;
}

function functionAlpha(node: FunctionNode): number | undefined {
  const name = fnName(node);
  const args = node.children.toArray().filter((child) => child.type !== 'WhiteSpace');
  if (name === 'var') return tokenVar(node, (token) => isColorToken(token) && !TRANSLUCENT_TOKEN.test(token)) ? 1 : undefined;
  if (name === 'light-dark') {
    const [a, b, ...rest] = splitCommas(args);
    if (rest.length > 0 || a?.length !== 1 || b?.length !== 1) return undefined;
    const alphas = [alphaOf(a[0]), alphaOf(b[0])];
    return alphas.some((alpha) => alpha === undefined) ? undefined : Math.min(...(alphas as number[]));
  }
  if (name === 'color-mix') return mixAlpha(args);
  if (!COLOR_FUNCTIONS.has(name)) return undefined;
  let origin: number | undefined;
  let channels = args;
  if (ident(args[0]) === 'from') {
    origin = alphaOf(args[1]);
    if (origin === undefined) return undefined;
    channels = args.slice(2);
  }
  const slash = channels.findIndex((child) => child.type === 'Operator' && child.value === '/');
  if (slash >= 0) return channels.length === slash + 2 ? alphaValue(channels[slash + 1], origin) : undefined;
  const commas = splitCommas(channels);
  if (commas.length === 4) return commas[3]!.length === 1 ? alphaValue(commas[3]![0], origin) : undefined;
  return origin ?? 1;
}

// color-mix(in <space>, a p1?, b p2?): alpha mixes by the normalized weights, scaled down when they sum below 100%.
function mixAlpha(args: readonly CssNode[]): number | undefined {
  const [method, ...parts] = splitCommas(args);
  if (ident(method?.[0]) !== 'in' || parts.length !== 2) return undefined;
  const mixed = parts.map((part) => {
    const colors = part.filter((child) => child.type !== 'Percentage');
    const weights = part.filter((child) => child.type === 'Percentage');
    if (colors.length !== 1 || weights.length > 1) return undefined;
    return { alpha: alphaOf(colors[0]), weight: weights[0]?.type === 'Percentage' ? num(weights[0].value) : undefined };
  });
  const [a, b] = mixed;
  if (a?.alpha === undefined || b?.alpha === undefined) return undefined;
  const wa = a.weight ?? (b.weight === undefined ? 50 : 100 - b.weight);
  const wb = b.weight ?? 100 - wa;
  const sum = wa + wb;
  if (sum <= 0 || wa < 0 || wb < 0) return undefined;
  return ((a.alpha * wa + b.alpha * wb) / sum) * Math.min(1, sum / 100);
}

const wide = (nodes: readonly CssNode[]): boolean => nodes.length === 1 && CSS_WIDE.has(ident(nodes[0]) ?? '');
const grammar = (rules: Grammar): ValueCheck => (nodes) => {
  if (wide(nodes)) return undefined;
  if (rules.layers !== undefined && splitCommas(nodes).length > rules.layers) return 'valueOutOfRange';
  return checkNodes(nodes, rules);
};
const keywords = (...names: string[]): ValueCheck => grammar({ idents: new Set(names) });
const anyKeywords: ValueCheck = grammar({ idents: 'any' });

const textColor: ValueCheck = (nodes) => {
  if (wide(nodes)) return undefined;
  if (nodes.length !== 1) return 'valueOutOfRange';
  const shape = checkNode(nodes[0]!, { colors: true });
  if (shape !== undefined) return shape;
  const alpha = alphaOf(nodes[0]);
  return alpha !== undefined && alpha >= CSS_MIN_TEXT_ALPHA ? undefined : 'colorAlpha';
};
const anyColor: ValueCheck = grammar({ colors: true });
const BORDER_PX = 4;
const borderWidth = grammar({ lengths: { min: 0, max: BORDER_PX }, idents: new Set(['thin', 'medium']) });
// thick is 5px in Chromium, above the border bound
const borderLine = grammar({ lengths: { min: 0, max: BORDER_PX }, colors: true, bannedIdents: new Set(['thick']) });
const radius = grammar({ lengths: { min: 0, max: 32 }, percentMax: 50, operators: '/' });
const spacing = grammar({ lengths: { min: 0, max: 64 } });
const margin = grammar({ lengths: { min: 0, max: 64 }, idents: new Set(['auto']) });
const gap = grammar({ lengths: { min: 0, max: 64 }, idents: new Set(['normal']) });
const shadow = grammar({ lengths: { min: -24, max: 24 }, colors: true, operators: ',', layers: CSS_MAX_LAYERS });
const background = grammar({ anyDimension: true, idents: 'any', colors: true, images: true, operators: ',/', layers: CSS_MAX_LAYERS });
const outlineOffset = grammar({ lengths: { min: -BORDER_PX, max: BORDER_PX } });

const lineHeight: ValueCheck = (nodes) => {
  if (wide(nodes) || (nodes.length === 1 && ident(nodes[0]) === 'normal')) return undefined;
  const value = nodes.length === 1 ? nodes[0] : undefined;
  return value?.type === 'Number' && num(value.value) >= 1 && num(value.value) <= 2.5 ? undefined : 'valueOutOfRange';
};

// 0.2em at the 16px em the length bounds count with
const letterSpacing = grammar({ lengths: { min: -3.2, max: 3.2 }, idents: new Set(['normal']) });

const fontWeight: ValueCheck = (nodes) => {
  if (wide(nodes)) return undefined;
  const value = nodes.length === 1 ? nodes[0] : undefined;
  if (value?.type === 'Number') return num(value.value) >= 1 && num(value.value) <= 1000 ? undefined : 'valueOutOfRange';
  return checkNodes(nodes, { idents: new Set(['normal', 'bold', 'bolder', 'lighter']) }) ?? (nodes.length === 1 ? undefined : 'valueOutOfRange');
};

const fontStyle = grammar({ idents: new Set(['normal', 'italic', 'oblique']), angles: { min: -90, max: 90 } });

const fontFeatureSettings: ValueCheck = (nodes) => {
  if (wide(nodes) || (nodes.length === 1 && ident(nodes[0]) === 'normal')) return undefined;
  for (const group of splitCommas(nodes)) {
    const [tag, value, ...rest] = group;
    if (tag?.type !== 'String' || !/^[\x20-\x7e]{4}$/.test(tag.value) || rest.length > 0) return 'valueOutOfRange';
    if (value === undefined) continue;
    const ok = value.type === 'Number' ? Number.isInteger(num(value.value)) && num(value.value) >= 0 : ['on', 'off'].includes(ident(value) ?? '');
    if (!ok) return 'valueOutOfRange';
  }
  return undefined;
};

const GENERIC_FAMILIES: ReadonlySet<string> = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong']);

const fontFamily: ValueCheck = (nodes, families) => {
  if (wide(nodes)) return undefined;
  for (const group of splitCommas(nodes)) {
    const [first] = group;
    if (group.length === 1 && first?.type === 'Function') {
      if (fnName(first) === 'var' && tokenVar(first, (name) => name === '--d-font' || name === '--d-mono')) continue;
      return 'fontFamily';
    }
    if (group.length === 1 && first?.type === 'String') {
      if (families.has(asciiLower(first.value))) continue;
      return 'fontFamily';
    }
    if (group.length === 0 || !group.every((node) => node.type === 'Identifier')) return 'fontFamily';
    const name = group.map((node) => decodeCssEscapes((node as { name: string }).name)).join(' ');
    if (group.length === 1 && GENERIC_FAMILIES.has(asciiLower(name))) continue;
    if (!families.has(asciiLower(name))) return 'fontFamily';
  }
  return undefined;
};

const decorationThickness = grammar({ lengths: { min: 0, max: BORDER_PX }, idents: new Set(['auto', 'from-font']) });
const textDecoration = grammar({ lengths: { min: 0, max: BORDER_PX }, colors: true });
const cursor: ValueCheck = grammar({ idents: 'any', bannedIdents: new Set(['none']) });

// Properties a transition may animate: colors only.
const COLOR_PROPERTIES: ReadonlySet<string> = new Set([
  'color', 'background-color', 'border-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-block-color', 'border-inline-color', 'border-block-start-color', 'border-block-end-color', 'border-inline-start-color',
  'border-inline-end-color', 'outline-color', 'text-decoration-color', 'caret-color', 'accent-color', 'fill', 'stroke',
]);
const EASING_KEYWORDS: ReadonlySet<string> = new Set(['ease', 'linear', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end']);
const MAX_TRANSITION_MS = 300;

const easing = (node: CssNode): boolean => {
  if (node.type === 'Identifier') return EASING_KEYWORDS.has(ident(node)!);
  if (node.type !== 'Function' || !EASING_FUNCTIONS.has(fnName(node))) return false;
  return checkNodes(node.children.toArray(), { anyDimension: true, idents: new Set(['jump-start', 'jump-end', 'jump-none', 'jump-both', 'start', 'end']), operators: ',' }) === undefined;
};
const time = (node: CssNode): boolean => {
  const ms = timeMs(node);
  return ms !== undefined && ms >= 0 && ms <= MAX_TRANSITION_MS;
};

// Only the shorthand: it sets the property with the times, where a longhand alone leaves the property at `all` and the
// longhands of two rules combine. inherit, revert and revert-layer could bring in the app's own transition of every property.
const TRANSITION_KEYWORDS: ReadonlySet<string> = new Set(['none', 'initial', 'unset']);
const transition: ValueCheck = (nodes) => {
  if (nodes.length === 1 && TRANSITION_KEYWORDS.has(ident(nodes[0]) ?? '')) return undefined;
  for (const group of splitCommas(nodes)) {
    let property = 0;
    let times = 0;
    for (const node of group) {
      if (node.type === 'Identifier' && COLOR_PROPERTIES.has(ident(node)!)) property += 1;
      else if (node.type === 'Dimension' && time(node)) times += 1;
      else if (node.type === 'Function' && !EASING_FUNCTIONS.has(fnName(node))) return 'function';
      else if (!easing(node)) return 'valueOutOfRange';
    }
    // without a property the transition animates all
    if (property !== 1 || times > 2) return 'valueOutOfRange';
  }
  return undefined;
};

const sides = (base: string, suffix = ''): string[] => [
  `${base}${suffix}`,
  ...['top', 'right', 'bottom', 'left', 'block', 'inline', 'block-start', 'block-end', 'inline-start', 'inline-end'].map((side) => `${base}-${side}${suffix}`),
];

// The allowlist: every property a theme's CSS may set, with the values it may take (docs/themes.md "Allowed properties").
const PROPERTIES: ReadonlyMap<string, ValueCheck> = new Map<string, ValueCheck>([
  ['color', textColor],
  ...['background', 'background-color', 'background-image', 'background-position', 'background-position-x', 'background-position-y', 'background-size',
    'background-repeat', 'background-origin', 'background-clip', 'background-attachment', 'background-blend-mode'].map((name): [string, ValueCheck] => [name, background]),
  ...sides('border').map((name): [string, ValueCheck] => [name, borderLine]),
  ...sides('border', '-width').map((name): [string, ValueCheck] => [name, borderWidth]),
  ...sides('border', '-style').map((name): [string, ValueCheck] => [name, anyKeywords]),
  ...sides('border', '-color').map((name): [string, ValueCheck] => [name, anyColor]),
  ...['border-radius', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
    'border-start-start-radius', 'border-start-end-radius', 'border-end-start-radius', 'border-end-end-radius'].map((name): [string, ValueCheck] => [name, radius]),
  ['border-collapse', keywords('collapse', 'separate')],
  ['border-spacing', grammar({ lengths: { min: 0, max: BORDER_PX } })],
  ['outline', borderLine],
  ['outline-width', borderWidth],
  ['outline-style', anyKeywords],
  ['outline-color', anyColor],
  ['outline-offset', outlineOffset],
  ['box-shadow', shadow],
  ['text-shadow', shadow],
  ...sides('padding').map((name): [string, ValueCheck] => [name, spacing]),
  ...sides('margin').map((name): [string, ValueCheck] => [name, margin]),
  ['gap', gap],
  ['row-gap', gap],
  ['column-gap', gap],
  ['font-weight', fontWeight],
  ['font-style', fontStyle],
  ...['font-variant', 'font-variant-caps', 'font-variant-numeric', 'font-variant-ligatures', 'font-variant-east-asian', 'font-variant-alternates',
    'font-variant-position', 'font-variant-emoji'].map((name): [string, ValueCheck] => [name, anyKeywords]),
  ['font-feature-settings', fontFeatureSettings],
  ['font-family', fontFamily],
  ['letter-spacing', letterSpacing],
  ['line-height', lineHeight],
  ['text-decoration', textDecoration],
  ['text-decoration-line', anyKeywords],
  ['text-decoration-style', anyKeywords],
  ['text-decoration-color', anyColor],
  ['text-decoration-thickness', decorationThickness],
  ['text-decoration-skip-ink', keywords('auto', 'none', 'all')],
  ['text-transform', anyKeywords],
  ['text-align', keywords('start', 'end', 'left', 'right', 'center', 'justify', 'match-parent')],
  ['list-style-type', anyKeywords],
  ['cursor', cursor],
  ['caret-color', anyColor],
  ['accent-color', anyColor],
  ['scrollbar-color', anyColor],
  ['scrollbar-width', keywords('auto', 'thin', 'none')],
  ['transition', transition],
]);

/** Every property the allowlist admits, for docs and the editor. */
export const ALLOWED_CSS_PROPERTIES: readonly string[] = [...PROPERTIES.keys()];

/** A CSS name or string with its escapes decoded as CSS Syntax 3 consumes them (4.3.7), so `\64 isplay` reads as display. */
export function decodeCssEscapes(raw: string): string {
  const chars = [...raw];
  let out = '';
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i]!;
    if (char === '\0') {
      out += '\uFFFD';
      continue;
    }
    if (char !== '\\') {
      out += char;
      continue;
    }
    i += 1;
    if (i >= chars.length) {
      out += '\uFFFD';
      break;
    }
    let hex = '';
    while (hex.length < 6 && i < chars.length && /^[0-9a-fA-F]$/.test(chars[i]!)) {
      hex += chars[i];
      i += 1;
    }
    if (hex === '') {
      out += chars[i];
      continue;
    }
    if (chars[i] === '\r' && chars[i + 1] === '\n') i += 1;
    else if (i < chars.length && !/^[ \t\n\r\f]$/.test(chars[i]!)) i -= 1;
    const code = parseInt(hex, 16);
    out += code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff ? '\uFFFD' : String.fromCodePoint(code);
  }
  return out;
}

// CSS names fold ASCII only: a non-ASCII letter never becomes an ASCII one (Kelvin sign, dotted I).
const asciiLower = (value: string): string => value.replace(/[A-Z]/g, (char) => char.toLowerCase());

const utf8 = new TextEncoder();
const utf8Bytes = (value: string): number => utf8.encode(value).length;

function excerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const chars = [...collapsed];
  return chars.length <= CSS_DROPPED_TEXT_CHARS ? collapsed : `${chars.slice(0, CSS_DROPPED_TEXT_CHARS - 1).join('')}…`;
}

function applyEdits(source: string, edits: readonly Edit[]): string {
  let out = '';
  let at = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    if (edit.start < at) continue;
    out += source.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  return out + source.slice(at);
}
