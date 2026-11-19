import { describe, expect, it } from 'vitest';
import { ALL_IGNORE_FILES, walkIgnoreOf } from '..';

const settings = (values: Record<string, unknown>) => ({ get: <T>(key: string): T | undefined => values[key] as T | undefined });

describe('walkIgnoreOf', () => {
  it('turns every ignore switch on by default, as VS Code does', () => {
    expect(walkIgnoreOf(settings({}))).toEqual(ALL_IGNORE_FILES);
  });

  it.each([
    ['search.useIgnoreFiles', { files: false, global: true, parents: true }],
    ['search.useGlobalIgnoreFiles', { files: true, global: false, parents: true }],
    ['search.useParentIgnoreFiles', { files: true, global: true, parents: false }],
  ])('turns off only its own switch for %s set to false', (key, expected) => {
    expect(walkIgnoreOf(settings({ [key]: false }))).toEqual(expected);
  });
});
