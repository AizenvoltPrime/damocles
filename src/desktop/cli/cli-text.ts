import * as path from 'node:path';
import { fillMessage } from '../../shared/localized-text';
import type { CliLanguage, CliLimit } from './cli-protocol';

export type Translate = (message: string, ...args: string[]) => string;

/** The command's own text in language, from the l10n bundle in l10nDir, read with read (Electron's archive-aware fs on this computer). */
export function translator(language: CliLanguage, l10nDir: string, read: (file: string) => string): Translate {
  if (language === 'en') return (message, ...args) => fillMessage(message, args);
  const parsed: unknown = JSON.parse(read(path.join(l10nDir, 'bundle.l10n.el.json')));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${l10nDir}/bundle.l10n.el.json is not a string table`);
  // a Map, so a message such as 'constructor' never resolves to an Object.prototype member
  const table = new Map(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  return (message, ...args) => fillMessage(table.get(message) ?? message, args);
}

// characters of an oversized value a refusal shows
const SHOWN_CHARS = 80;

/** One line naming the bound of the contract a request breaks. */
export function limitText(limit: CliLimit, t: Translate): string {
  switch (limit.kind) {
    case 'items':
      return t('damocles: a request names at most {0} paths.', String(limit.max));
    case 'chars':
      return t('damocles: {0} is longer than {1} characters.', limit.value.length > SHOWN_CHARS ? `${limit.value.slice(0, SHOWN_CHARS)}…` : limit.value, String(limit.max));
    case 'bytes':
      return t('damocles: the request is over 64 KiB. Name fewer or shorter paths.');
  }
}
