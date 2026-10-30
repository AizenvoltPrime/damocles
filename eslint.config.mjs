import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import globals from 'globals';
import betterTailwindcss from 'eslint-plugin-better-tailwindcss';
import { getDefaultSelectors } from 'eslint-plugin-better-tailwindcss/defaults';

// eslint-plugin-n's no-sync throws on a TypeScript file without typed linting (17.x and 18.x), so this is its untyped
// form: a call to any *Sync function or method. Its own rule id keeps its own count in eslint-suppressions.json.
// `this._with…Sync(op)` (pi-runtime.ts) chains `op` on an async synchronisation queue and blocks nothing.
const ASYNC_QUEUE_HELPER = /^_with\w*Sync$/;
const noSync = {
  meta: { type: 'problem', messages: { noSync: "Unexpected sync method: '{{name}}'. It blocks the UI or every chat (docs/perf.md)." }, schema: [] },
  create(context) {
    const report = (node) => context.report({ node, messageId: 'noSync', data: { name: node.name } });
    return {
      'CallExpression > MemberExpression.callee > Identifier.property[name=/Sync$/]': (node) => {
        if (node.parent.object.type !== 'ThisExpression' || !ASYNC_QUEUE_HELPER.test(node.name)) report(node);
      },
      'CallExpression > Identifier.callee[name=/Sync$/]': report,
    };
  },
};
const damoclesPlugin = { rules: { 'no-sync': noSync } };
// Files only worker threads load, where a synchronous call blocks no UI or chat thread. Listed one by one, because a
// folder can hold a file the host imports (compass/detect.ts); scripts/__tests__/no-sync-lint-scope.test.ts fails when
// a host bundle includes one.
export const WORKER_ONLY_FILES = [
  'src/core/compass/communities.ts',
  'src/core/compass/compass-worker.ts',
  'src/core/compass/composer-resolver.ts',
  'src/core/compass/context-savings.ts',
  'src/core/compass/changes.ts',
  'src/core/compass/database.ts',
  'src/core/compass/db-wrapper.ts',
  'src/core/compass/extractor-base.ts',
  'src/core/compass/extractors/ast-helpers.ts',
  'src/core/compass/extractors/index.ts',
  'src/core/compass/extractors/lang-maps.ts',
  'src/core/compass/extractors/vue.ts',
  'src/core/compass/extractors/walker.ts',
  'src/core/compass/flows.ts',
  'src/core/compass/git.ts',
  'src/core/compass/impact.ts',
  'src/core/compass/import-resolver.ts',
  'src/core/compass/incremental.ts',
  'src/core/compass/java-resolver.ts',
  'src/core/compass/known-externals.ts',
  'src/core/compass/mcp-handlers.ts',
  'src/core/compass/migrations.ts',
  'src/core/compass/post-process.ts',
  'src/core/compass/refactor.ts',
  'src/core/compass/schema.ts',
  'src/core/compass/search.ts',
  'src/core/compass/tsconfig-resolver.ts',
  'src/core/compass/validation.ts',
  'src/core/compass/vite-alias-resolver.ts',
  'src/core/compass/worker-core.ts',
  'src/core/memory/integrity-worker.ts',
  'src/core/pi-session/session-store/meta-index/store.ts',
  'src/core/pi-session/tools/shell-sentinel.ts',
  'src/core/usage-stats/database.ts',
  'src/core/usage-stats/entry-parser.ts',
  'src/core/usage-stats/indexer.ts',
  'src/core/usage-stats/queries.ts',
  'src/core/usage-stats/usage-stats-worker.ts',
];
// UI-thread, extension-host and daemon code, where a synchronous call freezes the window, every chat or every remote client
// (docs/perf.md).
export const NO_SYNC_FILES = [
  'src/core/**/*.ts',
  'src/desktop/main/**/*.ts',
  'src/desktop/core-host/**/*.ts',
  'src/desktop/core-protocol/**/*.ts',
  'src/desktop/local-services/**/*.ts',
  'src/desktop/workspace/**/*.ts',
  'src/desktop/daemon/**/*.ts',
  'src/remote/**/*.ts',
  'src/platform/**/*.ts',
  'src/shared/**/*.ts',
  'src/vscode/**/*.ts',
];

