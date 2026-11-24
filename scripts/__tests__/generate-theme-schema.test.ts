import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import Ajv from 'ajv/dist/2020';
import { OUTPUT, renderThemeSchema } from '../generate-theme-schema.ts';
import { BUILTIN_THEME } from '../../src/shared/themes/builtin';
import { validateTheme } from '../../src/shared/themes/schema';

describe('theme schema', () => {
  it('the committed file is what the generator produces, byte for byte', () => {
    expect(readFileSync(OUTPUT, 'utf8')).toBe(renderThemeSchema());
  });

  // Without the attribute a Windows checkout converts the file to CRLF, which is not the generator's output.
  it('is pinned to LF in .gitattributes', () => {
    const attributes = readFileSync(join(dirname(OUTPUT), '..', '.gitattributes'), 'utf8').split(/\r?\n/);
    expect(attributes).toContain('schemas/theme.schema.json text eol=lf');
    expect(renderThemeSchema()).not.toContain('\r');
  });

  it('agrees with the validator on a theme it accepts and on one it refuses for its name', () => {
    const check = new Ajv({ strict: false, allErrors: true }).compile(JSON.parse(readFileSync(OUTPUT, 'utf8')) as object);
    const theme = { ...(JSON.parse(JSON.stringify(BUILTIN_THEME)) as object), id: '3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f809a1b' };
    expect(validateTheme(theme).ok).toBe(true);
    expect(check(theme)).toBe(true);
    for (const name of ['Night\nDay', 'Night\u202Egnp', 'Night\u2028Day']) {
      expect(validateTheme({ ...theme, name }).ok).toBe(false);
      expect(check({ ...theme, name })).toBe(false);
    }
    expect(check({ ...theme, name: 'می\u200Cخواهم' })).toBe(true);
  });

  it('agrees with the validator on a character set\'s selection', () => {
    const check = new Ajv({ strict: false, allErrors: true }).compile(JSON.parse(readFileSync(OUTPUT, 'utf8')) as object);
    const sha = 'a'.repeat(64);
    const theme = (selection: string): object => ({
      ...(JSON.parse(JSON.stringify(BUILTIN_THEME)) as object),
      id: '3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f809a1b',
      characters: { name: 'Crew', characters: [{ name: 'Pip', states: { idle: { asset: sha } } }], selection },
      assets: { [sha]: { kind: 'sprite', mime: 'image/png', bytes: 100, width: 16, height: 16, license: {} } },
    });
    for (const [selection, ok] of [['outline', true], ['none', true], ['glow', false]] as const) {
      expect([selection, validateTheme(theme(selection)).ok, check(theme(selection))]).toEqual([selection, ok, ok]);
    }
  });
});
