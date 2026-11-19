import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readContributedConfiguration } from '../../config/read-contributed-configuration';
import { writableKeysOf } from '../../chat-panel/settings-view-scope';
import {
  UPLOAD_FOLDER_MAX_ENTRIES,
  UPLOAD_FOLDER_MAX_ENTRIES_SETTING,
  UPLOAD_FOLDER_MAX_SIZE,
  UPLOAD_FOLDER_MAX_SIZE_SETTING,
} from '../../../shared/types/constants';

const root = new URL('../../../../', import.meta.url);
const read = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(name, root)), 'utf8'));
const pkg = read('package.json') as { contributes: { configuration: { properties: Record<string, Record<string, unknown>> } } };
const properties = pkg.contributes.configuration.properties;

const CAPS = [
  [UPLOAD_FOLDER_MAX_ENTRIES_SETTING, UPLOAD_FOLDER_MAX_ENTRIES],
  [UPLOAD_FOLDER_MAX_SIZE_SETTING, UPLOAD_FOLDER_MAX_SIZE],
] as const;

describe('folder upload cap contributions', () => {
  it.each(CAPS)('%s is an integer whose default and range equal the reader\'s', (key, range) => {
    expect(properties[key]).toMatchObject({ type: 'integer', default: range.default, minimum: range.min, maximum: range.max });
  });

  it.each(CAPS)('%s has a description in English and Greek', (key) => {
    const description = properties[key]!['description'] as string;
    const name = /^%(.+)%$/.exec(description)?.[1];
    expect(name).toBeDefined();
    expect((read('package.nls.json') as Record<string, unknown>)[name!]).toEqual(expect.any(String));
    expect((read('package.nls.el.json') as Record<string, unknown>)[name!]).toEqual(expect.any(String));
  });

  // A repository must not raise how much of a folder the agent may copy, so only user settings set the caps.
  it('declares both caps application scope, which the desktop store reads from user settings only and no Project tab lists', () => {
    const contributed = readContributedConfiguration(fileURLToPath(root));
    for (const [key] of CAPS) {
      expect(properties[key]!['scope'], key).toBe('application');
      expect(contributed.userOnlyKeys.has(key), key).toBe(true);
      expect(writableKeysOf('project', contributed), key).not.toContain(key);
      expect(writableKeysOf('user', contributed), key).toContain(key);
    }
  });
});