const VSCODE_ONLY = 'Only src/vscode may import vscode; core code reaches the host through src/platform.';
const NO_ELECTRON = 'Only src/desktop may import electron.';
const NO_ELECTRON_SHELL = 'The shell renderer never imports electron; it reaches main only through window.damoclesShell.';
const NO_ELECTRON_WORKER = 'The Quick Open and watch workers are plain Node worker threads and never import electron.';
const NO_ELECTRON_CORE = 'Damocles Core reaches the host only through the core protocol (src/desktop/core-protocol), never electron.';
const NO_MAIN_IN_CORE = 'Damocles Core never imports desktop main; it reaches main only through the core protocol.';
const NO_CORE_HOST_IN_MAIN = 'Desktop main reaches Damocles Core only through the core protocol (core-client.ts); import a type.';
const NO_HOST_IN_REMOTE = 'The wire (src/remote) runs in the app and on every target: it imports only Node built-ins, never vscode, electron, src/core or src/desktop.';
const NO_ELECTRON_NODE_HOST = 'The pty and formatter hosts also run as plain Node children of the daemon on a target, so they never import electron.';

// no-restricted-imports misses dynamic import(), typeof import() and vi.mock, so these selectors close the same boundary.
function moduleSyntax(pattern, message) {
  return [
    { selector: `ImportExpression[source.value=${pattern}]`, message },
    { selector: `TSImportType[source.value=${pattern}]`, message },
    {
      selector: `CallExpression[callee.object.name='vi'][callee.property.name=/^(mock|doMock|importActual)$/][arguments.0.value=${pattern}]`,
      message,
    },
  ];
}
const VSCODE_SYNTAX = moduleSyntax("'vscode'", VSCODE_ONLY);
// The value forms no-restricted-imports misses, for a ban that allows type imports: `typeof import()` stays allowed.
function valueImportSyntax(pattern, message) {
  return [
    { selector: `ImportExpression[source.value=${pattern}]`, message },
    { selector: `CallExpression[callee.name='require'][arguments.0.value=${pattern}]`, message },
  ];
}

// `electron` and every `electron/*` subpath. An esquery regex cannot contain a raw slash, hence \u002F.
function electronBan(message) {
  return {
    path: { name: 'electron', message },
    pattern: { group: ['electron/*'], message },
    syntax: moduleSyntax('/^electron(\\u002F|$)/', message),
  };
}
const OUTSIDE_DESKTOP = electronBan(NO_ELECTRON);
const IN_SHELL = electronBan(NO_ELECTRON_SHELL);
const IN_WORKER = electronBan(NO_ELECTRON_WORKER);
const IN_CORE_HOST = electronBan(NO_ELECTRON_CORE);
const IN_NODE_HOST = electronBan(NO_ELECTRON_NODE_HOST);
// desktop main by any relative path; an esquery regex cannot contain a raw slash, hence \u002F
const MAIN_FROM_CORE = {
  pattern: { regex: '^(?:\\.\\./)+(?:desktop/)?main(?:/|$)', message: NO_MAIN_IN_CORE },
  syntax: moduleSyntax('/^(?:\\.\\.\\u002F)+(?:desktop\\u002F)?main(\\u002F|$)/', NO_MAIN_IN_CORE),
};
// src/core and src/desktop by any relative path from src/remote; an esquery regex cannot contain a raw slash, hence \u002F
const HOST_FROM_REMOTE = {
  pattern: { regex: '^(?:\\.\\./)+(?:core|desktop)(?:/|$)', message: NO_HOST_IN_REMOTE },
  syntax: moduleSyntax('/^(?:\\.\\.\\u002F)+(?:core|desktop)(\\u002F|$)/', NO_HOST_IN_REMOTE),
};
const IN_REMOTE = electronBan(NO_HOST_IN_REMOTE);
// Damocles Core's own code from desktop main; type imports stay allowed
const CORE_HOST_FROM_MAIN = {
  pattern: { regex: '^(?:\\.\\./)+(?:desktop/)?core-host(?:/|$)', message: NO_CORE_HOST_IN_MAIN, allowTypeImports: true },
  syntax: valueImportSyntax('/^(?:\\.\\.\\u002F)+(?:desktop\\u002F)?core-host(\\u002F|$)/', NO_CORE_HOST_IN_MAIN),
};
// From a folder below src/desktop/main, ../core-host is main's own core-host.ts; src/desktop/core-host is two levels up or more.
const CORE_HOST_FROM_MAIN_SUBFOLDER = {
  pattern: { regex: '^(?:\\.\\./){2,}(?:desktop/)?core-host(?:/|$)', message: NO_CORE_HOST_IN_MAIN, allowTypeImports: true },
  syntax: valueImportSyntax('/^(?:\\.\\.\\u002F){2,}(?:desktop\\u002F)?core-host(\\u002F|$)/', NO_CORE_HOST_IN_MAIN),
};

