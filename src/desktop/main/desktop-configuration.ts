// scripts/generate-settings-schema.mjs imports this file through Node's type stripping: erasable TypeScript and no imports.
// Desktop-only settings, merged into the desktop settings store's contributed set; they never enter package.json.

export const THEME_SETTING = 'damocles.desktop.theme';
export const REDUCE_MOTION_SETTING = 'damocles.desktop.reduceMotion';
export const LANGUAGE_SETTING = 'damocles.desktop.language';
export const RESTORE_LAYOUT_SETTING = 'damocles.desktop.restoreLayout';
export const NOTIFICATIONS_SETTING = 'damocles.desktop.notifications.enabled';
export const NOTIFICATION_SOUND_SETTING = 'damocles.desktop.notifications.sound';
export const EDITOR_FONT_SIZE_SETTING = 'damocles.desktop.editor.fontSize';
export const EDITOR_TAB_SIZE_SETTING = 'damocles.desktop.editor.tabSize';
export const EDITOR_DETECT_INDENTATION_SETTING = 'damocles.desktop.editor.detectIndentation';
export const EDITOR_WORD_WRAP_SETTING = 'damocles.desktop.editor.wordWrap';
export const EDITOR_MINIMAP_SETTING = 'damocles.desktop.editor.minimap';
export const EDITOR_RENDER_WHITESPACE_SETTING = 'damocles.desktop.editor.renderWhitespace';
export const EDITOR_AUTO_SAVE_SETTING = 'damocles.desktop.editor.autoSave';
export const EDITOR_FORMAT_ON_SAVE_SETTING = 'damocles.desktop.editor.formatOnSave';
export const TERMINAL_DEFAULT_PROFILE_SETTING = 'damocles.desktop.terminal.defaultProfile';
export const TERMINAL_FONT_SIZE_SETTING = 'damocles.desktop.terminal.fontSize';
export const TERMINAL_SCROLLBACK_SETTING = 'damocles.desktop.terminal.scrollback';
export const TERMINAL_CURSOR_STYLE_SETTING = 'damocles.desktop.terminal.cursorStyle';
export const TERMINAL_FONT_FAMILY_SETTING = 'damocles.desktop.terminal.fontFamily';
export const TERMINAL_LINE_HEIGHT_SETTING = 'damocles.desktop.terminal.lineHeight';
export const TERMINAL_CURSOR_BLINKING_SETTING = 'damocles.desktop.terminal.cursorBlinking';
export const TERMINAL_MAC_OPTION_IS_META_SETTING = 'damocles.desktop.terminal.macOptionIsMeta';
export const TERMINAL_MULTI_LINE_PASTE_WARNING_SETTING = 'damocles.desktop.terminal.multiLinePasteWarning';
export const TERMINAL_SHELL_INTEGRATION_SETTING = 'damocles.desktop.terminal.shellIntegration.enabled';
export const TERMINAL_DECORATIONS_SETTING = 'damocles.desktop.terminal.shellIntegration.decorationsEnabled';
export const TERMINAL_CONFIRM_ON_KILL_SETTING = 'damocles.desktop.terminal.confirmOnKill';
export const TERMINAL_PROFILES_SETTING = 'damocles.desktop.terminal.profiles';
export const FILES_EXCLUDE_SETTING = 'damocles.desktop.files.exclude';
export const SEARCH_EXCLUDE_SETTING = 'damocles.desktop.search.exclude';
export const SEARCH_MODE_SETTING = 'damocles.desktop.search.mode';
export const SEARCH_SMART_CASE_SETTING = 'damocles.desktop.search.smartCase';
export const SEARCH_ON_TYPE_SETTING = 'damocles.desktop.search.searchOnType';
export const SEARCH_ON_TYPE_DEBOUNCE_SETTING = 'damocles.desktop.search.searchOnTypeDebouncePeriod';
export const SEARCH_SORT_ORDER_SETTING = 'damocles.desktop.search.sortOrder';
export const SEARCH_COLLAPSE_RESULTS_SETTING = 'damocles.desktop.search.collapseResults';
export const SEARCH_SHOW_LINE_NUMBERS_SETTING = 'damocles.desktop.search.showLineNumbers';
export const SEARCH_SEED_ON_FOCUS_SETTING = 'damocles.desktop.search.seedOnFocus';
export const SEARCH_SEED_WITH_NEAREST_WORD_SETTING = 'damocles.desktop.search.seedWithNearestWord';
export const SEARCH_USE_REPLACE_PREVIEW_SETTING = 'damocles.desktop.search.useReplacePreview';
export const SEARCH_DEFAULT_VIEW_MODE_SETTING = 'damocles.desktop.search.defaultViewMode';
export const SEARCH_ACTIONS_POSITION_SETTING = 'damocles.desktop.search.actionsPosition';
export const SEARCH_MAX_RESULTS_SETTING = 'damocles.desktop.search.maxResults';
export const SEARCH_EDITOR_DOUBLE_CLICK_SETTING = 'damocles.desktop.searchEditor.doubleClickBehaviour';
export const SEARCH_EDITOR_REUSE_PRIOR_SETTING = 'damocles.desktop.searchEditor.reusePriorSearchConfiguration';
export const SEARCH_EDITOR_CONTEXT_LINES_SETTING = 'damocles.desktop.searchEditor.defaultNumberOfContextLines';
export const SEARCH_EDITOR_FOCUS_RESULTS_SETTING = 'damocles.desktop.searchEditor.focusResultsOnSearch';

