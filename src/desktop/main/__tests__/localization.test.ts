import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDesktopLocalizationService, formatMessage, normalizeLanguage } from '../platform/localization-service';

const noLog = (): void => undefined;

describe('desktop localization', () => {
  it('formats positional arguments like vscode.l10n.t', () => {
    expect(formatMessage('Could not open file: {0}', ['a.ts'])).toBe('Could not open file: a.ts');
    expect(formatMessage('{1} then {0} then {1}', ['a', 2])).toBe('2 then a then 2');
    expect(formatMessage('missing {2}', ['a'])).toBe('missing {2}');
    expect(formatMessage('{0}', [false])).toBe('false');
  });

  it('normalizes the app locale to the shipped languages', () => {
    expect(normalizeLanguage('el')).toBe('el');
    expect(normalizeLanguage('el-GR')).toBe('el');
    expect(normalizeLanguage('en-US')).toBe('en');
    expect(normalizeLanguage('de')).toBe('en');
  });

  it('translates through the l10n bundle and package.nls for Greek, falling back to the source string', () => {
    const el = createDesktopLocalizationService(process.cwd(), normalizeLanguage('el-GR'), noLog);
    expect(el.language).toBe('el');
    expect(el.t('Could not open file: {0}', 'a.ts')).toBe('Δεν ήταν δυνατό το άνοιγμα του αρχείου: a.ts');
    expect(el.t('Not in any bundle {0}', 1)).toBe('Not in any bundle 1');
    expect(el.packageString('command.openChat.title')).toBe('Άνοιγμα Συνομιλίας');
    const en = createDesktopLocalizationService(process.cwd(), normalizeLanguage('en-US'), noLog);
    expect(en.packageString('command.openChat.title')).toBe('Open Chat');
    expect(() => en.packageString('no.such.key')).toThrow();
  });

  it('switches language at runtime and tells listeners once per change', () => {
    const l10n = createDesktopLocalizationService(process.cwd(), 'en', noLog);
    const seen: string[] = [];
    l10n.onDidChangeLanguage((language) => seen.push(language));
    l10n.setLanguage('el');
    l10n.setLanguage('el');
    expect(l10n.language).toBe('el');
    expect(l10n.packageString('command.openChat.title')).toBe('Άνοιγμα Συνομιλίας');
    l10n.setLanguage('en');
    expect(l10n.t('Could not open file: {0}', 'a.ts')).toBe('Could not open file: a.ts');
    expect(seen).toEqual(['el', 'en']);
  });

  it('has every message main translates in the English and Greek bundles', () => {
    const mainDir = path.join(process.cwd(), 'src', 'desktop', 'main');
    const sources = fs.readdirSync(mainDir, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.split(path.sep).includes('__tests__'))
      .map((file) => fs.readFileSync(path.join(mainDir, file), 'utf8'));
    const messages = new Set(sources.flatMap((source) => [...source.matchAll(/\bt\('((?:[^'\\]|\\.)+)'/g)].map((m) => m[1]!.replace(/\\'/g, "'"))));
    expect(messages.size).toBeGreaterThan(40);
    for (const bundle of ['bundle.l10n.json', 'bundle.l10n.el.json']) {
      const table = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'l10n', bundle), 'utf8')) as Record<string, string>;
      for (const message of messages) expect(table[message], `${bundle}: ${message}`).toBeTruthy();
    }
  });

  it('answers an Object.prototype name as an untranslated message', () => {
    const el = createDesktopLocalizationService(process.cwd(), 'el', noLog);
    expect(el.t('constructor')).toBe('constructor');
    expect(el.t('toString')).toBe('toString');
    expect(() => el.packageString('constructor')).toThrow('No package.nls string for constructor');
  });

  it('tells every language listener even when one throws, and logs it', () => {
    const lines: string[] = [];
    const l10n = createDesktopLocalizationService(process.cwd(), 'en', (line) => lines.push(line));
    const seen: string[] = [];
    l10n.onDidChangeLanguage(() => {
      throw new Error('menu rebuild failed');
    });
    l10n.onDidChangeLanguage((language) => seen.push(language));
    expect(() => l10n.setLanguage('el')).not.toThrow();
    expect(seen).toEqual(['el']);
    expect(lines.some((line) => line.startsWith('[l10n] a listener threw') && line.includes('menu rebuild failed'))).toBe(true);
  });
});