// Process starts go through src/core/process-launcher, whose workers keep a slow CreateProcessW off the UI and chat threads.
const NO_PROCESS_START = 'Start processes through src/core/process-launcher (docs/perf.md "Process launcher"), never on this thread.';
const PROCESS_START_MODULES = ['child_process', 'node:child_process', 'cross-spawn'];
const PROCESS_BAN = {
  // `import type { ChildProcess }` starts nothing
  paths: PROCESS_START_MODULES.map((name) => ({ name, message: NO_PROCESS_START, allowTypeImports: true })),
  syntax: [
    { selector: 'ImportExpression[source.value=/^(?:node:)?child_process$|^cross-spawn$/]', message: NO_PROCESS_START },
    { selector: "CallExpression[callee.name='require'][arguments.0.value=/^(?:node:)?child_process$|^cross-spawn$/]", message: NO_PROCESS_START },
  ],
};
// The build maps every bundled fs import to original-fs under Electron (scripts/esbuild-original-fs.mjs); a runtime lookup
// bypasses it. An esquery regex cannot contain a raw slash, hence \u002F.
const NO_FS_BUILTIN = 'Import fs; the build maps it to original-fs under Electron (scripts/esbuild-original-fs.mjs, docs/invariants.md "Desktop packaging and updates").';
const FS_MODULE = '/^(?:node:)?(?:fs(?:\\u002Fpromises)?|original-fs)$/';
const FS_BUILTIN_BAN = [
  { selector: `CallExpression[callee.property.name='getBuiltinModule'][arguments.0.value=${FS_MODULE}]`, message: NO_FS_BUILTIN },
  { selector: `CallExpression[callee.callee.name='createRequire'][arguments.0.value=${FS_MODULE}]`, message: NO_FS_BUILTIN },
];
// Files that may start a process directly, each a separate thread or process where a start blocks no UI or chat thread, and
// tests, which drive real processes. A later block's option list replaces an earlier one for the files it matches, so the
// blocks that allow them restate their tree's electron and vscode bans; an `ignores` on the banning blocks would drop those.
export const PROCESS_STARTERS_CORE = [
  // the launcher's worker thread, where every other start runs
  'src/core/process-launcher/worker.ts',
  // loaded only by the launcher worker; its taskkill fallback runs there
  'src/core/pi-session/tools/process-tree.ts',
  // the launcher worker that owns a POSIX session job starts its sentinel
  'src/core/pi-session/tools/shell-sentinel-client.ts',
  // the sentinel process itself (dist/sentinel.js)
  'src/core/pi-session/tools/shell-sentinel.ts',
  // runs on the Compass worker thread
  'src/core/compass/git.ts',
];
// the pty and formatter hosts: main's Electron utility processes, and the daemon's plain Node children on a target
export const PROCESS_STARTERS_DESKTOP = ['src/desktop/formatter-host/**/*.ts', 'src/desktop/pty-host/**/*.ts'];
const NODE_HOST_ROOTS = PROCESS_STARTERS_DESKTOP.map((glob) => glob.replace(/\/\*\*\/\*\.ts$/, ''));
// the daemon's forks, whose IPC channel belongs to its main thread, and the bridge's detached daemon start (docs/perf.md)
export const PROCESS_STARTERS_DAEMON = ['src/desktop/daemon/process-starts.ts'];
const testsUnder = (root) => [`${root}/**/__tests__/**`, `${root}/**/*.test.ts`, `${root}/**/*.bench.ts`];
const WORKER_ROOTS = ['src/desktop/quick-open-worker', 'src/desktop/watch-worker', 'src/desktop/askpass'];
// Damocles Core, its protocol, the per-process services both main and Core load, the host-neutral workspace modules and the
// daemon that hosts them on a target
const CORE_HOST_ROOTS = ['src/desktop/core-host', 'src/desktop/core-protocol', 'src/desktop/local-services', 'src/desktop/workspace', 'src/desktop/daemon'];
const WORKER_TREES = WORKER_ROOTS.map((root) => `${root}/**/*.ts`);
const CORE_HOST_TREES = CORE_HOST_ROOTS.map((root) => `${root}/**/*.ts`);

