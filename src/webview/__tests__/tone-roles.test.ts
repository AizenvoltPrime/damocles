import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// A tone's fills, borders, rings, outlines, shadows and tints take --d-<tone>-fill, the user's exact color at 3:1;
// its text takes --d-<tone>, derived from the fill at 4.5:1. tokens.css maps both to one VS Code color, so it is skipped.
const SRC = path.resolve(__dirname, '..', '..');
const ROOTS = ['webview', path.join('desktop', 'shell'), 'shared'].map((root) => path.join(SRC, root));
const SKIP = [path.join(SRC, 'webview', 'styles', 'tokens.css')];
const EXTENSIONS = new Set(['.vue', '.ts', '.css', '.html']);
const TONES = '(?:accent|success|warning|danger|info|design)';
// A token inside var() or a Tailwind v4 short form such as bg-(--d-accent); `-fill` marks the fill token.
const OCCURRENCE = new RegExp(`(var\\(|-\\()--d-${TONES}(-fill)?(?![\\w-])`, 'g');

const FILL_UTILITIES = /^(bg|border(-[trblxyse])?|ring(-offset)?|inset-ring|outline|stroke|fill|from|via|to|decoration|divide(-[xy])?|shadow|inset-shadow|drop-shadow|accent)$/;
const TEXT_UTILITIES = /^(text|caret|placeholder)$/;
// CSS properties, JS style keys (kebab-cased), SVG attributes and the custom properties that carry a fill.
const FILL_PROPS = /^(background(-color|-image)?|border(-[a-z]+)*|outline(-color)?|box-shadow|fill|stroke|stop-color|text-decoration(-color)?|accent-color|column-rule(-color)?|scrollbar-color|--tone|--qd-color|--qd-peek-color|--qd-merge|--attention-ring|--ring|--primary|--destructive|--chart-\d+|--color-(success|warning|error|info))$/;
const TEXT_PROPS = /^(color|caret-color|-webkit-text-fill-color|foreground)$/;

// d-ring, d-sweep-bar and d-sheen (motion.css) and SlidingIndicator paint a fill from --tone.
const HELPER = /(?<![\w-])(d-ring|d-sweep-bar|d-sheen)(?![\w-])/g;
const INDICATOR = /<SlidingIndicator(?![\w-])|(?<![\w-])indicator-class=|(?<![\w-])indicatorClass:\s*['"`]/g;
const TONE_TEXT = new RegExp(`(?<![\\w-])text-(\\(|\\[[^\\]]*var\\()--d-${TONES}(-text)?(?![\\w-])`);

type Role = 'fill' | 'text' | 'other';

/** The line holding `at`, widened to its opening tag when that tag spans lines. */
function elementAround(source: string, at: number): string {
  const lineStart = source.lastIndexOf('\n', at) + 1;
  const lineEnd = source.indexOf('\n', at) === -1 ? source.length : source.indexOf('\n', at);
  const open = [...source.slice(0, lineEnd).matchAll(/^[ \t]*<[A-Za-z]/gm)].at(-1)?.index ?? lineStart;
  const closed = /\/?>[ \t]*\r?$/m.exec(source.slice(open));
  const close = closed ? open + closed.index + closed[0].length : lineEnd;
  return close >= at ? source.slice(Math.min(open, lineStart), Math.max(close, lineEnd)) : source.slice(lineStart, lineEnd);
}

const readBack = (s: string, end: number, chars: RegExp): string => {
  let start = end;
  while (start > 0 && chars.test(s[start - 1]!)) start--;
  return s.slice(start, end);
};

function classify(name: string, utility: boolean): Role {
  if (utility) return FILL_UTILITIES.test(name) ? 'fill' : TEXT_UTILITIES.test(name) ? 'text' : 'other';
  const prop = name.startsWith('--') ? name : name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return FILL_PROPS.test(prop) ? 'fill' : TEXT_PROPS.test(prop) ? 'text' : 'other';
}

/**
 * The role of the token at `at`: a short form's utility, or, walking back from a var() out of any enclosing function, the
 * arbitrary-value utility (`bg-[...]`), arbitrary property (`[--x:...]`), declaration or style key (`prop:`) or attribute (`attr=`).
 */
function roleAt(s: string, at: number, shortForm: boolean): Role {
  if (shortForm) return classify(readBack(s, at, /[a-z0-9-]/), true);
  let depth = 0;
  for (let j = at - 1; j >= 0; j--) {
    const c = s[j]!;
    if (c === ')' || c === ']') depth++;
    else if (c === '(') depth = Math.max(0, depth - 1);
    else if (c === '[') {
      if (depth > 0) depth--;
      else return s[j - 1] === '-' ? classify(readBack(s, j - 1, /[a-z0-9-]/), true) : 'other';
    } else if (depth === 0 && (c === ':' || c === '=')) {
      let k = j;
      while (k > 0 && /[\s'"]/.test(s[k - 1]!)) k--;
      return classify(readBack(s, k, /[A-Za-z0-9-]/), false);
    } else if (depth === 0 && /[;{}\n]/.test(c)) return 'other';
  }
  return 'other';
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return EXTENSIONS.has(path.extname(entry.name)) && !SKIP.includes(full) ? [full] : [];
  });
}

interface Use { readonly where: string; readonly token: string; readonly fill: boolean; readonly role: Role }

function uses(): Use[] {
  return ROOTS.flatMap(sourceFiles).flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return [...source.matchAll(OCCURRENCE)].map((match) => {
      const line = source.slice(0, match.index).split('\n').length;
      return { where: `${path.relative(SRC, file)}:${line}`, token: match[0], fill: match[2] !== undefined, role: roleAt(source, match.index, match[1] === '-(') };
    });
  });
}

