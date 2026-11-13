import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A message that sends the user to "Settings › …" names labels the settings view shows: a scope tab, a section, a group or a
 * row, each segment in turn. A label renamed in its catalog, or one never there, leaves the user searching for a page that
 * does not exist.
 */

const ROOT = path.join(__dirname, '..', '..', '..');
const json = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')) as Record<string, unknown>;

type Catalog = Record<string, unknown>;
const at = (catalog: Catalog, key: string): Catalog => catalog[key] as Catalog;
const strings = (value: unknown): string[] => (typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []);
const labelsOf = (entries: Catalog): string[] => Object.values(entries).map((entry) => (entry as { label?: unknown }).label).filter((label): label is string => typeof label === 'string');

// Longest first, so "Models & accounts" wins over a shorter label that starts it.
function settingsLabels(language: 'en' | 'el'): string[] {
  const modal = at(json(`src/webview/i18n/locales/${language}.json`), 'settingsModal');
  const shell = json(`src/desktop/shell/locales/${language}.json`);
  const scope = at(shell, 'settingsScope');
  const host = at(shell, 'settingsHost');
  return [
    ...labelsOf(at(modal, 'sectionsMeta')),
    ...strings(at(modal, 'groups')),
    ...labelsOf(at(modal, 'rows')),
    at(at(modal, 'forge'), 'title') as unknown as string,
    scope.user as string,
    scope.project as string,
    ...labelsOf(at(host, 'sections')),
    ...strings(at(host, 'groups')),
    ...labelsOf(at(host, 'rows')),
  ].sort((a, b) => b.length - a.length);
}

// Each "Settings › …" path in text whose segments are not, in turn, labels the settings view shows.
function unknownPaths(text: string, settings: RegExp, labels: readonly string[]): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(settings)) {
    let rest = text.slice((match.index ?? 0) + match[0].length);
    for (;;) {
      const label = labels.find((candidate) => rest.startsWith(candidate));
      if (!label) {
        found.push(`${match[0]}${rest.slice(0, 40)}`);
        break;
      }
      rest = rest.slice(label.length);
      if (!rest.startsWith(' › ')) break;
      rest = rest.slice(' › '.length);
    }
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.(ts|vue)$/.test(entry.name) ? [full] : [];
  });
}

const ENGLISH = /Settings › /g;
const GREEK = /(?:Ρυθμίσεις|Ρυθμίσεων) › /g;

describe('Settings paths in messages', () => {
  it('names only English labels the settings view shows', () => {
    const labels = settingsLabels('en');
    const texts = [
      ...Object.keys(json('l10n/bundle.l10n.json')).map((text) => ['l10n/bundle.l10n.json', text] as const),
      ...strings(json('src/webview/i18n/locales/en.json')).map((text) => ['src/webview/i18n/locales/en.json', text] as const),
      ...strings(json('src/desktop/shell/locales/en.json')).map((text) => ['src/desktop/shell/locales/en.json', text] as const),
      ...sourceFiles(path.join(ROOT, 'src')).map((file) => [path.relative(ROOT, file), fs.readFileSync(file, 'utf8')] as const),
    ];
    expect(texts.flatMap(([file, text]) => unknownPaths(text, ENGLISH, labels).map((found) => `${file}: ${found}`))).toEqual([]);
  });

  it('names only Greek labels the settings view shows', () => {
    const labels = settingsLabels('el');
    const texts = [
      ...strings(json('l10n/bundle.l10n.el.json')).map((text) => ['l10n/bundle.l10n.el.json', text] as const),
      ...strings(json('src/webview/i18n/locales/el.json')).map((text) => ['src/webview/i18n/locales/el.json', text] as const),
      ...strings(json('src/desktop/shell/locales/el.json')).map((text) => ['src/desktop/shell/locales/el.json', text] as const),
    ];
    expect(texts.flatMap(([file, text]) => unknownPaths(text, GREEK, labels).map((found) => `${file}: ${found}`))).toEqual([]);
  });
});