// Desktop main reaches the engine only through the core protocol (src/desktop/main/core-client.ts); type imports stay allowed.
// A value import from src/core must name a module listed here; scripts/__tests__/main-core-imports-lint.test.ts checks it.
export const MAIN_CORE_IMPORTS = [
  // stateless helpers and constants, and per-process services main runs its own instance of (its log, launcher pool,
  // config writes and platform accessor)
  'browser/net-guard',
  'chat-panel/ripgrep',
  'chat-panel/settings-file-editor',
  'config/json-config-write',
  'config/legacy-settings-migrations',
  'config/read-contributed-configuration',
  'config/retired-secrets',
  'config/settings-file',
  'executable-path',
  // l() and verbatim(): text main hands a chat page, which renders it in its own language
  'l10n',
  'logger',
  'paths',
  'pi-session/chat-changes',
  'pi-session/custom-providers',
  'pi-session/explore-providers',
  'pi-session/openai-auth',
  // childEnv: git's environment without the repository-local variables
  'pi-session/checkpoints/exec',
  'pi-session/usage-thresholds',
  'platform-host',
  'process-launcher',
  'quick-open/fuzzy-match',
  'resource-fs',
  'scm/artifacts',
  // main's own askpass server for its ssh transports; core's serves git
  'scm/askpass/askpass-server',
  'scm/branches',
  'scm/discovery',
  'scm/remotes',
  'scm/settings-keys',
  'scm/stash',
  'scm/worktrees',
  'system-tools',
  'volatile-secrets-notice',
  'web-url',
  'workspace-folders/folder-key',
  'workspace-folders/folder-registry',
  'worktrees/environment',
  'worktrees/slug',
  // the errors main rebuilds off the core protocol and the worktree record rule main checks core's mirror by
  'scm/errors',
  'worktrees/records',
];
const NO_CORE_IN_MAIN = 'Desktop main reaches the engine only through the core protocol (core-client.ts); import a type, or add a stateless helper to MAIN_CORE_IMPORTS.';

// Desktop main reaches the workspace modules (src/desktop/workspace) only through workspaces.forProject (main/workspace/,
// exempt); outside it, a value import from them must name an export listed here: constants, pure helpers and the contract.
export const MAIN_WORKSPACE_IMPORTS = [
  // the workspace channel's contract
  'CLIENT_TO_WORKSPACE',
  'WORKSPACE_MAX_MESSAGE_BYTES',
  'WORKSPACE_TO_CLIENT',
  // the error main rebuilds off the workspace channel
  'WriteRefusedError',
  // pure helpers and constants
  'NONCE_ENV',
  'REPLACE_REGEX_TIMEOUT_MS',
  'applyEdits',
  'createReplacer',
  'excludeSettingGlobs',
  'excludeTest',
  'keepMatchText',
  'lineStarts',
  'parseGlobList',
  'planReplacements',
  'planWithin',
  'rgSearchArgs',
  'runWithin',
  'windowsBuildNumber',
];
const NO_WORKSPACE_IN_MAIN = 'Desktop main reaches the workspace modules through workspaces.forProject (main/workspace/); import a type, or add a pure helper to MAIN_WORKSPACE_IMPORTS.';
// src/desktop/workspace from a file of main (`up`: one or more ../) or of a main subfolder (two or more, as ../workspace is
// main's own); an esquery regex cannot contain a raw slash, hence \u002F
const workspaceFromMain = (up) => ({
  pattern: { regex: `^(?:\\.\\./)${up}(?:desktop/)?workspace(?:/|$)`, message: NO_WORKSPACE_IN_MAIN, allowTypeImports: true, allowImportNames: MAIN_WORKSPACE_IMPORTS },
  syntax: valueImportSyntax(`/^(?:\\.\\.\\u002F)${up}(?:desktop\\u002F)?workspace(\\u002F|$)/`, NO_WORKSPACE_IN_MAIN),
});
const WORKSPACE_FROM_MAIN = workspaceFromMain('+');
const WORKSPACE_FROM_MAIN_SUBFOLDER = workspaceFromMain('{2,}');
const CORE_FROM_MAIN = (() => {
  const regex = String.raw`^(?:\.\./)+core/(?!(?:${MAIN_CORE_IMPORTS.join('|')})$)`;
  return {
    pattern: { regex, message: NO_CORE_IN_MAIN, allowTypeImports: true },
    // an esquery regex cannot contain a raw slash, hence \u002F
    syntax: valueImportSyntax(`/${regex.replaceAll('/', String.raw`\u002F`)}/`, NO_CORE_IN_MAIN),
  };
})();

