import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OUTSIDE_ROOT_CODE } from '../confine-modules';
import { formatRequest, type PrettierApi } from '../format-request';
import type { HostRequest } from '../protocol';

let root: string;
let entry: string;
let calls: Array<[string, ...unknown[]]>;
let events: string[];
let refused: string[];

function fakePrettier(overrides: Partial<PrettierApi> = {}): PrettierApi {
  return {
    version: '3.3.3',
    resolveConfig: async (file, options) => {
      calls.push(['resolveConfig', file, options]);
      return { semi: false, plugins: ['prettier-plugin-x'] };
    },
    getFileInfo: async (file, options) => {
      calls.push(['getFileInfo', file, options]);
      return { ignored: false, inferredParser: 'typescript' };
    },
    format: async (text) => {
      events.push(`format:${text}`);
      return `${text}!`;
    },
    ...overrides,
  };
}

function request(config: string | null): HostRequest {
  return { id: 7, prettier: entry, config, file: path.join(root, 'src', 'a.ts'), text: 'a' };
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-fhost-')));
  const packageDir = path.join(root, 'node_modules', 'prettier');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), '{"name":"prettier","version":"3.3.3"}');
  entry = path.join(packageDir, 'index.cjs');
  calls = [];
  events = [];
  refused = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('formatRequest (D29)', () => {
  it('loads exactly the config main named and never lets Prettier search for one', async () => {
    const prettier = fakePrettier();
    const config = path.join(root, '.prettierrc');
    const reply = await formatRequest(request(config), { load: () => prettier, refused, loaded: () => events.push('loaded') });
    expect(reply).toEqual({ id: 7, kind: 'formatted', text: 'a!' });
    expect(calls).toEqual([
      ['resolveConfig', path.join(root, 'src', 'a.ts'), { config, editorconfig: true, useCache: false }],
      ['getFileInfo', path.join(root, 'src', 'a.ts'), { resolveConfig: false, ignorePath: ['.gitignore', '.prettierignore'], plugins: ['prettier-plugin-x'] }],
    ]);
  });

  it('with no config names Prettier\'s own package.json, which loads as none, so .editorconfig still applies', async () => {
    const prettier = fakePrettier();
    await formatRequest(request(null), { load: () => prettier, refused, loaded: () => undefined });
    expect(calls[0]).toEqual(['resolveConfig', path.join(root, 'src', 'a.ts'), { config: path.join(root, 'node_modules', 'prettier', 'package.json'), editorconfig: true, useCache: false }]);
  });

  it('loads a parser once with an empty text, then reports loaded before the format', async () => {
    const prettier = fakePrettier({ version: '2.8.8' });
    const deps = { load: () => prettier, refused, loaded: () => events.push('loaded') };
    await formatRequest(request(null), deps);
    await formatRequest(request(null), deps);
    expect(events).toEqual(['format:', 'loaded', 'format:a', 'loaded', 'format:a']);
    expect(calls[1]![2]).toMatchObject({ ignorePath: '.prettierignore' });
  });

  it('answers ignored for an ignored file or one with no parser, without loading a parser', async () => {
    const prettier = fakePrettier({ getFileInfo: async () => ({ ignored: false, inferredParser: null }) });
    expect(await formatRequest(request(null), { load: () => prettier, refused, loaded: () => events.push('loaded') })).toEqual({ id: 7, kind: 'ignored' });
    expect(events).toEqual([]);
  });

  it('answers refused with the path the module hook refused, whether Prettier passes its error on or replaces it', async () => {
    const outside = path.join(path.dirname(root), 'node_modules', 'prettier-plugin-x', 'index.js');
    const hookError = Object.assign(new Error('refused'), { code: OUTSIDE_ROOT_CODE, path: outside });
    const passing = fakePrettier({ getFileInfo: async () => { throw new Error('Cannot load plugin', { cause: hookError }); } });
    expect(await formatRequest(request(null), { load: () => passing, refused, loaded: () => undefined })).toEqual({ id: 7, kind: 'refused', path: outside });

    const replacing = fakePrettier({
      getFileInfo: async () => {
        refused.push(outside);
        throw new Error('Couldn\'t resolve parser "x"');
      },
    });
    expect(await formatRequest(request(null), { load: () => replacing, refused, loaded: () => undefined })).toEqual({ id: 7, kind: 'refused', path: outside });
  });

  it('answers an error with Prettier\'s message when nothing was refused, and never rejects', async () => {
    const failing = fakePrettier({ format: async (text) => { if (text === '') return ''; throw new Error('SyntaxError: x'); } });
    expect(await formatRequest(request(null), { load: () => failing, refused, loaded: () => undefined })).toEqual({ id: 7, kind: 'error', message: 'SyntaxError: x' });
    expect(await formatRequest(request(null), { load: () => { throw new Error('Cannot find module'); }, refused, loaded: () => undefined })).toEqual({ id: 7, kind: 'error', message: 'Cannot find module' });
  });
});
