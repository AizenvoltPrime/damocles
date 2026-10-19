import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transformSync } from 'esbuild';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { BUNDLED_TREES, REPO_ROOT, backendSourceFiles } from '../../__mocks__/source-tree';
import { SPAWN_TEST_TIMEOUT_MS } from '../../__mocks__/spawn-budget';

// pi's packages are ESM-only esbuild externals: an import or export of one that emits a `require` in the CJS
// extension and desktop bundles throws at load. Values come through `pi-session/pi-loader.ts`, whose dynamic
// imports esbuild keeps as `import()`.
const PI_PACKAGE = /^@earendil-works\//;

// Under `verbatimModuleSyntax` only a statement-level `type` modifier is erased; `import { type A }` stays `import {}`.
function emitsRuntimeImport(statement: ts.Statement): ts.Expression | undefined {
  if (ts.isImportDeclaration(statement)) {
    return statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ? undefined : statement.moduleSpecifier;
  }
  if (ts.isExportDeclaration(statement)) return statement.isTypeOnly ? undefined : statement.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly && ts.isExternalModuleReference(statement.moduleReference)) {
    return statement.moduleReference.expression;
  }
  return undefined;
}

/** The statements in `source` that import or export a pi package at runtime, as `<line>: <statement>`. */
function piRuntimeImports(source: string): string[] {
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  for (const statement of file.statements) {
    const specifier = emitsRuntimeImport(statement);
    if (specifier && ts.isStringLiteral(specifier) && PI_PACKAGE.test(specifier.text)) {
      const line = file.getLineAndCharacterOfPosition(statement.getStart(file)).line + 1;
      found.push(`${line}: ${statement.getText(file).replace(/\s+/g, ' ')}`);
    }
  }
  return found;
}

const TSCONFIG = readFileSync(join(REPO_ROOT, 'tsconfig.json'), 'utf8');

/** Whether the extension and desktop builds' esbuild settings turn `source` into a `require` of a pi package. */
function esbuildRequiresPi(source: string): boolean {
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs', platform: 'node', target: 'node24', tsconfigRaw: TSCONFIG });
  return /\brequire\("@earendil-works\//.test(code);
}

const FORMS: readonly { readonly source: string; readonly runtime: boolean }[] = [
  { source: "import {\n  getCurrentTools,\n  type TranscriptMessages,\n} from '@earendil-works/pi-ai';", runtime: true },
  { source: "import * as pi from '@earendil-works/pi-coding-agent';", runtime: true },
  { source: "import Default from '@earendil-works/pi-tui';", runtime: true },
  { source: "export { Agent } from '@earendil-works/pi-agent-core';", runtime: true },
  { source: "import { type Model, type Api } from '@earendil-works/pi-ai';", runtime: true },
  { source: "import {} from '@earendil-works/pi-ai';", runtime: true },
  { source: "import '@earendil-works/pi-mcp';", runtime: true },
  { source: "export { type Model } from '@earendil-works/pi-ai';", runtime: true },
  { source: "export * from '@earendil-works/pi-ai';", runtime: true },
  { source: "export * as pi from '@earendil-works/pi-ai';", runtime: true },
  { source: "import pi = require('@earendil-works/pi-ai');", runtime: true },
  { source: "import type { Model } from '@earendil-works/pi-ai';", runtime: false },
  { source: "import type * as pi from '@earendil-works/pi-ai';", runtime: false },
  { source: "export type { Model } from '@earendil-works/pi-ai';", runtime: false },
  { source: "export type * from '@earendil-works/pi-ai';", runtime: false },
  { source: "import type pi = require('@earendil-works/pi-ai');", runtime: false },
  { source: "type Model = import('@earendil-works/pi-ai').Model;", runtime: false },
  { source: "async function load() {\n  const pi = await import('@earendil-works/pi-ai');\n  return pi;\n}", runtime: false },
  { source: "import { z } from 'zod';", runtime: false },
  { source: "import { a } from './a'\nexport const b = a\nimport type { Model } from '@earendil-works/pi-ai'", runtime: false },
];

describe('pi packages are imported for their values only through pi-loader', () => {
  it('finds no runtime import or export of an @earendil-works package in bundled backend source', () => {
    const files = backendSourceFiles(REPO_ROOT, BUNDLED_TREES).filter(
      (file) => !file.rel.startsWith('src/desktop/shell/') && !file.rel.endsWith('.d.ts') && !file.rel.endsWith('.test.ts'),
    );
    const offenders = files.flatMap((file) => piRuntimeImports(readFileSync(file.path, 'utf8')).map((hit) => `${file.rel}:${hit}`));
    expect(offenders).toEqual([]);
  });

  // The first transformSync starts esbuild's service process.
  it.each(FORMS)('classifies %j as esbuild emits it', ({ source, runtime }) => {
    expect(esbuildRequiresPi(source)).toBe(runtime);
    expect(piRuntimeImports(source).length > 0).toBe(runtime);
  }, SPAWN_TEST_TIMEOUT_MS);
});
