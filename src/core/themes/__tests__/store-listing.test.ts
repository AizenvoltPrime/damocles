// One theme file whose check throws is that folder listed broken: every other folder still lists.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { thrower } = vi.hoisted(() => ({ thrower: { folder: undefined as string | undefined } }));
vi.mock('../../../shared/themes/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/themes/schema')>();
  return {
    ...actual,
    validateTheme: (json: unknown, options?: { readonly folder?: string }) => {
      if (options?.folder !== undefined && options.folder === thrower.folder) throw new RangeError('Maximum call stack size exceeded');
      return actual.validateTheme(json, options);
    },
  };
});

import { createThemeStore } from '../store';
import { ID, OTHER, themeJson, writeTheme } from './service-fixtures';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-theme-listing-'));
});

afterEach(() => {
  thrower.folder = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the theme listing', () => {
  it('lists a folder whose check throws as broken, and every other folder as it is', async () => {
    writeTheme(root, ID, themeJson(ID, 'Night'));
    writeTheme(root, OTHER, themeJson(OTHER, 'Day'));
    thrower.folder = OTHER;
    const listed = await createThemeStore({ root }).list();
    expect(listed.map((entry) => [entry.id, entry.status])).toEqual([['damocles', 'ok'], [OTHER, 'broken'], [ID, 'ok']]);
    expect(listed[1]).toMatchObject({ name: 'Day', reason: { message: 'theme.json is not a valid theme: {0}', args: [{ message: '{0}', args: ['Maximum call stack size exceeded'] }] } });
  });
});