// Renderer sizes are rem so they follow the host font (docs/invariants.md "Design tokens"). A px arbitrary value is banned in a
// variant or a utility, except a border, ring or outline width up to 1.5px, a blur, or a shadow.
const NONZERO_PX = String.raw`(?<![\d.])(?:\d*\.)?\d*[1-9]\d*px`;
const PX_EXEMPT = String.raw`(?:(?:border|ring|outline)(?:-[a-z]+)?-\[(?:0?\.\d+|1(?:\.[0-5]0*)?)px\]|(?:backdrop-)?blur-\[[^\]]*\]|(?:drop-|inset-)?shadow-\[[^\]]*\])`;
const PX_CLASS = [
  String.raw`\[[^\]]*${NONZERO_PX}[^\]]*\](?:\/[\w-]+)?:`,
  String.raw`(?:^|:)(?!!?-?${PX_EXEMPT}(?:\/[\w.-]+)?!?$)[^:\[]*\[[^\]]*${NONZERO_PX}[^\]]*\][^:]*$`,
].join('|');
const PX_MESSAGE = 'Use rem (px / 16) so the size follows the host font; px is only for border, ring and outline widths up to 1.5px, blur and shadows (docs/invariants.md "Design tokens").';
// A viewport variant compiles to a media query, whose rem ignores the root font; a container variant (@…) follows it.
const VIEWPORT_VARIANT = String.raw`(?:^|:)(?:(?:max-)?(?:sm|md|lg|xl|2xl)|(?:min|max)-\[[^\]]*\]|\[@media[^\]]*\]):`;
const VIEWPORT_MESSAGE = 'Use a container variant (@min-[…]/app: for the panel width) instead of a viewport one: a media query ignores the host font (docs/invariants.md "Design tokens").';
// Components whose `size` prop is a variant name, never a px number.
const SIZE_VARIANT_COMPONENTS = ['Button', 'Toggle', 'ToggleGroup', 'ToggleGroupItem', 'ToggleSwitch', 'SegmentedToggle'];
const NOT_SIZE_VARIANT = `/^(?!(?:${SIZE_VARIANT_COMPONENTS.join('|')})$)/`;
const ICON_SIZE_MESSAGE = 'Size an icon with a size-* class (px / 4) so it follows the host font, never a size prop (docs/invariants.md "Design tokens").';
const OFFSET_MESSAGE = 'A popper offset is px; pass remPx(rem) from @/composables/useRemPx so it follows the host font (docs/invariants.md "Design tokens").';

