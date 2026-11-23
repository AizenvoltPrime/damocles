import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, walk } from 'css-tree';
import { compile } from 'tailwindcss';

// A theme scales corners, line spacing and density through --d-radius-scale, --d-line-scale and --d-density; at 1, the
// default every built-in look paints at, each radius and line-height utility must equal what it was before themes existed.

const STYLE = path.resolve(__dirname, '..', 'style.css');
const require = createRequire(import.meta.url);

// The values at commit 688abc94, before the scales: its style.css and tokens.css compiled by the same Tailwind 4.2.2.
// rounded-14, leading-prose and leading-draft were written there as rounded-[0.875rem], leading-[1.65] and leading-[1.55].
const BEFORE: Readonly<Record<string, string>> = {
  'rounded': '0.25rem', 'rounded-xs': '0.125rem', 'rounded-sm': '0.125rem', 'rounded-md': '0.25rem', 'rounded-lg': '0.375rem',
  'rounded-xl': '0.75rem', 'rounded-2xl': '1rem', 'rounded-3xl': '1.5rem', 'rounded-4xl': '2rem',
  'rounded-5': '0.3125rem', 'rounded-6': '0.375rem', 'rounded-7': '0.4375rem', 'rounded-8': '0.5rem', 'rounded-9': '0.5625rem',
  'rounded-10': '0.625rem', 'rounded-11': '0.6875rem', 'rounded-14': '0.875rem',
  'leading-none': '1', 'leading-tight': '1.25', 'leading-snug': '1.375', 'leading-normal': '1.5', 'leading-relaxed': '1.625',
  'leading-loose': '2', 'leading-prose': '1.65', 'leading-draft': '1.55',
  'text-xs': '1.333333', 'text-sm': '1.428571', 'text-base': '1.5', 'text-lg': '1.555556', 'text-xl': '1.4', 'text-2xl': '1.333333',
  ':root': '1.5',
};

/** The stylesheet at `file` compiled by Tailwind with only `candidates` as its utilities. */
async function compiled(file: string, candidates: readonly string[]): Promise<string> {
  const loadStylesheet = async (id: string, base: string) => {
    const at = id === 'tailwindcss' ? require.resolve('tailwindcss/index.css') : path.resolve(base, id);
    return { path: at, base: path.dirname(at), content: fs.readFileSync(at, 'utf8') };
  };
  const compiler = await compile(fs.readFileSync(file, 'utf8'), { base: path.dirname(file), loadStylesheet });
  return compiler.build([...candidates]);
}

// Every style rule: its selector and its own declarations, the last of a name winning; a rule nested in it is a rule of its own.
function rules(css: string): Array<{ readonly selector: string; readonly declarations: ReadonlyMap<string, string> }> {
  const found: Array<{ selector: string; declarations: Map<string, string> }> = [];
  walk(parse(css, { parseRulePrelude: false, parseValue: false, parseCustomProperty: false }), {
    visit: 'Rule',
    enter(node) {
      const declarations = new Map<string, string>();
      node.block.children.forEach((child) => {
        if (child.type === 'Declaration' && child.value.type === 'Raw') declarations.set(child.property, child.value.value.trim());
      });
      found.push({ selector: node.prelude.type === 'Raw' ? node.prelude.value.trim() : '', declarations });
    },
  });
  return found;
}

// The argument list of the function call whose "(" is at `open`, and the index after its ")".
function argumentsAt(text: string, open: number): { readonly args: string[]; readonly end: number } {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let at = open; at < text.length; at++) {
    if (text[at] === '(') depth++;
    else if (text[at] === ')' && --depth === 0) return { args: [...args, text.slice(start, at).trim()], end: at + 1 };
    else if (text[at] === ',' && depth === 1) {
      args.push(text.slice(start, at).trim());
      start = at + 1;
    }
  }
  throw new Error(`unbalanced ${text}`);
}

/** `value` with every var() replaced by what `vars` holds, or its fallback. */
function substitute(value: string, vars: ReadonlyMap<string, string>): string {
  const at = value.indexOf('var(');
  if (at < 0) return value;
  const { args, end } = argumentsAt(value, at + 3);
  const [name, ...fallback] = args;
  const found = vars.get(name!) ?? (fallback.length > 0 ? fallback.join(', ') : undefined);
  if (found === undefined) throw new Error(`${name} is not defined`);
  return substitute(`${value.slice(0, at)}${substitute(found, vars)}${value.slice(end)}`, vars);
}

