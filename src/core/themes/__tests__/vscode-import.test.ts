// VS Code color themes as Damocles themes: JSONC, a .vsix's themes with include chains kept inside it, semanticTokenColors, the base
// kind's defaults, high contrast, and the mapping proved the inverse of how Damocles reads VS Code's colors (tokens.css) and paints
// syntax (damoclesShikiTheme) on every built-in look.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { BUILTIN_EXAMPLE_IDS, BUILTIN_THEME } from '../../../shared/themes/builtin';
import { deriveLook } from '../../../shared/themes/derive';
import { validateTheme, type Look, type ThemeFile } from '../../../shared/themes/schema';
import { SYNTAX_SCOPES } from '../../../shared/themes/syntax-scopes';
import { LOOK_KINDS, SYNTAX_TOKENS, type LookKind, type TokenName } from '../../../shared/themes/tokens';
import { damoclesShikiTheme } from '../../../webview/composables/damoclesShikiTheme';
import { englishText } from '../../../shared/localized-text';
import { openZip } from '../archive';
import { importVscodeThemeText, importVsix, MAX_JSON_DEPTH, VscodeImportError, VSCODE_SEED_KEYS, VSCODE_TOKEN_KEYS, VSIX_LIMITS, type VscodeImport } from '../vscode-import';

const TOKENS_CSS = fs.readFileSync(path.join(__dirname, '../../../webview/styles/tokens.css'), 'utf8');

/** tokens.css's `--d-x: var(--vscode-a-b, var(--vscode-c-d, ...))` pairs: each token with the VS Code color keys it reads, in order. */
function tokensCssPairs(): Map<TokenName, string[]> {
  const pairs = new Map<TokenName, string[]>();
  for (const [, token, value] of TOKENS_CSS.matchAll(/^\s*(--d-[a-z0-9-]+):\s*(var\(--vscode-[^;]+);/gm)) {
    // a color-mix fallback is a color made from another, not a color the token reads
    const keys = [...value!.split('color-mix')[0]!.matchAll(/var\(--vscode-([A-Za-z0-9-]+)/g)].map(([, name]) => name!.replace(/-/g, '.'));
    pairs.set(token as TokenName, keys);
  }
  return pairs;
}

// Colors tokens.css reads that are not colors of the look (fonts and sizes).
const NOT_COLORS: ReadonlySet<string> = new Set(['--d-font', '--d-mono', '--d-mono-size', '--d-font-size']);
// Kept to the derivation, which holds it at AA against the accent fill.
const DERIVED_ONLY: ReadonlySet<string> = new Set(['--d-on-accent']);
// The seed each seed-reading token stands for.
const SEED_TOKEN: Readonly<Record<keyof typeof VSCODE_SEED_KEYS, TokenName>> = {
  background: '--d-bg', panel: '--d-panel', text: '--d-text', accent: '--d-accent', success: '--d-success', warning: '--d-warning', danger: '--d-danger', info: '--d-info',
};

const lookOf = (imported: VscodeImport, kind: LookKind): Look => {
  const looks = imported.theme['looks'] as Partial<Record<LookKind, Look>>;
  return looks[kind]!;
};

const zip = (files: Record<string, string>): Uint8Array => zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, new TextEncoder().encode(text)])));
const manifest = (themes: ReadonlyArray<{ label: string; uiTheme: string; path: string }>): string => JSON.stringify({ name: 'pack', displayName: 'Pack', publisher: 'someone', version: '1.2.3', license: 'MIT', contributes: { themes } });

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof VscodeImportError) return err.reason;
    throw err;
  }
  throw new Error('not refused');
}