// The rem rules for one renderer tree; `entryPoint` is the stylesheet whose Tailwind theme its classes resolve against, and
// `syntax` the tree's own no-restricted-syntax entries, which this block's rule replaces.
function remSizing(files, entryPoint, syntax) {
  return {
    files,
    ignores: testsUnder('src'),
    plugins: { 'better-tailwindcss': betterTailwindcss },
    settings: {
      'better-tailwindcss': {
        entryPoint,
        rootFontSize: 16,
        // The defaults (class attributes, cn, cva, ...) plus UPPER_SNAKE constants that hold class strings or maps of them.
        selectors: [
          ...getDefaultSelectors(),
          { kind: 'variable', name: '^[A-Z][A-Z0-9_]*$', match: [{ type: 'strings' }, { type: 'objectValues' }] },
        ],
      },
    },
    rules: {
      // Tailwind folds a 0.25rem radius into rounded-lg, which is 6px in this theme; the 4px radius is rounded-md.
      'better-tailwindcss/enforce-canonical-classes': ['error', { ignore: [String.raw`^(?:.*:)?rounded(?:-[a-z]+)?-\[0?\.25rem\]$`] }],
      'better-tailwindcss/no-restricted-classes': ['error', {
        restrict: [{ pattern: PX_CLASS, message: PX_MESSAGE }, { pattern: VIEWPORT_VARIANT, message: VIEWPORT_MESSAGE }],
      }],
      'vue/no-restricted-v-bind': ['error', { argument: 'size', element: NOT_SIZE_VARIANT, message: ICON_SIZE_MESSAGE }],
      'vue/no-restricted-static-attribute': ['error', { key: 'size', value: '/^[0-9]/', message: ICON_SIZE_MESSAGE }],
      'vue/no-restricted-syntax': ['error', {
        selector: "VAttribute[directive=true][key.argument.name=/^(?:side|align)-offset$/] > VExpressionContainer > Literal[value!=0]",
        message: OFFSET_MESSAGE,
      }],
      'no-restricted-syntax': ['error', ...syntax,
        { selector: `CallExpression[callee.name='h'][arguments.0.name=${NOT_SIZE_VARIANT}] > ObjectExpression > Property[key.name='size']`, message: ICON_SIZE_MESSAGE },
        { selector: "Property[key.name=/^(?:side|align)Offset$/] > Literal[value!=0]", message: OFFSET_MESSAGE },
      ],
    },
  };
}

