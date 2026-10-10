import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import globals from 'globals';
import betterTailwindcss from 'eslint-plugin-better-tailwindcss';
import { getDefaultSelectors } from 'eslint-plugin-better-tailwindcss/defaults';

const VSCODE_ONLY = 'Only src/vscode may import vscode; core code reaches the host through src/platform.';
const NO_ELECTRON = 'Only src/desktop may import electron.';
const NO_ELECTRON_SHELL = 'The shell renderer never imports electron; it reaches main only through window.damoclesShell.';
const NO_ELECTRON_WORKER = 'The Quick Open and watch workers are plain Node worker threads and never import electron.';

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
    ignores: ['src/**/__tests__/**'],
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
      }],
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-escape': 'warn',
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
        paths: [{ name: 'vscode', message: VSCODE_ONLY }, OUTSIDE_DESKTOP.path],
        patterns: [OUTSIDE_DESKTOP.pattern],
      }],
      'no-restricted-syntax': ['error', ...VSCODE_SYNTAX, ...OUTSIDE_DESKTOP.syntax],
    },
  },
  {
    files: ['src/desktop/**/*.{ts,vue}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: VSCODE_ONLY }],
      }],
      'no-restricted-syntax': ['error', ...VSCODE_SYNTAX],
    },
  },
  {
    files: ['src/desktop/quick-open-worker/**/*.ts', 'src/desktop/watch-worker/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: VSCODE_ONLY }, IN_WORKER.path],
        patterns: [IN_WORKER.pattern],
      }],
      'no-restricted-syntax': ['error', ...VSCODE_SYNTAX, ...IN_WORKER.syntax],
    },
  },
  {
    files: ['src/desktop/shell/**/*.{ts,vue}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'vscode', message: VSCODE_ONLY }, IN_SHELL.path],
        patterns: [IN_SHELL.pattern],
      }],
      'no-restricted-syntax': ['error', ...VSCODE_SYNTAX, ...IN_SHELL.syntax],
    },
  },
  {
    files: ['src/vscode/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [OUTSIDE_DESKTOP.path],
        patterns: [OUTSIDE_DESKTOP.pattern],
      }],
      'no-restricted-syntax': ['error', ...OUTSIDE_DESKTOP.syntax],
    },
  },
  remSizing(['src/webview/**/*.{ts,vue}'], 'src/webview/style.css', [...VSCODE_SYNTAX, ...OUTSIDE_DESKTOP.syntax]),
  // The shell, overlay and popup pages all import this stylesheet, which carries the webview theme.
  remSizing(['src/desktop/shell/**/*.{ts,vue}'], 'src/desktop/shell/style.css', [...VSCODE_SYNTAX, ...IN_SHELL.syntax]),
];
