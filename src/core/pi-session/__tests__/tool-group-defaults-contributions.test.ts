import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The code reads each of these keys with a `true` fallback, so package.json's default must be `true` too.
const packageJsonUrl = new URL('../../../../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(fileURLToPath(packageJsonUrl), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
};
const properties = pkg.contributes.configuration.properties;

const ON_BY_DEFAULT_KEYS = ['damocles.browser.enabled', 'damocles.pi.webSearch.enabled', 'damocles.team.enabled'] as const;

describe('tool group settings contributions: default sync guard', () => {
  for (const key of ON_BY_DEFAULT_KEYS) {
    it(`${key} defaults to true`, () => {
      expect(properties[key]).toBeDefined();
      expect(properties[key]!.default).toBe(true);
    });
  }
});