export const EDITOR_WORD_WRAPS = ['off', 'on'] as const;
export const EDITOR_RENDER_WHITESPACES = ['none', 'boundary', 'selection', 'trailing', 'all'] as const;
export const EDITOR_AUTO_SAVES = ['off', 'afterDelay', 'onFocusChange'] as const;
export const TERMINAL_CURSOR_STYLES = ['block', 'underline', 'bar'] as const;
// VS Code's terminal.integrated.enableMultiLinePasteWarning values.
export const TERMINAL_MULTI_LINE_PASTE_WARNINGS = ['auto', 'always', 'never'] as const;
export type TerminalMultiLinePasteWarning = (typeof TERMINAL_MULTI_LINE_PASTE_WARNINGS)[number];
export const TERMINAL_CONFIRM_ON_KILL_VALUES = ['running', 'always', 'never'] as const;
export type TerminalConfirmOnKill = (typeof TERMINAL_CONFIRM_ON_KILL_VALUES)[number];
// VS Code's search.* and search.searchEditor.* enums (search.common.contribution.ts, search.contribution.ts, searchEditor.contribution.ts).
export const SEARCH_MODES = ['view', 'reuseEditor', 'newEditor'] as const;
export const SEARCH_SORT_ORDERS = ['default', 'fileNames', 'type', 'modified', 'countDescending', 'countAscending'] as const;
export const SEARCH_COLLAPSE_RESULTS = ['auto', 'alwaysCollapse', 'alwaysExpand'] as const;
export const SEARCH_DEFAULT_VIEW_MODES = ['tree', 'list'] as const;
export const SEARCH_ACTIONS_POSITIONS = ['auto', 'right'] as const;
export const SEARCH_EDITOR_DOUBLE_CLICK = ['selectWord', 'goToLocation', 'openLocationToSide'] as const;
// Must stay equal to MAX_SEARCH_RESULTS and MAX_CONTEXT_LINES in src/shared/text-search.ts.
export const SEARCH_MAX_RESULTS = 20000;
export const SEARCH_EDITOR_MAX_CONTEXT_LINES = 100;
export type TerminalCursorStyle = (typeof TERMINAL_CURSOR_STYLES)[number];
// Change Icon...'s lucide icons; a terminal shows its custom icon instead of its profile's.
export const TERMINAL_CUSTOM_ICONS = [
  'terminal',
  'square-terminal',
  'code',
  'bug',
  'rocket',
  'server',
  'database',
  'cloud',
  'container',
  'package',
  'git-branch',
  'globe',
  'cpu',
  'monitor',
  'flask-conical',
  'activity',
  'gauge',
  'zap',
  'flame',
  'sparkles',
  'star',
  'heart',
  'wrench',
  'bot',
] as const;
// Change Color...'s hues, in --d-ansi-0..7 order: a color's index names its token.
export const TERMINAL_COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;
// VS Code's files.exclude default (files.contribution.ts).
export const DEFAULT_FILES_EXCLUDE: Readonly<Record<string, boolean>> = {
  '**/.git': true,
  '**/.svn': true,
  '**/.hg': true,
  '**/.jj': true,
  '**/.DS_Store': true,
  '**/Thumbs.db': true,
};
// VS Code's search.exclude default (search.common.contribution.ts).
export const DEFAULT_SEARCH_EXCLUDE: Readonly<Record<string, boolean>> = {
  '**/node_modules': true,
  '**/bower_components': true,
  '**/*.code-search': true,
};

