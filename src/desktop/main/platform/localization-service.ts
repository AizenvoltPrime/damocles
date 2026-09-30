import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../../platform/disposable';
import type { LocalizationService } from '../../../platform/localization-service';
import { Emitter } from './emitter';

export type DesktopLanguage = 'en' | 'el';

export interface DesktopLocalizationService extends LocalizationService {
  readonly language: DesktopLanguage;
  // package.nls(.el).json string by key, e.g. 'command.openChat.title'
  packageString(key: string): string;
  setLanguage(language: DesktopLanguage): void;
  onDidChangeLanguage(listener: (language: DesktopLanguage) => void): Disposable;
}

// The bundles ship only English and Greek.
export function normalizeLanguage(locale: string): DesktopLanguage {
  return locale.toLowerCase().split(/[-_]/)[0] === 'el' ? 'el' : 'en';
}

// {0}, {1}, ... are replaced by the positional args; an index with no arg stays as written, as vscode.l10n.t does.
export function formatMessage(template: string, args: ReadonlyArray<string | number | boolean>): string {
  return template.replace(/\{(\d+)\}/g, (match, index: string) => {
    const arg = args[Number(index)];
    return arg === undefined ? match : String(arg);
  });
}

// A Map, so a message such as 'constructor' never resolves to an Object.prototype member.
function readStringTable(filePath: string): ReadonlyMap<string, string> {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${filePath} is not a string table`);
  const table = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') table.set(key, value);
  }
  return table;
}

interface StringTables {
  readonly messages: ReadonlyMap<string, string>;
  readonly packageStrings: ReadonlyMap<string, string>;
}

function readTables(resourceRoot: string, language: DesktopLanguage): StringTables {
  const suffix = language === 'el' ? '.el' : '';
  return {
    messages: readStringTable(path.join(resourceRoot, 'l10n', `bundle.l10n${suffix}.json`)),
    packageStrings: readStringTable(path.join(resourceRoot, `package.nls${suffix}.json`)),
  };
}

// English messages are their own keys, so English needs no bundle lookup to be correct; the host reads language on every call, so a change applies to the next string.
export function createDesktopLocalizationService(resourceRoot: string, initial: DesktopLanguage, log: (line: string) => void): DesktopLocalizationService {
  const english = readTables(resourceRoot, 'en');
  let language = initial;
  let tables = language === 'en' ? english : readTables(resourceRoot, language);
  const listeners = new Emitter<[DesktopLanguage]>('l10n', log);
  return {
    get language() {
      return language;
    },
    t: (message, ...args) => formatMessage(tables.messages.get(message) ?? message, args),
    packageString: (key) => {
      const value = tables.packageStrings.get(key) ?? english.packageStrings.get(key);
      if (value === undefined) throw new Error(`No package.nls string for ${key}`);
      return value;
    },
    setLanguage: (next) => {
      if (next === language) return;
      tables = next === 'en' ? english : readTables(resourceRoot, next);
      language = next;
      listeners.fire(next);
    },
    onDidChangeLanguage: (listener) => listeners.add(listener),
  };
}
