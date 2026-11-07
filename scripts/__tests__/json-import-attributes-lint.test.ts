import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { ESLint } from 'eslint';

// Node's ESM loader refuses a JSON module without `with { type: 'json' }` in every form that loads it, re-exports included.
const ROOT = join(import.meta.dirname, '..', '..');
const eslint = new ESLint({ cwd: ROOT });

async function findings(text: string, file = 'scripts/json-import-probe.ts'): Promise<number> {
  const [result] = await eslint.lintText(text, { filePath: join(ROOT, file) });
  return (result?.messages ?? []).filter((message) => message.ruleId === 'damocles/json-import-attributes').length;
}

describe('damocles/json-import-attributes', () => {
  it('fails an import, a dynamic import and both re-export forms without the attribute', async () => {
    expect(await findings("import data from './data.json';\nexport const probe = data;\n")).toBe(1);
    expect(await findings("export const probe = import('./data.json');\n")).toBe(1);
    expect(await findings("export { default as data } from './data.json';\n")).toBe(1);
    expect(await findings("export * from './data.json';\n")).toBe(1);
    expect(await findings("export * from './data.json';\n", 'scripts/json-import-probe.mjs')).toBe(1);
  }, 60_000);

  it('passes each form with the attribute, a type-only form and a non-JSON source', async () => {
    expect(await findings("import data from './data.json' with { type: 'json' };\nexport const probe = data;\n")).toBe(0);
    expect(await findings("export const probe = import('./data.json', { with: { type: 'json' } });\n")).toBe(0);
    expect(await findings("export { default as data } from './data.json' with { type: 'json' };\n")).toBe(0);
    expect(await findings("export * from './data.json' with { type: 'json' };\n")).toBe(0);
    expect(await findings("export * from './module.ts';\nexport { probe } from './module.ts';\n")).toBe(0);
  }, 60_000);
});