export const THEME_PREFERENCES = ['system', 'dark', 'light'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const DESKTOP_LANGUAGES = ['system', 'en', 'el'] as const;
export type DesktopLanguageSetting = (typeof DESKTOP_LANGUAGES)[number];

// The one check every reader of damocles.desktop.language uses, the --lang switch included; anything else reads as system.
export function parseDesktopLanguage(value: unknown): DesktopLanguageSetting {
  return (DESKTOP_LANGUAGES as readonly unknown[]).includes(value) ? (value as DesktopLanguageSetting) : 'system';
}

export interface DesktopSettingProperty {
  readonly type: string;
  readonly default: unknown;
  readonly scope: 'application';
  readonly description: string;
  readonly enum?: readonly string[];
  readonly enumDescriptions?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  // an object setting: each value's schema
  readonly additionalProperties?: DesktopSettingValueSchema;
}

// The JSON Schema an object setting's values follow, which scripts/generate-settings-schema.mjs copies into the settings schema.
export interface DesktopSettingValueSchema {
  readonly type?: string | readonly string[];
  readonly anyOf?: readonly DesktopSettingValueSchema[];
  readonly properties?: Readonly<Record<string, DesktopSettingValueSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: false;
  readonly items?: DesktopSettingValueSchema;
  readonly enum?: readonly string[];
  readonly description?: string;
}

export const DESKTOP_CONFIGURATION: Readonly<Record<string, DesktopSettingProperty>> = {
  [THEME_SETTING]: {
    type: 'string',
    enum: THEME_PREFERENCES,
    enumDescriptions: ['Follow the operating system.', 'Damocles Dark.', 'Damocles Light.'],
    default: 'system',
    scope: 'application',
    description: 'Color theme of the desktop app.',
  },
  [REDUCE_MOTION_SETTING]: {
    type: 'boolean',
    default: false,
    scope: 'application',
    description: 'Stop non-essential animation in the desktop app. The operating system\'s reduced-motion preference applies as well.',
  },
  [LANGUAGE_SETTING]: {
    type: 'string',
    enum: DESKTOP_LANGUAGES,
    enumDescriptions: ['Follow the operating system.', 'English.', 'Greek.'],
    default: 'system',
    scope: 'application',
    description: 'Display language of the desktop app. A change applies after a restart.',
  },
  [RESTORE_LAYOUT_SETTING]: {
    type: 'boolean',
    default: true,
    scope: 'application',
    description: 'Reopen the window layout and the chats that were open when the app last quit. When off, the app starts with the default layout and a new chat.',
  },
  [NOTIFICATIONS_SETTING]: {
    type: 'boolean',
    default: true,
    scope: 'application',
    description: 'Show pop-ups when a chat needs you (an approval, a plan, a question, a team review, a finished, paused or limited chat) at the bottom-right of the screen, above other apps. When off, they still collect in the notification center.',
  },
  [NOTIFICATION_SOUND_SETTING]: {
    type: 'boolean',
    default: true,
    scope: 'application',
    description: 'Play a short sound with each desktop pop-up.',
  },
  [EDITOR_FONT_SIZE_SETTING]: {
    type: 'integer',
    default: 13,
    minimum: 6,
    maximum: 100,
    scope: 'application',
    description: 'Font size of the desktop editor, in pixels.',
  },
  [EDITOR_TAB_SIZE_SETTING]: {
    type: 'integer',
    default: 4,
    minimum: 1,
    maximum: 16,
    scope: 'application',
    description: 'The number of spaces a tab is equal to in the desktop editor. Detect indentation overrides it per file.',
  },
  [EDITOR_DETECT_INDENTATION_SETTING]: {
    type: 'boolean',
    default: true,
    scope: 'application',
    description: 'Detect the tab size and whether a file indents with tabs or spaces from its content.',
  },
  [EDITOR_WORD_WRAP_SETTING]: {
    type: 'string',
    enum: EDITOR_WORD_WRAPS,
    enumDescriptions: ['Lines never wrap.', 'Lines wrap at the editor width.'],
    default: 'off',
    scope: 'application',
    description: 'How the desktop editor wraps long lines.',
  },
  [EDITOR_MINIMAP_SETTING]: {
    type: 'boolean',
    default: true,
    scope: 'application',
    description: 'Show the minimap beside the desktop editor.',
  },
  [EDITOR_RENDER_WHITESPACE_SETTING]: {
    type: 'string',
    enum: EDITOR_RENDER_WHITESPACES,
    enumDescriptions: [
      'Never show whitespace characters.',
      'Show whitespace except single spaces between words.',
      'Show whitespace in selected text only.',
      'Show trailing whitespace only.',
      'Show every whitespace character.',
    ],
    default: 'selection',
    scope: 'application',
    description: 'How the desktop editor shows whitespace characters.',
  },
  [EDITOR_AUTO_SAVE_SETTING]: {
    type: 'string',
    enum: EDITOR_AUTO_SAVES,
    enumDescriptions: ['Files save only when you save them.', 'A changed file saves one second after the last edit.', 'A changed file saves when the editor loses focus.'],
    default: 'off',
    scope: 'application',
    description: 'When the desktop editor saves changed files by itself.',
  },
  [EDITOR_FORMAT_ON_SAVE_SETTING]: {
    type: 'boolean',
    default: false,
    scope: 'application',
    description: 'Format a file when you save it, and when auto save runs on focus change. A trusted project\'s own Prettier 2 or 3 formats it; without Prettier, TypeScript, JavaScript and JSON use the built-in formatter. Nothing formats in an untrusted folder.',
  },
  [TERMINAL_DEFAULT_PROFILE_SETTING]: {
    type: 'string',
    default: '',
    scope: 'application',
    description: 'The id of the shell a new terminal starts when none is chosen, such as pwsh, cmd, git-bash, wsl:Ubuntu, zsh or bash. Empty, or a shell that is not installed, starts the first one detected.',
  },
  [TERMINAL_FONT_SIZE_SETTING]: {
    type: 'integer',
    default: 13,
    minimum: 6,
    maximum: 32,
    scope: 'application',
    description: 'Font size of the desktop terminal, in pixels.',
  },
  [TERMINAL_SCROLLBACK_SETTING]: {
    type: 'integer',
    default: 1000,
    minimum: 0,
    maximum: 100000,
    scope: 'application',
    description: 'The number of lines the desktop terminal keeps above the screen.',
  },
  [TERMINAL_CURSOR_STYLE_SETTING]: {
    type: 'string',
    enum: TERMINAL_CURSOR_STYLES,
    enumDescriptions: ['A block cursor.', 'An underline cursor.', 'A vertical bar cursor.'],
    default: 'block',
    scope: 'application',
    description: 'The shape of the desktop terminal cursor.',
  },
  [TERMINAL_FONT_FAMILY_SETTING]: {
    type: 'string',
    default: '',
    scope: 'application',
    description: 'The font family of the desktop terminal, as a CSS font-family list. Empty uses the app\'s monospace font.',
  },
  [TERMINAL_LINE_HEIGHT_SETTING]: {
    type: 'number',
    default: 1.2,
    minimum: 1,
    maximum: 2,
    scope: 'application',
    description: 'The line height of the desktop terminal, multiplied by its font size.',
  },
  [TERMINAL_CURSOR_BLINKING_SETTING]: {
    type: 'boolean',
    default: false,
    scope: 'application',
    description: 'Whether the desktop terminal cursor blinks.',
  },
  [TERMINAL_MAC_OPTION_IS_META_SETTING]: {
    type: 'boolean',
    default: false,
    scope: 'application',
    description: 'On macOS, treat the Option key as the Meta key in the desktop terminal.',
  },
  [TERMINAL_MULTI_LINE_PASTE_WARNING_SETTING]: {
    type: 'string',
    enum: TERMINAL_MULTI_LINE_PASTE_WARNINGS,
    enumDescriptions: [
      'Ask before pasting more than one line, except when the shell has bracketed paste mode on or the only line break is a final one, which is dropped.',
      'Always ask before pasting text that contains a line break.',
      'Never ask.',
    ],
    default: 'auto',
    scope: 'application',
    description: 'Whether to ask before pasting several lines into the desktop terminal.',
  },
  [TERMINAL_SHELL_INTEGRATION_SETTING]: {
    type: 'boolean',
    default: true,
    scope: 'application',
    description: 'Start PowerShell, bash, Git Bash, zsh and fish with Damocles\' shell integration script, which reports each command, its exit code and the working directory. Applies to terminals started afterwards.',
  },
  [TERMINAL_DECORATIONS_SETTING]: {
    type: 'boolean',
    default: true,
    scope: 'application',
    description: 'Show a mark beside each command in the desktop terminal with its exit code, when shell integration is active.',
  },
  [TERMINAL_CONFIRM_ON_KILL_SETTING]: {
    type: 'string',
    enum: TERMINAL_CONFIRM_ON_KILL_VALUES,
    enumDescriptions: [
      'Ask before killing a terminal that runs a command.',
      'Ask before killing any terminal whose shell is still running.',
      'Never ask.',
    ],
    default: 'running',
    scope: 'application',
    description: 'Whether to ask before killing desktop terminals: Kill, Kill All, closing the window, removing a project and quitting.',
  },
  // Validated by terminal/user-profiles.ts, never by isDesktopSettingValue, so prefs:set cannot write it.
  [TERMINAL_PROFILES_SETTING]: {
    type: 'object',
    additionalProperties: {
      anyOf: [
        {
          type: 'object',
          properties: {
            path: {
              anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
              description: 'The executable of the shell: an absolute path, or a file name found on PATH. With a list, the first one that exists is used.',
            },
            args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed to the shell, one per entry.' },
            icon: { type: 'string', enum: TERMINAL_CUSTOM_ICONS, description: 'The icon terminals of this profile show.' },
            color: { type: 'string', enum: TERMINAL_COLORS, description: 'The color of the icon terminals of this profile show.' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        { type: 'null', description: 'Hides the detected profile of this name.' },
      ],
    },
    default: {},
    scope: 'application',
    description: 'Terminal profiles by name, read from the user settings file only. An entry adds a profile or replaces the detected one of the same name; null hides a detected profile. Settings › Terminal lists every entry Damocles refused and why.',
  },
  [FILES_EXCLUDE_SETTING]: {
    type: 'object',
    additionalProperties: { type: 'boolean' },
    default: DEFAULT_FILES_EXCLUDE,
    scope: 'application',
    description: 'Glob patterns of files and folders the Files section hides; Quick Open and Search skip them too. A pattern set to false is shown.',
  },
  [SEARCH_EXCLUDE_SETTING]: {
    type: 'object',
    additionalProperties: { type: 'boolean' },
    default: DEFAULT_SEARCH_EXCLUDE,
    scope: 'application',
    description: 'Glob patterns of files and folders Search and Quick Open skip, on top of the Files exclude patterns. The Search toggle "Use Exclude Settings and Ignore Files" turns them off for one search. A pattern set to false is searched.',
  },
  [SEARCH_MODE_SETTING]: {
    type: 'string',
    enum: SEARCH_MODES,
    enumDescriptions: ['Search in the Search view.', 'Search in an existing search editor if present, otherwise in a new search editor.', 'Search in a new search editor.'],
    default: 'view',
    scope: 'application',
    description: 'Controls where new Find in Files and Find in Folder operations occur: either in the Search view, or in a search editor.',
  },
  [SEARCH_SMART_CASE_SETTING]: {
    type: 'boolean',
    default: false,
    scope: 'application',
    description: 'Search case-insensitively if the pattern is all lowercase, otherwise, search case-sensitively.',
  },
  [SEARCH_ON_TYPE_SETTING]: {
    type: 'boolean',
    default: true,
    scope: 'application',
    description: 'Search all files as you type.',
  },
  [SEARCH_ON_TYPE_DEBOUNCE_SETTING]: {
    type: 'integer',
    default: 300,
    minimum: 0,
    maximum: 10000,
    scope: 'application',
    description: 'When search on type is on, the time in milliseconds between a character being typed and the search starting.',
  },
  [SEARCH_SORT_ORDER_SETTING]: {
    type: 'string',
    enum: SEARCH_SORT_ORDERS,
    enumDescriptions: [
      'Results are sorted by folder and file names, in alphabetical order.',
      'Results are sorted by file names ignoring folder order, in alphabetical order.',
      'Results are sorted by file extensions, in alphabetical order.',
      'Results are sorted by file last modified date, in descending order.',
      'Results are sorted by count per file, in descending order.',
      'Results are sorted by count per file, in ascending order.',
    ],
    default: 'default',
    scope: 'application',
    description: 'Controls sorting order of search results.',
  },
  [SEARCH_COLLAPSE_RESULTS_SETTING]: {
    type: 'string',
    enum: SEARCH_COLLAPSE_RESULTS,
    enumDescriptions: ['Files with less than 10 results are expanded. Others are collapsed.', 'Every file is collapsed.', 'Every file is expanded.'],
    default: 'alwaysExpand',
    scope: 'application',
    description: 'Controls whether the search results will be collapsed or expanded.',
  },
  [SEARCH_SHOW_LINE_NUMBERS_SETTING]: {
    type: 'boolean',
    default: false,
    scope: 'application',
    description: 'Controls whether to show line numbers for search results.',
  },
  [SEARCH_SEED_ON_FOCUS_SETTING]: {
    type: 'boolean',
    default: false,
    scope: 'application',
    description: 'Update the search query to the editor\'s selected text when focusing the Search view.',
  },
  [SEARCH_SEED_WITH_NEAREST_WORD_SETTING]: {
    type: 'boolean',
    default: false,
    scope: 'application',
    description: 'Enable seeding search from the word nearest the cursor when the active editor has no selection.',
  },
  [SEARCH_USE_REPLACE_PREVIEW_SETTING]: {
    type: 'boolean',
    default: true,
    scope: 'application',
    description: 'Controls whether to open Replace Preview when selecting or replacing a match.',
  },
  [SEARCH_DEFAULT_VIEW_MODE_SETTING]: {
    type: 'string',
    enum: SEARCH_DEFAULT_VIEW_MODES,
    enumDescriptions: ['Shows search results as a tree.', 'Shows search results as a list.'],
    default: 'list',
    scope: 'application',
    description: 'Controls the default search result view mode.',
  },
  [SEARCH_ACTIONS_POSITION_SETTING]: {
    type: 'string',
    enum: SEARCH_ACTIONS_POSITIONS,
    enumDescriptions: [
      'Position the actions to the right when the Search view is narrow, and immediately after the content when the Search view is wide.',
      'Always position the actions to the right.',
    ],
    default: 'right',
    scope: 'application',
    description: 'Controls the positioning of the actions on rows in the Search view.',
  },
  [SEARCH_MAX_RESULTS_SETTING]: {
    type: 'integer',
    default: SEARCH_MAX_RESULTS,
    minimum: 1,
    maximum: SEARCH_MAX_RESULTS,
    scope: 'application',
    description: 'Controls the maximum number of search results, at most 20000.',
  },
  [SEARCH_EDITOR_DOUBLE_CLICK_SETTING]: {
    type: 'string',
    enum: SEARCH_EDITOR_DOUBLE_CLICK,
    enumDescriptions: [
      'Double-clicking selects the word under the cursor.',
      'Double-clicking opens the result in the editor.',
      'Double-clicking opens the result in the editor pane, showing the pane if it is hidden.',
    ],
    default: 'goToLocation',
    scope: 'application',
    description: 'Configure effect of double-clicking a result in a search editor.',
  },
  [SEARCH_EDITOR_REUSE_PRIOR_SETTING]: {
    type: 'boolean',
    default: false,
    scope: 'application',
    description: 'When enabled, new Search Editors will reuse the includes, excludes, and flags of the previously opened Search Editor.',
  },
  [SEARCH_EDITOR_CONTEXT_LINES_SETTING]: {
    type: 'integer',
    default: 1,
    minimum: 0,
    maximum: SEARCH_EDITOR_MAX_CONTEXT_LINES,
    scope: 'application',
    description: 'The default number of surrounding context lines to use when creating new Search Editors.',
  },
  [SEARCH_EDITOR_FOCUS_RESULTS_SETTING]: {
    type: 'boolean',
    default: false,
    scope: 'application',
    description: 'When a search is triggered, focus the Search Editor results instead of the Search Editor input.',
  },
};

// Patterns of an object setting from a settings write; a glob is at most this long and there are at most this many.
const MAX_OBJECT_SETTING_KEYS = 500;
const MAX_OBJECT_SETTING_KEY_LENGTH = 1000;
// Characters of a string setting without an enum, such as a font family or a profile id.
const MAX_STRING_SETTING_LENGTH = 1000;

/** Whether `value` fits the declared type, range and enum of the desktop setting `key`; false for a key that is not declared. */
export function isDesktopSettingValue(key: string, value: unknown): boolean {
  if (!Object.hasOwn(DESKTOP_CONFIGURATION, key)) return false;
  const property = DESKTOP_CONFIGURATION[key]!;
  if (property.type === 'boolean') return typeof value === 'boolean';
  if (property.type === 'integer' || property.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (property.type === 'integer' && !Number.isInteger(value))) return false;
    return value >= (property.minimum ?? -Infinity) && value <= (property.maximum ?? Infinity);
  }
  if (property.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const entries = Object.entries(value);
    const valueType = property.additionalProperties?.type;
    if (typeof valueType !== 'string') return false;
    return entries.length <= MAX_OBJECT_SETTING_KEYS && entries.every(([glob, flag]) => glob.length > 0 && glob.length <= MAX_OBJECT_SETTING_KEY_LENGTH && typeof flag === valueType);
  }
  if (property.type !== 'string' || typeof value !== 'string') return false;
  return property.enum === undefined ? value.length <= MAX_STRING_SETTING_LENGTH : property.enum.includes(value);
}
