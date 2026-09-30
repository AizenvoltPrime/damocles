import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import globals from 'globals';

const VSCODE_ONLY = 'Only src/vscode may import vscode; core code reaches the host through src/platform.';
const NO_ELECTRON = 'Only src/desktop may import electron.';
const NO_ELECTRON_SHELL = 'The shell renderer never imports electron; it reaches main only through window.damoclesShell.';

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
];