/** A calc() of numbers and rem lengths, as the number it computes, in rem when any operand is. */
function evaluate(expression: string): string {
  const tokens = expression.replace(/calc\(/g, '(').match(/\d*\.?\d+(?:rem)?|[-+*/()]/g) ?? [];
  if (tokens.join('') !== expression.replace(/calc\(/g, '(').replace(/\s+/g, '')) throw new Error(`cannot evaluate ${expression}`);
  let at = 0;
  const factor = (): number => {
    const token = tokens[at++]!;
    if (token === '(') {
      const value = sum();
      at++;
      return value;
    }
    return token === '-' ? -factor() : Number.parseFloat(token);
  };
  const product = (): number => {
    let value = factor();
    while (tokens[at] === '*' || tokens[at] === '/') value = tokens[at++] === '*' ? value * factor() : value / factor();
    return value;
  };
  function sum(): number {
    let value = product();
    while (tokens[at] === '+' || tokens[at] === '-') value = tokens[at++] === '+' ? value + product() : value - product();
    return value;
  }
  const value = String(Math.round(sum() * 1e6) / 1e6);
  return tokens.some((token) => token.endsWith('rem')) ? `${value}rem` : value;
}

/** Each candidate's computed border-radius or line-height at the stylesheet's defaults, and the root's line-height. */
async function scaleValues(file: string, candidates: Readonly<Record<string, string>>): Promise<Record<string, string>> {
  const all = rules(await compiled(file, Object.values(candidates)));
  const roots = all.filter((rule) => /^:root(\s*,\s*:host)?$/.test(rule.selector));
  const vars = new Map(roots.flatMap((rule) => [...rule.declarations].filter(([name]) => name.startsWith('--'))));
  const escaped = (candidate: string): string => `.${candidate.replace(/[^\w-]/g, (char) => `\\${char}`)}`;
  const out: Record<string, string> = {};
  for (const [utility, candidate] of Object.entries(candidates)) {
    const rule = all.find((found) => found.selector === escaped(candidate));
    const value = rule?.declarations.get(utility.startsWith('rounded') ? 'border-radius' : 'line-height');
    if (value === undefined) throw new Error(`${candidate} sets no value`);
    out[utility] = evaluate(substitute(value, vars));
  }
  const rootLine = roots.map((rule) => rule.declarations.get('line-height')).filter((value) => value !== undefined).at(-1);
  out[':root'] = evaluate(substitute(rootLine!, vars));
  return out;
}

describe('the built-in looks at the default scales', () => {
  it('give every radius and line-height utility, and the root\'s line height, the value it had before themes', async () => {
    const candidates = Object.fromEntries(Object.keys(BEFORE).filter((utility) => utility !== ':root').map((utility) => [utility, utility]));
    expect(await scaleValues(STYLE, candidates)).toEqual(BEFORE);
  });

  it('let trusted UI take the trusted look\'s scales again for every radius, line height and the spacing', () => {
    const source = fs.readFileSync(STYLE, 'utf8');
    const theme = /@theme\s*\{([^}]*)\}/.exec(source.replace(/\/\*[\s\S]*?\*\//g, ''))![1]!;
    const scaled = new Map([...theme.matchAll(/(--[\w-]+)\s*:\s*([^;]*var\(--d-(?:density|radius-scale|line-scale)[^;]*);/g)].map(([, name, value]) => [name!, value!.trim()]));
    const trusted = rules(source).filter((rule) => rule.selector === '[data-trusted]').flatMap((rule) => [...rule.declarations]);
    expect(scaled.size).toBeGreaterThan(30);
    expect(new Map(trusted.filter(([name]) => scaled.has(name)))).toEqual(scaled);
    const rootLine = rules(source).filter((rule) => rule.selector === ':root').map((rule) => rule.declarations.get('line-height')).filter(Boolean).at(-1);
    expect(rootLine).toContain('var(--d-line-scale');
    expect(new Map(trusted).get('line-height')).toBe(rootLine);
  });
});
