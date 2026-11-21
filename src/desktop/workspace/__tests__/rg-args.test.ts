import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { describe, expect, it } from 'vitest';
import type { SearchQuery } from '../../../shared/text-search';
import { EDITOR_CONFIRM_DOCUMENT_BYTES } from '../../../shared/types/messages';
import { ALL_IGNORE_FILES, type WalkIgnore } from '../../../core/search-walk';
import { excludeSettingGlobs, parseGlobList, searchRequest } from '../search/rg-args';

const query = (overrides: Partial<SearchQuery> = {}): SearchQuery => ({
  pattern: 'needle',
  isRegex: false,
  matchCase: false,
  wholeWord: false,
  include: '',
  exclude: '',
  useExcludeSettingsAndIgnoreFiles: true,
  onlyOpenEditors: false,
  ...overrides,
});

const request = (overrides: Partial<SearchQuery> = {}, extra: { include?: string[]; exclude?: string[]; excludeSettings?: string[]; ignore?: WalkIgnore; followLinks?: boolean; contextLines?: number } = {}) =>
  searchRequest({
    query: query(overrides),
    include: extra.include ?? [],
    exclude: extra.exclude ?? [],
    excludeSettings: extra.excludeSettings ?? [],
    ignore: extra.ignore ?? ALL_IGNORE_FILES,
    followLinks: extra.followLinks ?? false,
    contextLines: extra.contextLines ?? 0,
  });
const args = (overrides: Partial<SearchQuery> = {}, extra: { contextLines?: number } = {}): readonly string[] => request(overrides, extra).match;