export default [
  {
    ignores: [
      'dist/**',
      'out/**',
      'node_modules/**',
      'resources/**',
      '.vscode-test/**',
      '.claude/**',
      'logs/**',
      'docs/**',
      'agent-profiles/**',
      'python/**',
      'l10n/**',
      'src/**/__mocks__/**',
      'src/**/__tests__/fixtures/**',
      '**/*.d.ts',
      'scripts/generate-agent-profiles.mjs',
      'scripts/query-db.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 'latest',
        sourceType: 'module',
        extraFileExtensions: ['.vue'],
      },
    },
  },
  {
    files: ['**/*.{ts,tsx,vue}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-escape': 'warn',
    },
  },
  {
    files: ['**/*.vue'],
    rules: {
      // Strict null checks already make every use of a typed optional prop handle undefined, so an undefined default adds nothing (eslint-plugin-vue #1914, #2306, #2475).
      'vue/require-default-prop': 'off',
    },
  },
  {
    files: ['src/**/__tests__/**'],
    rules: {
      // Tests define stub components inline.
      'vue/one-component-per-file': 'off',
    },
  },
  {
    files: ['src/webview/components/ui/**/*.vue'],
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    files: ['scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['src/**/*.{ts,tsx,vue}'],
    ignores: ['src/vscode/**', 'src/desktop/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: VSCODE_ONLY }, OUTSIDE_DESKTOP.path, ...PROCESS_BAN.paths],
        patterns: [OUTSIDE_DESKTOP.pattern],
      }],
      'no-restricted-syntax': ['error', ...VSCODE_SYNTAX, ...OUTSIDE_DESKTOP.syntax, ...PROCESS_BAN.syntax, ...FS_BUILTIN_BAN],
    },
  },
  {
    files: ['src/desktop/**/*.{ts,vue}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: VSCODE_ONLY }, ...PROCESS_BAN.paths],
      }],
      'no-restricted-syntax': ['error', ...VSCODE_SYNTAX, ...PROCESS_BAN.syntax, ...FS_BUILTIN_BAN],
    },
  },
  {
    files: ['src/desktop/main/**/*.ts'],
    ignores: testsUnder('src/desktop/main'),
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: VSCODE_ONLY }, ...PROCESS_BAN.paths],
        patterns: [CORE_FROM_MAIN.pattern, CORE_HOST_FROM_MAIN.pattern, WORKSPACE_FROM_MAIN.pattern],
      }],
      'no-restricted-syntax': ['error', ...VSCODE_SYNTAX, ...PROCESS_BAN.syntax, ...CORE_FROM_MAIN.syntax, ...CORE_HOST_FROM_MAIN.syntax, ...WORKSPACE_FROM_MAIN.syntax, ...FS_BUILTIN_BAN],
      // verbatimModuleSyntax keeps `import { type X } from 'm'` as `import 'm'`, which bundles m into main
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  },
  {
    files: ['src/desktop/main/*/**/*.ts'],
    ignores: testsUnder('src/desktop/main'),
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: VSCODE_ONLY }, ...PROCESS_BAN.paths],
        patterns: [CORE_FROM_MAIN.pattern, CORE_HOST_FROM_MAIN_SUBFOLDER.pattern, WORKSPACE_FROM_MAIN_SUBFOLDER.pattern],
      }],
      'no-restricted-syntax': ['error', ...VSCODE_SYNTAX, ...PROCESS_BAN.syntax, ...CORE_FROM_MAIN.syntax, ...CORE_HOST_FROM_MAIN_SUBFOLDER.syntax, ...WORKSPACE_FROM_MAIN_SUBFOLDER.syntax, ...FS_BUILTIN_BAN],
    },
  },
  {
    // workspaces.forProject, main's one way to the workspace modules
    files: ['src/desktop/main/workspace/**/*.ts'],
    ignores: testsUnder('src/desktop/main'),
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: VSCODE_ONLY }, ...PROCESS_BAN.paths],
        patterns: [CORE_FROM_MAIN.pattern, CORE_HOST_FROM_MAIN_SUBFOLDER.pattern],
      }],
      'no-restricted-syntax': ['error', ...VSCODE_SYNTAX, ...PROCESS_BAN.syntax, ...CORE_FROM_MAIN.syntax, ...CORE_HOST_FROM_MAIN_SUBFOLDER.syntax, ...FS_BUILTIN_BAN],
    },
  },
  {
    files: WORKER_TREES,
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: VSCODE_ONLY }, IN_WORKER.path, ...PROCESS_BAN.paths],
        patterns: [IN_WORKER.pattern],
      }],
      'no-restricted-syntax': ['error', ...VSCODE_SYNTAX, ...IN_WORKER.syntax, ...PROCESS_BAN.syntax, ...FS_BUILTIN_BAN],
    },
  },
  {
    // Damocles Core's platform, the protocol and the per-process services both sides share, which must run outside main
    files: CORE_HOST_TREES,
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: VSCODE_ONLY }, IN_CORE_HOST.path, ...PROCESS_BAN.paths],
        patterns: [IN_CORE_HOST.pattern, MAIN_FROM_CORE.pattern],
      }],
      'no-restricted-syntax': ['error', ...VSCODE_SYNTAX, ...IN_CORE_HOST.syntax, ...MAIN_FROM_CORE.syntax, ...PROCESS_BAN.syntax, ...FS_BUILTIN_BAN],
    },
  },
  {
    // the daemon's one file of direct starts keeps its tree's electron, vscode and desktop-main bans
    files: PROCESS_STARTERS_DAEMON,
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: VSCODE_ONLY }, IN_CORE_HOST.path],
        patterns: [IN_CORE_HOST.pattern, MAIN_FROM_CORE.pattern],
      }],
      'no-restricted-syntax': ['error', ...VSCODE_SYNTAX, ...IN_CORE_HOST.syntax, ...MAIN_FROM_CORE.syntax, ...FS_BUILTIN_BAN],
    },
  },
  {
    files: ['src/desktop/shell/**/*.{ts,vue}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: VSCODE_ONLY }, IN_SHELL.path, ...PROCESS_BAN.paths],
        patterns: [IN_SHELL.pattern],
      }],
      'no-restricted-syntax': ['error', ...VSCODE_SYNTAX, ...IN_SHELL.syntax, ...PROCESS_BAN.syntax],
    },
  },
  {
    files: ['src/vscode/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [OUTSIDE_DESKTOP.path, ...PROCESS_BAN.paths],
        patterns: [OUTSIDE_DESKTOP.pattern],
      }],
      'no-restricted-syntax': ['error', ...OUTSIDE_DESKTOP.syntax, ...PROCESS_BAN.syntax, ...FS_BUILTIN_BAN],
    },
  },
  {
    files: [...PROCESS_STARTERS_CORE, ...testsUnder('src')],
    ignores: ['src/vscode/**', 'src/desktop/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: VSCODE_ONLY }, OUTSIDE_DESKTOP.path],
        patterns: [OUTSIDE_DESKTOP.pattern],
      }],
      'no-restricted-syntax': ['error', ...VSCODE_SYNTAX, ...OUTSIDE_DESKTOP.syntax, ...FS_BUILTIN_BAN],
    },
  },
  {
    files: testsUnder('src/desktop'),
    // the trees below keep their own electron and desktop-main bans
    ignores: ['src/desktop/shell/**', ...[...WORKER_ROOTS, ...CORE_HOST_ROOTS, ...NODE_HOST_ROOTS].map((root) => `${root}/**`)],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: VSCODE_ONLY }],
      }],
      'no-restricted-syntax': ['error', ...VSCODE_SYNTAX, ...FS_BUILTIN_BAN],
    },
  },
  {
    // the pty and formatter hosts and their tests start processes and keep the electron ban
    files: PROCESS_STARTERS_DESKTOP,
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: VSCODE_ONLY }, IN_NODE_HOST.path],
        patterns: [IN_NODE_HOST.pattern],
      }],
      'no-restricted-syntax': ['error', ...VSCODE_SYNTAX, ...IN_NODE_HOST.syntax, ...FS_BUILTIN_BAN],
    },
  },
  {
    files: testsUnder('src/desktop/shell'),
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: VSCODE_ONLY }, IN_SHELL.path],
        patterns: [IN_SHELL.pattern],
      }],
      'no-restricted-syntax': ['error', ...VSCODE_SYNTAX, ...IN_SHELL.syntax],
    },
  },
  {
    files: WORKER_ROOTS.flatMap(testsUnder),
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: VSCODE_ONLY }, IN_WORKER.path],
        patterns: [IN_WORKER.pattern],
      }],
      'no-restricted-syntax': ['error', ...VSCODE_SYNTAX, ...IN_WORKER.syntax, ...FS_BUILTIN_BAN],
    },
  },
  {
    files: CORE_HOST_ROOTS.flatMap(testsUnder),
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: VSCODE_ONLY }, IN_CORE_HOST.path],
        patterns: [IN_CORE_HOST.pattern, MAIN_FROM_CORE.pattern],
      }],
      'no-restricted-syntax': ['error', ...VSCODE_SYNTAX, ...IN_CORE_HOST.syntax, ...MAIN_FROM_CORE.syntax, ...FS_BUILTIN_BAN],
    },
  },
  {
    files: ['src/remote/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: NO_HOST_IN_REMOTE }, IN_REMOTE.path, ...PROCESS_BAN.paths],
        patterns: [IN_REMOTE.pattern, HOST_FROM_REMOTE.pattern],
      }],
      'no-restricted-syntax': ['error', ...moduleSyntax("'vscode'", NO_HOST_IN_REMOTE), ...IN_REMOTE.syntax, ...HOST_FROM_REMOTE.syntax, ...PROCESS_BAN.syntax, ...FS_BUILTIN_BAN],
    },
  },
  {
    files: testsUnder('src/remote'),
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: NO_HOST_IN_REMOTE }, IN_REMOTE.path],
        patterns: [IN_REMOTE.pattern, HOST_FROM_REMOTE.pattern],
      }],
      'no-restricted-syntax': ['error', ...moduleSyntax("'vscode'", NO_HOST_IN_REMOTE), ...IN_REMOTE.syntax, ...HOST_FROM_REMOTE.syntax, ...FS_BUILTIN_BAN],
    },
  },
  {
    files: testsUnder('src/vscode'),
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [OUTSIDE_DESKTOP.path],
        patterns: [OUTSIDE_DESKTOP.pattern],
      }],
      'no-restricted-syntax': ['error', ...OUTSIDE_DESKTOP.syntax, ...FS_BUILTIN_BAN],
    },
  },
  {
    files: NO_SYNC_FILES,
    ignores: [...testsUnder('src'), ...WORKER_ONLY_FILES],
    plugins: { damocles: damoclesPlugin },
    rules: { 'damocles/no-sync': 'error' },
  },
  remSizing(['src/webview/**/*.{ts,vue}'], 'src/webview/style.css', [...VSCODE_SYNTAX, ...OUTSIDE_DESKTOP.syntax, ...PROCESS_BAN.syntax]),
  // The shell, overlay and popup pages all import this stylesheet, which carries the webview theme.
  remSizing(['src/desktop/shell/**/*.{ts,vue}'], 'src/desktop/shell/style.css', [...VSCODE_SYNTAX, ...IN_SHELL.syntax, ...PROCESS_BAN.syntax]),
];
