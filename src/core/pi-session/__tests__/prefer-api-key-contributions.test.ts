import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KEY_PROVIDER_IDS } from '../../../shared/settings-sections';
import { readContributedConfiguration } from '../../config/read-contributed-configuration';
import { OPENAI_PREFER_API_KEY_SETTING } from '../openai-auth';
import { PREFER_API_KEY_SETTINGS, preferApiKeySetting } from '../provider-auth';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
  contributes: { configuration: { properties: Record<string, Record<string, unknown>> } };
};
const nls = (file: string) => JSON.parse(readFileSync(`${root}${file}`, 'utf8')) as Record<string, string>;

// Each flag chooses between this machine's sign-in and the key saved on it, so Settings Sync must not carry it to another machine.
describe('Prefer API key contributions', () => {
  it('lists the OpenAI flag and one flag per key provider', () => {
    expect(PREFER_API_KEY_SETTINGS).toEqual([OPENAI_PREFER_API_KEY_SETTING, ...KEY_PROVIDER_IDS.map(preferApiKeySetting)]);
  });

  // a contributed flag missing from the list would skip the key-value state move and the settings listener
  it('lists every Prefer API key setting package.json contributes', () => {
    const contributed = Object.keys(pkg.contributes.configuration.properties).filter((key) => /^damocles\.[^.]+\.preferApiKey$/.test(key));
    expect(contributed.length).toBeGreaterThan(0);
    for (const key of contributed) expect(PREFER_API_KEY_SETTINGS).toContain(key);
  });

  it.each(PREFER_API_KEY_SETTINGS)('contributes %s as an application-scope boolean, off by default and kept out of Settings Sync', (key) => {
    expect(pkg.contributes.configuration.properties[key]).toMatchObject({ type: 'boolean', default: false, scope: 'application', ignoreSync: true });
    expect(readContributedConfiguration(root).userOnlyKeys).toContain(key);
  });

  it.each(PREFER_API_KEY_SETTINGS)('describes %s in English and Greek', (key) => {
    const description = pkg.contributes.configuration.properties[key]?.['description'];
    const id = /^%(.+)%$/.exec(String(description))?.[1];
    expect(id).toBeDefined();
    expect(nls('package.nls.json')[id!]).toBeTruthy();
    expect(nls('package.nls.el.json')[id!]).toBeTruthy();
  });
});