describe('searchRequest', () => {
  it('names no file, follows no link and treats CRLF as a line end: the walk lists the files', () => {
    const match = args();
    expect(match[0]).toBe('--crlf');
    for (const flag of ['--follow', '-L', '--hidden', '--json', '.', '--', 'needle']) expect(match).not.toContain(flag);
    expect(request().pattern).toBe('needle');
  });

  it('searches a file larger than the editor opens, as VS Code sets no file size limit', () => {
    expect(args()).not.toContain('--max-filesize');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-rg-'));
    try {
      const line = `${'x'.repeat(80)}\n`;
      fs.writeFileSync(path.join(folder, 'big.txt'), `${line.repeat(Math.ceil(EDITOR_CONFIRM_DOCUMENT_BYTES / line.length) + 1)}needle\n`);
      const out = execFileSync(rgPath, ['--json', '--no-config', ...args(), '--regexp', 'needle', 'big.txt'], { cwd: folder, encoding: 'utf8', maxBuffer: 1024 * 1024 });
      const matches = out.split('\n').filter((event) => event.startsWith('{"type":"match"'));
      expect(matches).toHaveLength(1);
      expect(JSON.parse(matches[0]!).data.path.text).toBe('big.txt');
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('keeps the pattern out of the flags, a fixed string read as one by --fixed-strings', () => {
    const fixed = request({ pattern: '--pre=evil' });
    expect(fixed.match.at(-1)).toBe('--fixed-strings');
    expect(fixed.match).not.toContain('--pre=evil');
    expect(fixed.pattern).toBe('--pre=evil');
  });

  it('searches a regex with the auto engine, the pattern apart from the flags', () => {
    const regex = request({ pattern: '-e|--follow', isRegex: true });
    const match = regex.match;
    expect(match.slice(-2)).toEqual(['--engine', 'auto']);
    expect(regex.pattern).toBe('-e|--follow');
    expect(match.filter((arg) => arg === '--follow')).toHaveLength(0);
    expect(match).not.toContain('--multiline');
    expect(args({ pattern: 'a\\nb', isRegex: true })).toContain('--multiline');
  });

  it('asks for VS Code\'s context lines only for a Search Editor with some, and refuses a count out of range', () => {
    expect(args()).not.toContain('--before-context');
    const match = args({}, { contextLines: 2 });
    expect(match.slice(match.indexOf('--before-context'), match.indexOf('--before-context') + 4)).toEqual(['--before-context', '2', '--after-context', '2']);
    expect(() => args({}, { contextLines: 101 })).toThrow('Context lines out of range');
    expect(() => args({}, { contextLines: 1.5 })).toThrow('Context lines out of range');
  });

  it('maps the case and whole word toggles', () => {
    expect(args({ matchCase: true })).toContain('--case-sensitive');
    expect(args({ matchCase: false })).toContain('--ignore-case');
    expect(args({ wholeWord: true })).toContain('--word-regexp');
    expect(args({ wholeWord: false })).not.toContain('--word-regexp');
  });

  it('walks with the exclude settings and ignore files only while the toggle is on', () => {
    const ignore: WalkIgnore = { files: true, global: true, parents: false };
    const on = request({}, { include: ['src/**'], exclude: ['**/gen'], excludeSettings: ['**/node_modules', '**/.git'], ignore });
    expect(on.walk).toEqual({ ignore, overrides: ['src/**', '!**/gen', '!**/node_modules', '!**/.git'] });
    const off = request({ useExcludeSettingsAndIgnoreFiles: false }, { exclude: ['**/gen'], excludeSettings: ['**/node_modules', '**/.git'], ignore });
    expect(off.walk).toEqual({ ignore: { files: false, global: false, parents: false }, overrides: ['!**/gen'] });
  });

  it('walks through links with the follow setting on, whatever the toggle, and never asks rg to follow one', () => {
    for (const useExcludeSettingsAndIgnoreFiles of [true, false]) {
      const followed = request({ useExcludeSettingsAndIgnoreFiles }, { followLinks: true });
      expect(followed.walk.followLinks).toBe(true);
      expect(followed.match).not.toContain('--follow');
      expect(request({ useExcludeSettingsAndIgnoreFiles }).walk).not.toHaveProperty('followLinks');
    }
  });
});

describe('parseGlobList', () => {
  it('splits on commas and matches a pattern without a slash at any depth, folders with their contents', () => {
    expect(parseGlobList(' src/** , *.ts,, .js , node_modules/, ./lib\\a ')).toEqual({
      ok: true,
      globs: ['src/**', '**/*.ts', '**/*.ts/**', '**/*.js', '**/*.js/**', '**/node_modules', '**/node_modules/**', '/lib/a', '/lib/a/**'],
    });
    expect(parseGlobList('')).toEqual({ ok: true, globs: [] });
  });

  it.each(['../x', 'src/../../x', 'a\\..\\b', '/etc/**', '\\x', '\\\\server\\share\\*', '//server/share', 'C:/Users/**', 'c:x', '..'])('refuses %j', (glob) => {
    expect(parseGlobList(`src/**, ${glob}`)).toEqual({ ok: false, glob });
  });

  it('keeps a comma inside braces or brackets in its glob, as VS Code does', () => {
    expect(parseGlobList('*.{ts,js}, src/[a,b]*')).toEqual({ ok: true, globs: ['**/*.{ts,js}', '**/*.{ts,js}/**', 'src/[a,b]*', 'src/[a,b]*/**'] });
  });

  it.each(['{a,../x}', 'src/{a,..}', '{a,/etc/x}', '*.{ts,C:/x}'])('refuses %j, whose brace alternative leaves the folder', (glob) => {
    expect(parseGlobList(glob)).toEqual({ ok: false, glob });
  });

  it('anchors a ./folder entry at the shown folder, as VS Code\'s Find in Folder writes it', () => {
    expect(parseGlobList('./src')).toEqual({ ok: true, globs: ['/src', '/src/**'] });
    expect(parseGlobList('./.github')).toEqual({ ok: true, globs: ['/.github', '/.github/**'] });
  });

  it.each([',', '{', '}', '[', ']', '*', '?'])('keeps a folder name with an escaped %j as one entry', (char) => {
    expect(parseGlobList(`./a[${char}]b, x`)).toEqual({ ok: true, globs: [`/a[${char}]b`, `/a[${char}]b/**`, '**/x', '**/x/**'] });
  });

  it('keeps a dotted name that is no parent segment', () => {
    expect(parseGlobList('a..b/**, ..c')).toMatchObject({ ok: true });
  });
});

describe('excludeSettingGlobs', () => {
  it('takes the entries set to true', () => {
    expect(excludeSettingGlobs({ '**/node_modules': true, '**/dist': false, '**/x': 'yes' })).toEqual(['**/node_modules']);
  });
});
