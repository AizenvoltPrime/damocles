import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { describe, expect, it } from 'vitest';
import type { SearchQuery } from '../../../shared/text-search';
import { EDITOR_MAX_DOCUMENT_BYTES } from '../../../shared/types/messages';
import { excludeSettingGlobs, parseGlobList, rgSearchArgs } from '../search/rg-args';

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

const args = (overrides: Partial<SearchQuery> = {}, extra: { include?: string[]; exclude?: string[]; excludeSettings?: string[]; ignoreArgs?: string[]; contextLines?: number } = {}) =>
  rgSearchArgs({
    query: query(overrides),
    include: extra.include ?? [],
    exclude: extra.exclude ?? [],
    excludeSettings: extra.excludeSettings ?? [],
    ignoreArgs: extra.ignoreArgs ?? [],
    contextLines: extra.contextLines ?? 0,
  });

describe('rgSearchArgs', () => {
  it('always reads no config file, reports JSON, treats CRLF as a line end, searches hidden files and never follows links', () => {
    const argv = args();
    expect(argv.slice(0, 4)).toEqual(['--json', '--no-config', '--crlf', '--hidden']);
    expect(argv).not.toContain('--follow');
    expect(argv).not.toContain('-L');
    expect(argv.at(-1)).toBe('.');
  });

  it('searches a file larger than the editor opens, as VS Code sets no file size limit', () => {
    expect(args()).not.toContain('--max-filesize');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-rg-'));
    try {
      const line = `${'x'.repeat(80)}\n`;
      fs.writeFileSync(path.join(folder, 'big.txt'), `${line.repeat(Math.ceil(EDITOR_MAX_DOCUMENT_BYTES / line.length) + 1)}needle\n`);
      const out = execFileSync(rgPath, args(), { cwd: folder, encoding: 'utf8', maxBuffer: 1024 * 1024 });
      const matches = out.split('\n').filter((event) => event.startsWith('{"type":"match"'));
      expect(matches).toHaveLength(1);
      expect(JSON.parse(matches[0]!).data.path.text).toMatch(/big\.txt$/);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('puts a fixed string after --, so a pattern starting with - is text', () => {
    const argv = args({ pattern: '--pre=evil' });
    expect(argv.slice(-4)).toEqual(['--fixed-strings', '--', '--pre=evil', '.']);
    expect(argv.indexOf('--pre=evil')).toBeGreaterThan(argv.indexOf('--'));
  });

  it('passes a regex as the value of --regexp with the auto engine, and only then the path after --', () => {
    const argv = args({ pattern: '-e|--follow', isRegex: true });
    expect(argv.slice(-6)).toEqual(['--engine', 'auto', '--regexp', '-e|--follow', '--', '.']);
    expect(argv.filter((arg) => arg === '--follow')).toHaveLength(0);
    expect(argv).not.toContain('--multiline');
    expect(args({ pattern: 'a\\nb', isRegex: true })).toContain('--multiline');
  });

  it('asks for VS Code\'s context lines only for a Search Editor with some, and refuses a count out of range', () => {
    expect(args()).not.toContain('--before-context');
    const argv = args({}, { contextLines: 2 });
    expect(argv.slice(argv.indexOf('--before-context'), argv.indexOf('--before-context') + 4)).toEqual(['--before-context', '2', '--after-context', '2']);
    expect(() => args({}, { contextLines: 101 })).toThrow('Context lines out of range');
    expect(() => args({}, { contextLines: 1.5 })).toThrow('Context lines out of range');
  });

  it('maps the case and whole word toggles', () => {
    expect(args({ matchCase: true })).toContain('--case-sensitive');
    expect(args({ matchCase: false })).toContain('--ignore-case');
    expect(args({ wholeWord: true })).toContain('--word-regexp');
    expect(args({ wholeWord: false })).not.toContain('--word-regexp');
  });

  it('applies the exclude settings and ignore files only while the toggle is on', () => {
    const on = args({}, { include: ['src/**'], exclude: ['**/gen'], excludeSettings: ['**/node_modules'], ignoreArgs: ['--no-ignore-parent'] });
    expect(on).toEqual(expect.arrayContaining(['-g', 'src/**', '-g', '!**/gen', '-g', '!**/node_modules', '--no-ignore-parent']));
    expect(on).not.toContain('--no-ignore');
    const off = args({ useExcludeSettingsAndIgnoreFiles: false }, { exclude: ['**/gen'], excludeSettings: ['**/node_modules'], ignoreArgs: ['--no-ignore-parent'] });
    expect(off).toContain('--no-ignore');
    expect(off).toContain('!**/gen');
    expect(off).not.toContain('!**/node_modules');
    expect(off).not.toContain('--no-ignore-parent');
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
