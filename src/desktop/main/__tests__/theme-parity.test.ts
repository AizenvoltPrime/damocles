import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() } }));

import { DESKTOP_FONT_FILES, DESKTOP_FONT_LICENSES } from '../desktop-fonts';
import { DARK_THEME, LIGHT_THEME } from '../../theme-palettes';
import { themeCss } from '../theme';
import { FONT_FACE_CSS } from '../themes/shown-appearance';
import { HOST_TONES } from '../../../shared/host-colors';
import { TONES } from '../../../shared/themes/tokens';

const SRC = path.resolve(__dirname, '..', '..', '..');
const REPO = path.resolve(SRC, '..');
const TOKENS_CSS = path.join(SRC, 'webview', 'styles', 'tokens.css');
const RENDERER_ROOTS = [path.join(SRC, 'webview'), path.join(SRC, 'desktop')];
const SOURCE_EXTENSIONS = new Set(['.vue', '.ts', '.css', '.html']);
// Monaco, the desktop Shiki theme and the desktop pages; the VS Code webview never loads them with a desktop palette.
const DESKTOP_ONLY = [
  path.join(SRC, 'desktop') + path.sep,
  path.join(SRC, 'webview', 'components', 'editor') + path.sep,
  // the theme miniature and cards render only on desktop pages
  path.join(SRC, 'webview', 'components', 'theme') + path.sep,
  path.join(SRC, 'webview', 'composables', 'damoclesShikiTheme.ts'),
];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [full] : [];
  });
}

// A whole token name; `--d-ansi-*` in prose is a family, not a token.
const TOKEN = /(?<![\w-])--(?:d|s)-[a-z0-9-]*[a-z0-9](?![\w*-])/g;

/** Every token name each renderer source mentions, with the first file that does. */
function referencedTokens(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of RENDERER_ROOTS.flatMap(sourceFiles)) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(TOKEN)) {
      const files = found.get(match[0]) ?? [];
      if (!files.includes(file)) files.push(file);
      found.set(match[0], files);
    }
  }
  return found;
}

const isDesktopOnlyToken = (name: string): boolean => name.startsWith('--s-') || name.startsWith('--d-ansi-');
const relative = (file: string): string => path.relative(SRC, file);

describe('design token parity', () => {
  const referenced = referencedTokens();
  const designTokens = [...referenced.keys()].filter((name) => !isDesktopOnlyToken(name));
  const tokensCss = fs.readFileSync(TOKENS_CSS, 'utf8');

  it('finds the renderer references at all', () => {
    // Guards the scan itself: a moved source root would otherwise make every check vacuous.
    expect(designTokens.length).toBeGreaterThanOrEqual(20);
    expect(referenced.has('--s-kw')).toBe(true);
  });

  it.each([
    ['dark', DARK_THEME],
    ['light', LIGHT_THEME],
  ] as const)('the %s palette defines every --d-* the webview, shell and overlay read', (kind, palette) => {
    const missing = designTokens.filter((name) => !palette[name as `--d-${string}`]?.trim()).map((name) => `${name} (${relative(referenced.get(name)![0]!)})`);
    expect(missing).toEqual([]);
    const css = themeCss(kind);
    for (const [name, value] of Object.entries(palette)) expect(css).toContain(`${name}: ${value};`);
  });

  it('tokens.css maps every --d-* the renderers read, and no desktop-only token', () => {
    expect(designTokens.filter((name) => !new RegExp(`(?<![\\w-])${name}:`).test(tokensCss))).toEqual([]);
    expect([...tokensCss.matchAll(TOKEN)].map((m) => m[0]).filter(isDesktopOnlyToken)).toEqual([]);
  });

  it('dark and light define the same tokens', () => {
    expect(Object.keys(LIGHT_THEME).sort()).toEqual(Object.keys(DARK_THEME).sort());
    const ansi = Object.keys(DARK_THEME).filter((name) => name.startsWith('--d-ansi-'));
    expect(ansi.sort()).toEqual(Array.from({ length: 16 }, (_, i) => `--d-ansi-${i}`).sort());
    expect(Object.keys(DARK_THEME).filter((name) => name.startsWith('--s-')).sort()).toEqual(['--s-com', '--s-fn', '--s-kw', '--s-num', '--s-str', '--s-type']);
  });

  // Built-in fills are their tones, and safety tokens the built-in tones and their labels.
  it.each(TONES)('defines the %s fill in both palettes as its tone, and in tokens.css as var() of it', (tone) => {
    for (const palette of [DARK_THEME, LIGHT_THEME]) expect(palette[`--d-${tone}-fill`]).toBe(palette[`--d-${tone}`]);
    expect(tokensCss).toContain(`--d-${tone}-fill: var(--d-${tone});`);
  });

  it.each(HOST_TONES)('defines the %s safety tokens in both palettes as the built-in tone, and in tokens.css', (tone) => {
    for (const palette of [DARK_THEME, LIGHT_THEME]) {
      expect(palette[`--d-safety-${tone}`]).toBe(palette[`--d-${tone}`]);
      expect(palette[`--d-safety-on-${tone}`]).toBe(palette[`--d-on-${tone}`]);
      expect(palette[`--d-safety-${tone}-text`]).toBe(palette[`--d-${tone}-text`]);
    }
    expect(tokensCss).toContain(`--d-safety-${tone}: var(--d-${tone});`);
    expect(tokensCss).toContain(`--d-safety-on-${tone}: var(--d-on-${tone});`);
    expect(tokensCss).toContain(`--d-safety-${tone}-text: var(--d-${tone}-text);`);
  });

  // A theme's style changes these on desktop; the renderers read them, and VS Code keeps today's look.
  it.each([
    ['--d-line-scale', '1'],
    ['--d-radius-scale', '1'],
    ['--d-density', '1'],
    ['--d-chat-column', '50rem'],
    ['--d-hit-min', 'auto'],
  ] as const)('defines %s in both palettes and tokens.css as %s, and a renderer reads it', (token, value) => {
    for (const palette of [DARK_THEME, LIGHT_THEME]) expect(palette[token]).toBe(value);
    expect(tokensCss).toContain(`${token}: ${value};`);
    expect(referenced.has(token)).toBe(true);
  });

  // A wallpaper makes its pane token transparent; built in, every pane is its surface and opaque, and VS Code shows no wallpaper.
  it.each([
    ['--d-pane-sidebar', '--d-panel'],
    ['--d-pane-chat', '--d-bg'],
    ['--d-pane-editor', '--d-bg'],
    ['--d-pane-terminal', '--d-bg'],
    ['--d-pane-titlebar', '--d-panel'],
  ] as const)('defines %s in both palettes as its opaque %s, in tokens.css as var() of it, and a renderer reads it', (token, surface) => {
    for (const palette of [DARK_THEME, LIGHT_THEME]) expect(palette[token]).toBe(palette[surface]);
    expect(tokensCss).toContain(`${token}: var(${surface});`);
    expect(referenced.has(token)).toBe(true);
  });

  it('defines --d-surface-alpha as 1 in both palettes and tokens.css, and a renderer reads it', () => {
    for (const palette of [DARK_THEME, LIGHT_THEME]) expect(palette['--d-surface-alpha']).toBe('1');
    expect(tokensCss).toContain('--d-surface-alpha: 1;');
    expect(referenced.has('--d-surface-alpha')).toBe(true);
  });

  it('only desktop-only modules read --s-* and --d-ansi-*', () => {
    const outside = [...referenced]
      .filter(([name]) => isDesktopOnlyToken(name))
      .flatMap(([name, files]) => files.filter((file) => !DESKTOP_ONLY.some((allowed) => file === allowed || file.startsWith(allowed))).map((file) => `${name} (${relative(file)})`));
    expect(outside).toEqual([]);
    const undefinedTokens = [...referenced.keys()].filter((name) => isDesktopOnlyToken(name) && DARK_THEME[name as `--s-${string}`] === undefined);
    expect(undefinedTokens).toEqual([]);
  });
});

