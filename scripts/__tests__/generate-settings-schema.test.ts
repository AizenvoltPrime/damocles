import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import Ajv from 'ajv';
// @ts-expect-error -- plain .mjs helper, no types
import { renderSettingsSchemas, OUTPUT, PERMISSION_LISTS } from '../generate-settings-schema.mjs';
import { readContributedConfiguration } from '../../src/core/config/contributed-configuration';
import { DESKTOP_CONFIGURATION } from '../../src/desktop/main/desktop-configuration';
import type { FilePermissions } from '../../src/core/permission-handler/permission-settings';

const ROOT = join(__dirname, '..', '..');

interface FileSchema {
  properties: Record<string, { not?: object; errorMessage?: string }>;
}
interface Schemas {
  user: FileSchema;
  project: FileSchema;
}

const schemas = JSON.parse(readFileSync(OUTPUT as string, 'utf8')) as Schemas;
const desktopKeys = Object.keys(DESKTOP_CONFIGURATION);
const desktopUserOnlyKeys = Object.entries(DESKTOP_CONFIGURATION).filter(([, property]) => property.scope === 'application').map(([key]) => key);

function validator(schema: FileSchema) {
  // Monaco-only keywords (errorMessage, doNotSuggest, enumDescriptions, markdownDescription) are annotations here.
  return new Ajv({ strict: false, allErrors: true }).compile(schema);
}

describe('settings schema', () => {
  it('the committed file is what the generator produces', () => {
    const committed = readFileSync(OUTPUT as string, 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe((renderSettingsSchemas as (root: string) => string)(ROOT));
  });

  it('lists exactly the permission rule lists the permission reader accepts', () => {
    const readerLists: Record<keyof FilePermissions, true> = { allow: true, deny: true, ask: true };
    expect(Object.keys(PERMISSION_LISTS as object).sort()).toEqual(Object.keys(readerLists).sort());
  });

  it('describes every contributed key and every desktop-only key in both variants', () => {
    const { keys } = readContributedConfiguration(ROOT);
    expect(desktopKeys).toEqual(expect.arrayContaining(['damocles.desktop.theme', 'damocles.desktop.reduceMotion']));
    expect(keys.filter((key) => desktopKeys.includes(key))).toEqual([]);
    for (const variant of [schemas.user, schemas.project]) {
      expect(Object.keys(variant.properties).sort()).toEqual([...keys, ...desktopKeys, 'permissions'].sort());
    }
  });

  it('disallows exactly the user-only keys in project and local files, with a message', () => {
    const { userOnlyKeys } = readContributedConfiguration(ROOT);
    const disallowed = Object.entries(schemas.project.properties).filter(([, s]) => s.not !== undefined).map(([key]) => key);
    expect(disallowed.sort()).toEqual([...userOnlyKeys, ...desktopUserOnlyKeys].sort());
    for (const key of disallowed) expect(schemas.project.properties[key]?.errorMessage).toContain('user settings only');
    expect(Object.values(schemas.user.properties).some((s) => s.not !== undefined)).toBe(false);
  });

  it('accepts known keys and permission rules and flags an unknown key', () => {
    const validate = validator(schemas.user);
    expect(validate({ 'damocles.permissionMode': 'plan', permissions: { allow: ['Edit'], deny: [], ask: ['Bash'] } })).toBe(true);
    expect(validate({ 'damocles.permissionMode': 'nope' })).toBe(false);
    expect(validate({ 'damocles.notASetting': true })).toBe(false);
    expect(validate({ permissions: { defaultMode: 'plan' } })).toBe(false);
  });

  it('flags a user-only key in a project file but not in the user file', () => {
    expect(validator(schemas.project)({ 'damocles.permissionMode': 'plan' })).toBe(false);
    expect(validator(schemas.user)({ 'damocles.permissionMode': 'plan' })).toBe(true);
    expect(validator(schemas.project)({ 'damocles.model': 'x', permissions: { deny: ['Bash(rm:*)'] } })).toBe(true);
  });

  it('accepts the desktop theme keys in the user file only, with their declared values', () => {
    const user = validator(schemas.user);
    expect(user({ 'damocles.desktop.theme': 'light', 'damocles.desktop.reduceMotion': true })).toBe(true);
    expect(user({ 'damocles.desktop.theme': 'sepia' })).toBe(false);
    expect(validator(schemas.project)({ 'damocles.desktop.theme': 'light' })).toBe(false);
  });
});
