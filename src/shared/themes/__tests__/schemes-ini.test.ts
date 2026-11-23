// The strict INI reader KDE and Qt schemes go through: group naming, comments, quoting, skipped locale keys and every refusal.
import { describe, expect, it } from 'vitest';
import { iniList, iniValue, MAX_INI_GROUPS, MAX_INI_LINES, readIni } from '../schemes';
import { refusal } from './scheme-refusal';

describe('readIni', () => {
  it('names a group by its whole bracket text, so [Colors:Header][Inactive] is a group of its own', () => {
    const ini = readIni('[Colors:Header]\nBackgroundNormal=1,2,3\n\n[Colors:Header][Inactive]\nBackgroundNormal=4,5,6\n', 'a.colors');
    expect(ini.get('Colors:Header')?.get('BackgroundNormal')).toBe('1,2,3');
    expect(ini.get('Colors:Header][Inactive')?.get('BackgroundNormal')).toBe('4,5,6');
  });

  it('skips comments and blank lines, trims keys and values, reads CRLF, and lets a later value or a reopened group win', () => {
    const ini = readIni('# a comment\r\n; another\r\n[General]\r\n  Name = First \r\n\r\n[Other]\r\nx=1\r\n[General]\r\nName=Second\r\n', 'a.colors');
    expect(ini.get('General')?.get('Name')).toBe('Second');
    expect(ini.get('Other')?.get('x')).toBe('1');
    expect(ini.has('')).toBe(false);
  });

  it('skips keys with a locale or [$e] suffix', () => {
    const ini = readIni('[General]\nName=Fixture\nName[de]=Vorlage\nName[sr@latin]=x\nPath[$e]=$HOME\n', 'a.colors');
    expect([...ini.get('General')!.keys()]).toEqual(['Name']);
  });

  it('reads a key or group marked [$i] or [$d] as the key or group itself', () => {
    const ini = readIni('[Colors:View][$i]\nBackgroundNormal=1,2,3\n[General]\nAccentColor[$i]=4,5,6\nName[$d]=x\n', 'kdeglobals');
    expect(ini.get('Colors:View')?.get('BackgroundNormal')).toBe('1,2,3');
    expect([...ini.get('General')!]).toEqual([['AccentColor', '4,5,6'], ['Name', 'x']]);
  });

  it('reads a BOM before the first group', () => {
    expect(readIni('\uFEFF[General]\nName=x\n', 'a.colors').get('General')?.get('Name')).toBe('x');
  });

  it('with qsettings, ends an unquoted value at a ; and joins a line ending in a backslash to the next', () => {
    const ini = readIni('[ColorScheme]\nactive_colors=#ff000000, #ff111111 ; a note\nquoted="a;b" ; note\nlong=#ff000000, \\\r\n  #ff111111\nescaped=a\\\\\nnext=1\n', 'a.conf', { qsettings: true });
    expect([...ini.get('ColorScheme')!]).toEqual([['active_colors', '#ff000000, #ff111111'], ['quoted', '"a;b"'], ['long', '#ff000000,   #ff111111'], ['escaped', 'a\\\\'], ['next', '1']]);
    expect(readIni('[G]\nk=a ; b\n', 'a.colors').get('G')?.get('k')).toBe('a ; b');
  });

  it('keeps keys before any group under the group named ""', () => {
    expect(readIni('loose=1\n[G]\nk=2\n', 'a.conf').get('')?.get('loose')).toBe('1');
  });

  it('reads QSettings quoting: a quoted value, and a list whose quoted item holds a comma', () => {
    expect(iniValue('"a \\"quoted\\" \\\\ value"')).toBe('a "quoted" \\ value');
    expect(iniValue('plain "inner"')).toBe('plain "inner"');
    expect(iniValue('"a\\nb\\tc"')).toBe('a\nb\tc');
    expect(iniList('#ff000000, #ff111111,#ff222222')).toEqual(['#ff000000', '#ff111111', '#ff222222']);
    expect(iniList('"a, b", c')).toEqual(['a, b', 'c']);
    expect(iniList('a, "abc\\')).toEqual(['a', '"abc\\']);
  });

  it('refuses a NUL byte, a line that is neither a group nor key=value, an unclosed or empty group, and an empty key', () => {
    expect(refusal(() => readIni('[G]\nk=v\0\n', 'a.colors'))).toBe('syntax');
    expect(refusal(() => readIni('[G]\njust words\n', 'a.colors'))).toBe('syntax');
    expect(refusal(() => readIni('[G\nk=v\n', 'a.colors'))).toBe('syntax');
    expect(refusal(() => readIni('[]\nk=v\n', 'a.colors'))).toBe('syntax');
    expect(refusal(() => readIni('[G]\n=v\n', 'a.colors'))).toBe('syntax');
  });

  it('lenient, skips those lines as KConfig does, keeping the group it was in, and still refuses a NUL byte', () => {
    const ini = readIni('[G]\njust words\n[H\n=v\nk=v\n[]\nj=w\n', 'kdeglobals', { lenient: true });
    expect([...ini]).toEqual([['G', new Map([['k', 'v'], ['j', 'w']])]]);
    expect(refusal(() => readIni('[G]\nk=v\0\n', 'kdeglobals', { lenient: true }))).toBe('syntax');
  });

  it('refuses more lines or groups than its caps', () => {
    expect(() => readIni('\n'.repeat(MAX_INI_LINES), 'a.colors')).not.toThrow();
    expect(refusal(() => readIni('\n'.repeat(MAX_INI_LINES + 1), 'a.colors'))).toBe('syntax');
    expect(() => readIni(`${'\n'.repeat(MAX_INI_LINES - 1)}k=v`, 'a.colors')).not.toThrow();
    expect(refusal(() => readIni(`${'\n'.repeat(MAX_INI_LINES)}k=v`, 'a.colors'))).toBe('syntax');
    const groups = (count: number): string => Array.from({ length: count }, (_, i) => `[G${i}]`).join('\n');
    expect(refusal(() => readIni(groups(MAX_INI_GROUPS + 1), 'a.colors'))).toBe('syntax');
    expect(readIni(groups(MAX_INI_GROUPS), 'a.colors').size).toBe(MAX_INI_GROUPS);
  });
});
