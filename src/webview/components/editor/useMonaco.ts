import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/features/register.all';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
// Must match the languageId values src/desktop/main/platform/editor-document.ts sends; cpp also registers 'c', protobuf registers 'proto'.
import 'monaco-editor/languages/definitions/bat/register';
import 'monaco-editor/languages/definitions/cpp/register';
import 'monaco-editor/languages/definitions/csharp/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/dart/register';
import 'monaco-editor/languages/definitions/dockerfile/register';
import 'monaco-editor/languages/definitions/elixir/register';
import 'monaco-editor/languages/definitions/fsharp/register';
import 'monaco-editor/languages/definitions/go/register';
import 'monaco-editor/languages/definitions/graphql/register';
import 'monaco-editor/languages/definitions/hcl/register';
import 'monaco-editor/languages/definitions/html/register';
import 'monaco-editor/languages/definitions/ini/register';
import 'monaco-editor/languages/definitions/java/register';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/kotlin/register';
import 'monaco-editor/languages/definitions/less/register';
import 'monaco-editor/languages/definitions/lua/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/perl/register';
import 'monaco-editor/languages/definitions/php/register';
import 'monaco-editor/languages/definitions/powershell/register';
import 'monaco-editor/languages/definitions/protobuf/register';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/r/register';
import 'monaco-editor/languages/definitions/ruby/register';
import 'monaco-editor/languages/definitions/rust/register';
import 'monaco-editor/languages/definitions/scala/register';
import 'monaco-editor/languages/definitions/scss/register';
import 'monaco-editor/languages/definitions/shell/register';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/languages/definitions/swift/register';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/vb/register';
import 'monaco-editor/languages/definitions/xml/register';
import 'monaco-editor/languages/definitions/yaml/register';
import { HOST_THEME_STYLE_ID } from '@shared/host-theme';

export type Monaco = typeof monaco;
export { jsonDefaults };

// MonacoEnvironment.getWorker takes precedence over a language service's own worker, so every label a page's language
// services start must be listed; the chat page registers only JSON's.
const languageWorkers = new Map<string, () => Worker>([['json', () => new JsonWorker()]]);
self.MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) => languageWorkers.get(label)?.() ?? new EditorWorker(),
};

/** Starts `create`'s worker for a language service's labels; a page registering that service calls it before any editor opens. */
export function addLanguageWorker(labels: readonly string[], create: () => Worker): void {
  for (const label of labels) languageWorkers.set(label, create);
}

const THEME_NAME = 'damocles';

// Monaco color id -> the design token the desktop host injects (palettes in src/desktop/main/theme.ts).
const THEME_COLORS: Readonly<Record<string, `--d-${string}`>> = {
  'editor.background': '--d-bg',
  // An explicit minimap background, so the minimap paints over the text its column overlaps.
  'minimap.background': '--d-bg',
  'editor.foreground': '--d-text',
  'editorLineNumber.foreground': '--d-faint',
  'editorLineNumber.activeForeground': '--d-muted',
  'editorWidget.background': '--d-card',
  'editorWidget.border': '--d-border2',
  'editorHoverWidget.background': '--d-card',
  'editorSuggestWidget.background': '--d-card',
  'focusBorder': '--d-accent',
  'input.background': '--d-input',
  'list.hoverBackground': '--d-hover',
  'diffEditor.insertedTextBackground': '--d-add',
  'diffEditor.removedTextBackground': '--d-del',
  'editorError.foreground': '--d-danger',
  'editorWarning.foreground': '--d-warning',
  'editorInfo.foreground': '--d-info',
  'textLink.foreground': '--d-accent',
};

// Monarch token prefix -> the desktop-only syntax token; Monaco matches a rule against every token that starts with it.
const SYNTAX_RULES: ReadonlyArray<readonly [string, `--s-${string}` | `--d-${string}`]> = [
  ['comment', '--s-com'],
  ['keyword', '--s-kw'],
  ['tag', '--s-kw'],
  ['string', '--s-str'],
  ['regexp', '--s-str'],
  ['attribute.value', '--s-str'],
  ['number', '--s-num'],
  ['constant', '--s-num'],
  ['type', '--s-type'],
  ['predefined', '--s-fn'],
  ['attribute.name', '--s-fn'],
  ['delimiter', '--d-muted'],
];

// Monaco parses only hex colors; a value in any other form is left to the base theme.
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// A token rule takes six hex digits without the #.
const RULE_COLOR = /^#([0-9a-f]{6})$/i;

function applyHostTheme(): void {
  const style = getComputedStyle(document.documentElement);
  const colors: Record<string, string> = {};
  for (const [id, variable] of Object.entries(THEME_COLORS)) {
    const value = style.getPropertyValue(variable).trim();
    if (HEX_COLOR.test(value)) colors[id] = value;
  }
  const rules = SYNTAX_RULES.flatMap(([token, variable]) => {
    const hex = RULE_COLOR.exec(style.getPropertyValue(variable).trim())?.[1];
    return hex === undefined ? [] : [{ token, foreground: hex }];
  });
  const light = document.body.classList.contains('vscode-light');
  monaco.editor.defineTheme(THEME_NAME, { base: light ? 'vs' : 'vs-dark', inherit: true, rules, colors });
  monaco.editor.setTheme(THEME_NAME);
}

let themeObserver: MutationObserver | undefined;

// The panel preload switches themes by rewriting the host theme <style> and the body's vscode-dark/vscode-light class.
function followHostTheme(): void {
  if (themeObserver) return;
  applyHostTheme();
  themeObserver = new MutationObserver(applyHostTheme);
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-kind'] });
  const hostStyle = document.getElementById(HOST_THEME_STYLE_ID);
  if (hostStyle) themeObserver.observe(hostStyle, { childList: true, characterData: true, subtree: true });
  // Monaco measures glyph widths once per font, so an editor created before the webfont loaded measured a fallback.
  document.fonts.addEventListener('loadingdone', () => monaco.editor.remeasureFonts());
}

/** Options every Damocles Monaco editor shares: the host's editor font, read-only unless the caller overrides it. */
export function baseEditorOptions(): monaco.editor.IEditorOptions & { automaticLayout: boolean } {
  const style = getComputedStyle(document.documentElement);
  const fontFamily = style.getPropertyValue('--d-mono').trim();
  const fontSize = Number.parseInt(style.getPropertyValue('--d-mono-size'), 10);
  return {
    ...(fontFamily ? { fontFamily } : {}),
    ...(Number.isNaN(fontSize) ? {} : { fontSize }),
    readOnly: true,
    automaticLayout: true,
    minimap: { enabled: false },
  };
}

/** Monaco with the host theme applied and followed; call from a component's setup. */
export function useMonaco(): Monaco {
  followHostTheme();
  return monaco;
}