describe('the mapping is the inverse of how Damocles reads a VS Code theme', () => {
  it('reads each seed and token from the colors tokens.css reads it from, in the same order', () => {
    const pairs = tokensCssPairs();
    for (const [seed, keys] of Object.entries(VSCODE_SEED_KEYS)) expect(keys, seed).toEqual(pairs.get(SEED_TOKEN[seed as keyof typeof SEED_TOKEN]));
    const imported = new Map([...Object.values(SEED_TOKEN), ...Object.keys(VSCODE_TOKEN_KEYS)].map((token) => [token, true]));
    for (const [token, keys] of pairs) {
      if (NOT_COLORS.has(token) || DERIVED_ONLY.has(token)) continue;
      expect(imported.has(token), `${token} is not imported`).toBe(true);
      if (VSCODE_TOKEN_KEYS[token]) expect(VSCODE_TOKEN_KEYS[token], token).toEqual(keys);
    }
  });

  it('reads each syntax token from the scopes the Damocles code theme paints it on', () => {
    for (const token of SYNTAX_TOKENS) {
      const rule = damoclesShikiTheme.tokenColors!.find((candidate) => (candidate.settings as { foreground?: string }).foreground === `var(${token})`);
      expect(rule?.scope, token).toEqual(SYNTAX_SCOPES[token]);
    }
  });

  const builtinLooks = (): Array<readonly [string, LookKind, Look]> => {
    const examples = BUILTIN_EXAMPLE_IDS.map((id) => {
      const result = validateTheme(JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../resources/themes', id, 'theme.json'), 'utf8')), { builtin: true, folder: id });
      if (!result.ok) throw new Error(`${id}: ${result.errors[0]}`);
      return result.theme;
    });
    return [BUILTIN_THEME, ...examples].flatMap((theme: ThemeFile) => LOOK_KINDS.flatMap((kind) => (theme.looks[kind] ? [[`${theme.id} ${kind}`, kind, theme.looks[kind]!] as const] : [])));
  };

  it.each(builtinLooks())('round-trips %s: a VS Code theme made from its palette imports to the same palette', (_name, kind, look) => {
    const palette = deriveLook(look.colors, kind, look.tokens);
    const colors: Record<string, string> = {};
    // each token's first key, which VS Code's own reading of tokens.css takes when the theme sets it
    for (const [token, keys] of tokensCssPairs()) {
      if (NOT_COLORS.has(token) || DERIVED_ONLY.has(token)) continue;
      colors[keys[0]!] = palette[token]!;
    }
    // a different focus border must not move the accent: Damocles reads textLink.foreground
    colors['focusBorder'] = '#ff00ff';
    const tokenColors = damoclesShikiTheme.tokenColors!.map((rule) => {
      const foreground = (rule.settings as { foreground?: string }).foreground;
      const token = foreground?.match(/^var\((--[ds]-[a-z0-9-]+)\)$/)?.[1] as TokenName | undefined;
      return token ? { scope: rule.scope, settings: { foreground: palette[token] } } : rule;
    });
    const imported = importVscodeThemeText(JSON.stringify({ name: 'Round trip', type: kind, colors, tokenColors }), 'round-trip.json');
    expect(imported.warnings).toEqual([]);
    const back = lookOf(imported, kind);
    const derived = deriveLook(back.colors, kind, back.tokens);
    for (const [token] of tokensCssPairs()) {
      if (NOT_COLORS.has(token) || DERIVED_ONLY.has(token)) continue;
      expect(derived[token], token).toBe(palette[token]);
    }
    for (const token of SYNTAX_TOKENS) expect(derived[token], token).toBe(palette[token]);
  });
});

describe('VS Code theme files', () => {
  it('reads JSONC: comments and trailing commas', () => {
    const imported = importVscodeThemeText(`{
      // a comment
      "name": "Night Owl",
      "type": "dark",
      "colors": { "editor.background": "#011627", "foreground": "#d6deeb", /* block */ },
      "tokenColors": [{ "scope": "keyword", "settings": { "foreground": "#C792EA" } },],
    }`, 'night-owl-color-theme.json');
    expect(imported.theme['name']).toBe('Night Owl');
    const look = lookOf(imported, 'dark');
    expect(look.colors.background).toBe('#011627');
    expect(look.colors.text).toBe('#d6deeb');
    expect(look.tokens?.['--s-kw']).toBe('#c792ea');
  });

  it('fills what the theme leaves out from its base kind\'s VS Code defaults', () => {
    const light = lookOf(importVscodeThemeText(JSON.stringify({ name: 'Sparse', type: 'light', colors: { 'editor.background': '#fdf6e3' } }), 'sparse.json'), 'light');
    expect(light.colors).toEqual({ background: '#fdf6e3', panel: '#fdf6e3', text: '#616161', accent: '#006ab1', success: '#00bc00', warning: '#bf8803', danger: '#a1260d', info: '#1a85ff' });
    expect(light.tokens?.['--s-kw']).toBe('#0000ff');
    const dark = lookOf(importVscodeThemeText(JSON.stringify({ name: 'Sparse', colors: { 'editor.background': '#000000' } }), 'sparse.json'), 'dark');
    expect(dark.colors.text).toBe('#cccccc');
    expect(dark.tokens?.['--s-com']).toBe('#6a9955');
  });

  it('paints a translucent seed over the background, and keeps a token override\'s alpha', () => {
    const look = lookOf(importVscodeThemeText(JSON.stringify({ name: 'Alpha', type: 'dark', colors: { 'editor.background': '#000000', 'textLink.foreground': '#ffffff80', 'list.hoverBackground': '#ffffff1a' } }), 'alpha.json'), 'dark');
    expect(look.colors.accent).toBe('#808080');
    expect(look.tokens?.['--d-hover']).toBe('#ffffff1a');
  });

  it('lets semanticTokenColors win over tokenColors', () => {
    const look = lookOf(importVscodeThemeText(JSON.stringify({
      name: 'Semantic',
      type: 'dark',
      tokenColors: [{ scope: ['entity.name.function', 'entity.name.type'], settings: { foreground: '#111111' } }],
      semanticTokenColors: { function: '#22aa22', type: { foreground: '#3333cc' } },
    }), 'semantic.json'), 'dark');
    expect(look.tokens?.['--s-fn']).toBe('#22aa22');
    expect(look.tokens?.['--s-type']).toBe('#3333cc');
  });

  it('picks the most specific tokenColors selector, the later rule on a tie', () => {
    const look = lookOf(importVscodeThemeText(JSON.stringify({
      name: 'Specific',
      type: 'dark',
      tokenColors: [
        { scope: 'string', settings: { foreground: '#aa0000' } },
        { scope: 'string', settings: { foreground: '#bb0000' } },
        { scope: 'constant', settings: { foreground: '#00aa00' } },
        { scope: 'constant.numeric', settings: { foreground: '#00bb00' } },
      ],
    }), 'specific.json'), 'dark');
    expect(look.tokens?.['--s-str']).toBe('#bb0000');
    expect(look.tokens?.['--s-num']).toBe('#00bb00');
  });

  it('maps a high contrast theme to its nearest kind with a warning for the card', () => {
    const dark = importVscodeThemeText(JSON.stringify({ name: 'Contrast', type: 'hc', colors: {} }), 'hc.json');
    expect(Object.keys(dark.theme['looks'] as object)).toEqual(['dark']);
    expect(dark.warnings).toEqual([expect.objectContaining({ message: expect.stringContaining('becomes a dark look') })]);
    const light = importVscodeThemeText(JSON.stringify({ name: 'Contrast', type: 'hcLight', colors: {} }), 'hc.json');
    expect(Object.keys(light.theme['looks'] as object)).toEqual(['light']);
    expect(light.warnings).toEqual([expect.objectContaining({ message: expect.stringContaining('becomes a light look') })]);
  });

  it('refuses a theme file that includes another, outside any .vsix', () => {
    expect(refusal(() => importVscodeThemeText(JSON.stringify({ name: 'X', include: './base.json', colors: {} }), 'x.json'))).toBe('include');
  });

  it('refuses text that is not JSON, and JSON that is no color theme', () => {
    expect(refusal(() => importVscodeThemeText('{ nope', 'x.json'))).toBe('notJson');
    expect(refusal(() => importVscodeThemeText('{ "name": "x" }', 'x.json'))).toBe('notTheme');
  });
});

describe('a theme file that nests deeply', () => {
  // the bound as a number, so these inputs are the same whatever the module exports
  const DEPTH = 64;

  it('bounds the nesting at 64 levels', () => {
    expect(MAX_JSON_DEPTH).toBe(DEPTH);
  });

  const nested = (levels: number): string => `{ "colors": {}, "x": ${'['.repeat(levels - 1)}${']'.repeat(levels - 1)} }`;

  it('is refused before it parses, at any depth past the bound', () => {
    // jsonc-parser recurses once per level and overflows the stack near 10,000
    expect(refusal(() => importVscodeThemeText('['.repeat(10_000), 'deep.json'))).toBe('notJson');
    expect(refusal(() => importVscodeThemeText('{"a":'.repeat(200_000), 'deep.json'))).toBe('notJson');
    // closers that match no opener close nothing, so they cannot hide the depth
    expect(refusal(() => importVscodeThemeText('[}'.repeat(5_000), 'deep.json'))).toBe('notJson');
    expect(refusal(() => importVscodeThemeText(nested(DEPTH + 1), 'deep.json'))).toBe('notJson');
  });

  it('is read at exactly the bound', () => {
    expect(importVscodeThemeText(nested(DEPTH), 'deep.json').theme['name']).toBe('deep');
  });
});

describe('.vsix themes', () => {
  const vsix = (bytes: Uint8Array): Promise<VscodeImport> => importVsix(openZip(bytes, VSIX_LIMITS));
  const vsixRefusal = async (bytes: Uint8Array): Promise<string> => {
    try {
      await vsix(bytes);
    } catch (err) {
      if (err instanceof VscodeImportError) return err.reason;
      throw err;
    }
    throw new Error('not refused');
  };

  it('reads contributes.themes and follows include chains inside the .vsix, the including file winning', async () => {
    const bytes = zip({
      'extension/package.json': manifest([{ label: 'Pack Dark', uiTheme: 'vs-dark', path: './themes/dark.json' }, { label: 'Pack Light', uiTheme: 'vs', path: './themes/light.json' }]),
      'extension/themes/dark.json': JSON.stringify({ include: './base/common.json', colors: { 'editor.background': '#101010' }, tokenColors: [{ scope: 'keyword', settings: { foreground: '#ff0000' } }] }),
      'extension/themes/base/common.json': JSON.stringify({ include: '../shared.json', colors: { 'editor.background': '#202020', foreground: '#eeeeee' } }),
      'extension/themes/shared.json': JSON.stringify({ colors: { 'textLink.foreground': '#44aaff' }, tokenColors: [{ scope: 'keyword', settings: { foreground: '#00ff00' } }, { scope: 'string', settings: { foreground: '#ffaa00' } }] }),
      'extension/themes/light.json': JSON.stringify({ colors: { 'editor.background': '#fafafa' } }),
    });
    const imported = await vsix(bytes);
    expect(imported.theme).toEqual(expect.objectContaining({ name: 'Pack', author: 'someone', version: '1.2.3', license: 'MIT' }));
    const dark = lookOf(imported, 'dark');
    expect(dark.colors).toEqual(expect.objectContaining({ background: '#101010', text: '#eeeeee', accent: '#44aaff' }));
    expect(dark.tokens?.['--s-kw']).toBe('#ff0000');
    expect(dark.tokens?.['--s-str']).toBe('#ffaa00');
    expect(lookOf(imported, 'light').colors.background).toBe('#fafafa');
  });

  it('refuses an include that leaves the extension', async () => {
    const bytes = zip({
      'extension/package.json': manifest([{ label: 'Escape', uiTheme: 'vs-dark', path: './themes/dark.json' }]),
      'extension/themes/dark.json': JSON.stringify({ include: '../../extension.vsixmanifest', colors: {} }),
      'extension.vsixmanifest': '{}',
    });
    expect(await vsixRefusal(bytes)).toBe('escape');
    const absolute = zip({ 'extension/package.json': manifest([{ label: 'Abs', uiTheme: 'vs-dark', path: '/etc/passwd' }]) });
    expect(await vsixRefusal(absolute)).toBe('escape');
    const drive = zip({ 'extension/package.json': manifest([{ label: 'Drive', uiTheme: 'vs-dark', path: 'C:\\Windows\\win.ini' }]) });
    expect(await vsixRefusal(drive)).toBe('escape');
  });

  it('refuses an include cycle', async () => {
    const bytes = zip({
      'extension/package.json': manifest([{ label: 'Cycle', uiTheme: 'vs-dark', path: './a.json' }]),
      'extension/a.json': JSON.stringify({ include: './b.json', colors: {} }),
      'extension/b.json': JSON.stringify({ include: './a.json', colors: {} }),
    });
    expect(await vsixRefusal(bytes)).toBe('cycle');
  });

  it('refuses a theme file the .vsix lacks, and a .vsix with no color theme', async () => {
    expect(await vsixRefusal(zip({ 'extension/package.json': manifest([{ label: 'Gone', uiTheme: 'vs-dark', path: './missing.json' }]) }))).toBe('missing');
    expect(await vsixRefusal(zip({ 'extension/package.json': JSON.stringify({ name: 'nothing' }) }))).toBe('noThemes');
  });

  it('keeps the first theme of each kind and names the others in a warning', async () => {
    const imported = await vsix(zip({
      'extension/package.json': manifest([{ label: 'One', uiTheme: 'vs-dark', path: './one.json' }, { label: 'Two', uiTheme: 'vs-dark', path: './two.json' }]),
      'extension/one.json': JSON.stringify({ colors: { 'editor.background': '#111111' } }),
      'extension/two.json': JSON.stringify({ colors: { 'editor.background': '#222222' } }),
    }));
    expect(imported.theme['name']).toBe('One');
    expect(lookOf(imported, 'dark').colors.background).toBe('#111111');
    expect(imported.warnings).toEqual([expect.objectContaining({ message: 'This .vsix has more themes than a dark and a light look; these were left out: {0}' })]);
  });

  it('never reads a theme whose kind is already filled, so a later theme it cannot read refuses nothing', async () => {
    const zipped = zip({
      'extension/package.json': manifest([
        { label: 'Dark', uiTheme: 'vs-dark', path: './dark.json' },
        { label: 'Light', uiTheme: 'vs', path: './light.json' },
        { label: 'Old', uiTheme: 'vs-dark', path: './old.tmTheme' },
        { label: 'Gone', uiTheme: 'vs', path: './gone.json' },
      ]),
      'extension/dark.json': JSON.stringify({ colors: { 'editor.background': '#111111' } }),
      'extension/light.json': JSON.stringify({ colors: { 'editor.background': '#fafafa' } }),
    });
    const reader = openZip(zipped, VSIX_LIMITS);
    const read: string[] = [];
    const imported = await importVsix({ ...reader, read: (name, cap) => {
      read.push(name);
      return reader.read(name, cap);
    } });
    expect(read).toEqual(['extension/package.json', 'extension/dark.json', 'extension/light.json']);
    expect(Object.keys(imported.theme['looks'] as object).sort()).toEqual(['dark', 'light']);
    expect(imported.warnings).toEqual([{ message: 'This .vsix has more themes than a dark and a light look; these were left out: {0}', args: [{ message: '{0}', args: ['Old, Gone'] }] }]);
  });

  it('leaves out a theme it cannot read with a warning naming it, wherever it is listed', async () => {
    const imported = await vsix(zip({
      'extension/package.json': manifest([
        { label: 'Old', uiTheme: 'vs-dark', path: './old.tmTheme' },
        { label: 'Dark', uiTheme: 'vs-dark', path: './dark.json' },
        { label: 'Gone', uiTheme: 'vs', path: './gone.json' },
      ]),
      'extension/dark.json': JSON.stringify({ colors: { 'editor.background': '#111111' } }),
    }));
    expect(imported.theme['name']).toBe('Dark');
    expect(imported.warnings.map((warning) => [warning.message, englishText(warning)])).toEqual([
      ['The theme {0} in this .vsix was left out: {1}', 'The theme Old in this .vsix was left out: extension/old.tmTheme is a TextMate .tmTheme file, which Damocles does not import.'],
      ['The theme {0} in this .vsix was left out: {1}', 'The theme Gone in this .vsix was left out: This .vsix names extension/gone.json, which it does not hold.'],
    ]);
  });

  it('still refuses a .vsix none of whose themes can be read, with the first one\'s reason', async () => {
    expect(await vsixRefusal(zip({
      'extension/package.json': manifest([{ label: 'Old', uiTheme: 'vs-dark', path: './old.tmTheme' }, { label: 'Gone', uiTheme: 'vs', path: './gone.json' }]),
    }))).toBe('tmTheme');
  });

  it('names a theme with no label by its file name, as one line', async () => {
    const imported = await vsix(zip({
      'extension/package.json': JSON.stringify({ name: 'pack', contributes: { themes: [{ uiTheme: 'vs-dark', path: './themes/ni\u0007ght.json' }] } }),
      'extension/themes/ni\u0007ght.json': JSON.stringify({ colors: { 'editor.background': '#111111' } }),
    }));
    expect(imported.theme['name']).toBe('ni ght.json');
  });
});