describe('tone roles', () => {
  const found = uses();

  it('finds the renderer uses at all', () => {
    // Guards the scan itself: a moved root or a broken classifier would otherwise pass vacuously.
    expect(found.filter((use) => use.fill && use.role === 'fill').length).toBeGreaterThan(500);
    expect(found.filter((use) => !use.fill && use.role === 'text').length).toBeGreaterThan(300);
  });

  it('classifies the forms a tone token takes', () => {
    const role = (s: string): Role => roleAt(s, s.indexOf('--d-') - (s.includes('var(--d-') ? 4 : 2), !s.includes('var(--d-'));
    expect(role('hover:bg-(--d-accent)/15')).toBe('fill');
    expect(role('focus-visible:ring-(--d-accent)')).toBe('fill');
    expect(role('border-[color-mix(in_srgb,var(--d-warning)_45%,var(--d-border))]')).toBe('fill');
    expect(role('shadow-[inset_0_0_0_1px_var(--d-accent)]')).toBe('fill');
    expect(role('[--attention-ring:var(--d-accent)]')).toBe('fill');
    expect(role('[--tone:var(--d-accent-fill)]')).toBe('fill');
    expect(role('[--tone:color-mix(in_srgb,var(--d-accent-fill)_16%,var(--d-card))]')).toBe('fill');
    expect(role('  background-color: color-mix(in srgb, var(--d-accent) 12%, transparent);')).toBe('fill');
    expect(role(':style="{ borderColor: `color-mix(in srgb, var(--d-info) 45%, var(--d-border))` }"')).toBe('fill');
    expect(role('<circle stroke="var(--d-accent)"')).toBe('fill');
    expect(role('text-(--d-accent)')).toBe('text');
    expect(role('placeholder:text-[color-mix(in_srgb,var(--d-danger)_70%,var(--d-text))]')).toBe('text');
    expect(role("{ color: 'var(--d-accent)' }")).toBe('text');
    expect(role('  --primary: var(--d-accent);')).toBe('fill');
    expect(role('  --chart-2: var(--d-success);')).toBe('fill');
    expect(role('  --color-warning: var(--d-warning);')).toBe('fill');
  });

  it('puts no plain tone token in a fill position', () => {
    expect(found.filter((use) => !use.fill && use.role === 'fill').map((use) => `${use.where} ${use.token}`)).toEqual([]);
  });

  it('puts no -fill token in a text position', () => {
    expect(found.filter((use) => use.fill && use.role === 'text').map((use) => `${use.where} ${use.token}`)).toEqual([]);
  });

  it('gives a motion helper beside a tone text class its fill through --tone', () => {
    const misuses = ROOTS.flatMap(sourceFiles).flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return [...source.matchAll(HELPER)]
        .filter((match) => {
          const element = elementAround(source, match.index);
          return TONE_TEXT.test(element) && !element.includes('--tone:');
        })
        .map((match) => `${path.relative(SRC, file)}:${source.slice(0, match.index).split('\n').length} ${match[0]}`);
    });
    expect(misuses).toEqual([]);
  });

  it('colors a sliding indicator through --tone, never a text class', () => {
    const sites = ROOTS.flatMap(sourceFiles).flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return [...source.matchAll(INDICATOR)].map((match) => ({
        where: `${path.relative(SRC, file)}:${source.slice(0, match.index).split('\n').length}`,
        // the indicator's own tag, or the line of the attribute or key that carries its class to SegmentedToggle
        element: match[0].startsWith('<') ? elementAround(source, match.index) : source.slice(match.index, source.indexOf('\n', match.index)),
      }));
    });
    expect(sites.length).toBeGreaterThan(20);
    expect(sites.filter((site) => /(?<![\w-])text-[([]/.test(site.element)).map((site) => site.where)).toEqual([]);
  });

  it('uses the shadcn and status color aliases, which are fills, only as fills', () => {
    const aliasText = /(?<![\w-])(text|caret|placeholder)-(primary|destructive|success|warning|error|info)(?![\w-])/g;
    const aliasVarText = /(?<![\w-])color:\s*var\(--(primary|destructive|color-(?:primary|destructive|success|warning|error|info))\)/g;
    const misuses = ROOTS.flatMap(sourceFiles).flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return [...source.matchAll(aliasText), ...source.matchAll(aliasVarText)].map(
        (match) => `${path.relative(SRC, file)}:${source.slice(0, match.index).split('\n').length} ${match[0]}`,
      );
    });
    expect(misuses).toEqual([]);
  });
});
