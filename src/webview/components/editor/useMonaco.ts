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

// Only the editor and json workers are bundled; no registered language asks for another label.
self.MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) => (label === 'json' ? new JsonWorker() : new EditorWorker()),
};

const THEME_NAME = 'damocles';

// Monaco color id -> the --vscode-* variable the desktop host injects (palette in src/desktop/main/theme.ts).
const THEME_COLORS: Readonly<Record<string, `--vscode-${string}`>> = {
  'editor.background': '--vscode-editor-background',
  'editor.foreground': '--vscode-editor-foreground',
  'editorLineNumber.foreground': '--vscode-editorLineNumber-foreground',
  'editorWidget.background': '--vscode-editorWidget-background',
  'editorWidget.border': '--vscode-widget-border',
  'editorHoverWidget.background': '--vscode-editorWidget-background',
  'editorSuggestWidget.background': '--vscode-editorWidget-background',
  'focusBorder': '--vscode-focusBorder',
  'input.background': '--vscode-input-background',
  'list.hoverBackground': '--vscode-list-hoverBackground',
  'diffEditor.insertedTextBackground': '--vscode-diffEditor-insertedTextBackground',
  'diffEditor.removedTextBackground': '--vscode-diffEditor-removedTextBackground',
  'editorError.foreground': '--vscode-errorForeground',
  'editorWarning.foreground': '--vscode-editorWarning-foreground',
  'editorInfo.foreground': '--vscode-editorInfo-foreground',
  'textLink.foreground': '--vscode-textLink-foreground',
};

// Monaco parses only hex colors; a value in any other form is left to the base theme.
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function applyHostTheme(): void {
  const style = getComputedStyle(document.documentElement);
  const colors: Record<string, string> = {};
  for (const [id, variable] of Object.entries(THEME_COLORS)) {
    const value = style.getPropertyValue(variable).trim();
    if (HEX_COLOR.test(value)) colors[id] = value;
  }
  const light = document.body.classList.contains('vscode-light');
  monaco.editor.defineTheme(THEME_NAME, { base: light ? 'vs' : 'vs-dark', inherit: true, rules: [], colors });
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
}

/** Options every Damocles Monaco editor shares: the host's editor font, read-only unless the caller overrides it. */
export function baseEditorOptions(): monaco.editor.IEditorOptions & { automaticLayout: boolean } {
  const style = getComputedStyle(document.documentElement);
  const fontFamily = style.getPropertyValue('--vscode-editor-font-family').trim();
  const fontSize = Number.parseInt(style.getPropertyValue('--vscode-editor-font-size'), 10);
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