describe('desktop fonts', () => {
  it.each(DESKTOP_FONT_FILES.map((font) => [font.output, font] as const))('%s exists in its package with the package unicode-range', (_output, font) => {
    const packageDir = path.join(REPO, 'node_modules', font.pkg);
    expect(fs.existsSync(path.join(packageDir, 'files', font.source))).toBe(true);
    const packageCss = fs.readFileSync(path.join(packageDir, 'wght.css'), 'utf8');
    const block = packageCss.split('@font-face').find((rule) => rule.includes(`/${font.source})`));
    expect(block, `${font.source} in ${font.pkg}/wght.css`).toBeDefined();
    expect(/font-family: '([^']+)'/.exec(block!)?.[1]).toBe(font.family);
    expect(/unicode-range: ([^;]+);/.exec(block!)?.[1]).toBe(font.unicodeRange);
  });

  it('declares every file once with its served URL, and every font package has a licence', () => {
    expect(new Set(DESKTOP_FONT_FILES.map((font) => font.output)).size).toBe(DESKTOP_FONT_FILES.length);
    for (const font of DESKTOP_FONT_FILES) expect(FONT_FACE_CSS).toContain(`url(app://damocles/desktop-shell/fonts/${font.output})`);
    expect(themeCss('dark').startsWith(FONT_FACE_CSS)).toBe(true);
    const packages = new Set(DESKTOP_FONT_FILES.map((font) => font.pkg));
    expect(DESKTOP_FONT_LICENSES.map((license) => license.pkg).sort()).toEqual([...packages].sort());
    for (const pkg of packages) expect(fs.existsSync(path.join(REPO, 'node_modules', pkg, 'LICENSE'))).toBe(true);
  });

  it('puts Inter behind Geist only for Greek, and Geist Mono first in the mono stack', () => {
    expect(DARK_THEME['--d-font']).toBe("'Geist Variable', 'Inter Variable', system-ui, sans-serif");
    expect(DARK_THEME['--d-mono']).toBe("'Geist Mono Variable', ui-monospace, Menlo, monospace");
    expect(DESKTOP_FONT_FILES.filter((font) => font.family === 'Inter Variable').map((font) => font.output).sort()).toEqual(['inter-greek-ext.woff2', 'inter-greek.woff2']);
  });
});
