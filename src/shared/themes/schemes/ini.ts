// A strict INI reader for KDE color schemes (KConfig) and qt5ct/qt6ct palettes (QSettings). Untrusted text: linear scans, no
// regular expression that can backtrack, and capped lines and groups.
import { l } from '../../localized-text';
import { SchemeImportError } from './errors';

export const MAX_INI_LINES = 20_000;
export const MAX_INI_GROUPS = 1_000;

/** Each group's keys and values; a group is named by its whole bracket text, so `[Colors:Header][Inactive]` is `Colors:Header][Inactive`. */
export type Ini = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** A QSettings value written in double quotes, unquoted; any other value as written. */
export function iniValue(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  let out = '';
  for (let i = 1; i < value.length - 1; i++) {
    const char = value[i]!;
    if (char !== '\\' || i === value.length - 2) {
      out += char;
      continue;
    }
    const next = value[++i]!;
    out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
  }
  return out;
}

// KConfig's immutable and deleted markers, which leave the key or group what it is
const KCONFIG_FLAG = /\[\$[id]\]$/;

/** QSettings' logical lines with their first line numbers: a `\` escapes the next character, a line break included, and a `;` outside quotes ends the line. */
function qsettingsLines(text: string): Array<readonly [number, string]> {
  const lines: Array<readonly [number, string]> = [];
  let start = 1;
  let number = 1;
  let line = '';
  let from = 0;
  let quoted = false;
  let comment = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\n') {
      if (!comment) line += text.slice(from, i);
      lines.push([start, line]);
      start = ++number;
      line = '';
      from = i + 1;
      quoted = false;
      comment = false;
    } else if (comment) {
      continue;
    } else if (char === '\\') {
      const lineBreak = text[i + 1] === '\n' ? 1 : text[i + 1] === '\r' && text[i + 2] === '\n' ? 2 : 0;
      if (lineBreak > 0) {
        line += text.slice(from, i);
        i += lineBreak;
        from = i + 1;
        number++;
      } else {
        i++;
      }
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ';' && !quoted) {
      line += text.slice(from, i);
      comment = true;
    }
  }
  if (!comment) line += text.slice(from);
  lines.push([start, line]);
  return lines;
}

/**
 * `text` as INI groups, each value as written (`iniValue` and `iniList` read QSettings quoting). Blank lines and lines
 * starting with `#` or `;` are comments; keys before any group belong to the group named ''. A `[$i]` or `[$d]` after a key
 * or group name is dropped, any other suffix (`Name[de]`, `Key[$e]`) skips the key, and a later value of a key replaces an
 * earlier one. Any other line, a NUL byte, or more than MAX_INI_LINES lines or MAX_INI_GROUPS groups is refused; with
 * `lenient` any other line is skipped, as KConfig and QSettings skip it, and only the NUL byte and the caps are refused.
 * With `qsettings` the lines follow QSettings' rules (`qsettingsLines`), for Qt's files and never KConfig's.
 */
export function readIni(text: string, fileName: string, { lenient = false, qsettings = false }: { readonly lenient?: boolean; readonly qsettings?: boolean } = {}): Ini {
  if (text.includes('\0')) throw new SchemeImportError('syntax', l('{0} holds a NUL byte, so it is not a text settings file.', fileName));
  // newline-terminated lines, and a last line without one
  let count = text === '' || text.endsWith('\n') ? 0 : 1;
  for (let at = text.indexOf('\n'); at >= 0 && count <= MAX_INI_LINES; at = text.indexOf('\n', at + 1)) count++;
  if (count > MAX_INI_LINES) throw new SchemeImportError('syntax', l('{0} has more than {1} lines, more than a color scheme needs.', fileName, String(MAX_INI_LINES)));
  const groups = new Map<string, Map<string, string>>();
  let group = new Map<string, string>();
  groups.set('', group);
  const lines = qsettings ? qsettingsLines(text) : text.split('\n').map((line, index) => [index + 1, line] as const);
  for (const [number, raw] of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      const header = line.replace(KCONFIG_FLAG, '');
      // a `[$i]` line alone locks the whole file
      if (header === '') continue;
      const name = header.endsWith(']') ? header.slice(1, -1).trim() : '';
      if (name === '' && lenient) continue;
      if (name === '') throw new SchemeImportError('syntax', l('{0} is not a settings file: line {1} is not a group name.', fileName, String(number)));
      const known = groups.get(name);
      if (known === undefined && groups.size > MAX_INI_GROUPS) throw new SchemeImportError('syntax', l('{0} has more than {1} groups, more than a color scheme needs.', fileName, String(MAX_INI_GROUPS)));
      group = known ?? new Map<string, string>();
      groups.set(name, group);
      continue;
    }
    const equals = line.indexOf('=');
    const written = equals > 0 ? line.slice(0, equals).trim() : '';
    if (written === '' && lenient) continue;
    if (written === '') throw new SchemeImportError('syntax', l('{0} is not a settings file: line {1} is not a key=value line.', fileName, String(number)));
    const key = written.replace(KCONFIG_FLAG, '').trim();
    if (key === '' || key.endsWith(']')) continue;
    group.set(key, line.slice(equals + 1).trim());
  }
  if (groups.get('')!.size === 0) groups.delete('');
  return groups;
}

/** A QSettings list value: comma-separated items, each trimmed and unquoted. A comma inside quotes is part of its item. */
export function iniList(value: string): string[] {
  const items: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i <= value.length; i++) {
    const char = value[i];
    if (char === '\\' && quoted && i < value.length - 1) i++;
    else if (char === '"') quoted = !quoted;
    else if (char === undefined || (char === ',' && !quoted)) {
      items.push(iniValue(value.slice(start, i).trim()));
      start = i + 1;
    }
  }
  return items;
}
