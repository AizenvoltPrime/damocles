// The shell page's Monaco: the chat page's setup plus TypeScript's language service, which reports syntax errors only (D5, AD5).
// The service runs in the module worker ts.worker; the shell fetches all of it only when the first text tab opens.
import { getJavaScriptWorker, getTypeScriptWorker, javascriptDefaults, typescriptDefaults } from 'monaco-editor/languages/features/typescript/register';
import TypeScriptWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker';
import { getWorker as getJsonWorker } from 'monaco-editor/languages/features/json/register';
import settingsSchema from '@shared/generated/settings-schema.json';
import type { SettingsFileScope } from '@shared/types/messages';
import { addLanguageWorker, baseEditorOptions, jsonDefaults, useMonaco, type Monaco } from '@/components/editor/useMonaco';
import { builtinEdits, lineEdits, type BuiltinWorkers } from './format-edits';
import { SEARCH_RESULT_LANGUAGE_ID, searchResultLanguage } from './search-result-language';

// The worker labels are the TypeScript service's mode ids (workerManager.js).
addLanguageWorker(['typescript', 'javascript'], () => new TypeScriptWorker());

// Format Document is only the command registry's (D29). Without Monaco's formatting providers, its F1 and its Shift+Alt+F
// (Ctrl+Shift+I on Linux) offer no Format Document or Format Selection that would skip the project's formatter or take the
// key from the menu accelerator; the built-in format step calls the workers itself (format-edits.ts).
for (const defaults of [typescriptDefaults, javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  defaults.setModeConfiguration({ ...defaults.modeConfiguration, documentRangeFormattingEdits: false, onTypeFormattingEdits: false });
}
jsonDefaults.setModeConfiguration({ ...jsonDefaults.modeConfiguration, documentFormattingEdits: false, documentRangeFormattingEdits: false });

/** Whether a language has a definition or reference provider here; only the TypeScript service registers them (tsMode.js). */
export function hasGoToProvider(languageId: string, kind: 'definitions' | 'references'): boolean {
  const defaults = languageId === 'typescript' ? typescriptDefaults : languageId === 'javascript' ? javascriptDefaults : undefined;
  return defaults?.modeConfiguration[kind] === true;
}

/**
 * A settings tab's model URI, which the schemas below match: unknown keys are flagged, and user-only keys in a project file.
 * The document id keeps two documents of one scope (two projects' project files) on two models.
 */
export const settingsModelUri = (scope: SettingsFileScope, documentId: string): string => `inmemory://damocles/settings/${scope}/${encodeURIComponent(documentId)}.json`;

// VS Code's JSON with Comments files that main opens as json (extensions/json, configuration-editing and typescript-basics
// package.json `jsonc` contributions). A pattern matches a path's end, as the language service puts `**/` before it.
const JSONC_FILES = [
  '*.jsonc', '*.code-workspace', '*.eslintrc.json', '*language-configuration.json', '*icon-theme.json', '*color-theme.json',
  'babel.config.json', '.babelrc.json', 'typedoc.json', '.github/hooks/*.json',
  'settings.json', 'launch.json', 'tasks.json', 'mcp.json', 'keybindings.json', 'extensions.json', 'argv.json', 'profiles.json',
  'devcontainer.json', '.devcontainer.json',
  'tsconfig.json', 'jsconfig.json', 'tsconfig.*.json', 'jsconfig.*.json', 'tsconfig-*.json', 'jsconfig-*.json',
  // Damocles parses its settings and MCP files with JSON.parse, so a comment there breaks them.
  '!.damocles/settings.json', '!.damocles/mcp.json',
];

// VS Code's json language: comments and trailing commas are errors (jsonServer.ts validateTextDocument). Its jsonc ignores
// both here, through the schema below, since Monaco has one set of options per language; VS Code warns on a jsonc trailing
// comma. Settings models match no jsonc pattern, so they stay as strict as the host's JSON.parse.
jsonDefaults.setDiagnosticsOptions({
  validate: true,
  allowComments: false,
  comments: 'error',
  trailingCommas: 'error',
  schemaValidation: 'error',
  enableSchemaRequest: false,
  schemas: [
    { uri: 'inmemory://damocles/schemas/settings-user.json', fileMatch: ['inmemory://damocles/settings/user/*.json'], schema: settingsSchema.user },
    { uri: 'inmemory://damocles/schemas/settings-project.json', fileMatch: ['inmemory://damocles/settings/project/*.json', 'inmemory://damocles/settings/local/*.json'], schema: settingsSchema.project },
    { uri: 'inmemory://damocles/schemas/jsonc.json', fileMatch: JSONC_FILES, schema: { allowComments: true, allowTrailingCommas: true } },
  ],
});

const monacoApi = useMonaco();
monacoApi.languages.register({ id: SEARCH_RESULT_LANGUAGE_ID });
monacoApi.languages.setMonarchTokensProvider(SEARCH_RESULT_LANGUAGE_ID, searchResultLanguage);

/** The workers behind the built-in formatters; the JSON worker's typings omit the format method its provider calls. */
export const builtinWorkers: BuiltinWorkers = {
  typescript: getTypeScriptWorker,
  javascript: getJavaScriptWorker,
  json: getJsonWorker as unknown as BuiltinWorkers['json'],
};

// The format step's edits load with Monaco, which every buffer needs first, so they stay out of the shell's first bundle.
export { baseEditorOptions, builtinEdits, lineEdits, useMonaco, type Monaco };
