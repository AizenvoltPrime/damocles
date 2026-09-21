import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CacheWarmingMode as PiCacheWarmingMode } from '@earendil-works/pi-coding-agent';
import { CACHE_WARMING_MODES, DEFAULT_CACHE_WARMING, parseCacheWarmingMode } from '../types/constants';
import type { CacheWarmingMode } from '../types/settings';

/**
 * pi accepts any string for its `cacheWarming` setting and silently coerces an unknown one to
 * `"streaming"`, so a bad value never surfaces as an error: it surfaces as a settings file that
 * disagrees with the behaviour the user gets. These pin the three modes, the default, and the two
 * copies of that list that live outside `CACHE_WARMING_MODES` (pi's union and package.json).
 */

/** Compile-time drift guard: the local union and pi's must be assignable both ways. */
type MutuallyAssignable =
  [PiCacheWarmingMode] extends [CacheWarmingMode]
    ? [CacheWarmingMode] extends [PiCacheWarmingMode]
      ? true
      : false
    : false;
const unionsMatch: MutuallyAssignable = true;

const packageJsonUrl = new URL('../../../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(fileURLToPath(packageJsonUrl), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, { default?: unknown; enum?: string[]; scope?: string }> } };
};
const contribution = pkg.contributes.configuration.properties['damocles.cacheWarming'];

describe('parseCacheWarmingMode', () => {
  it.each(CACHE_WARMING_MODES)('passes %s through', (mode) => {
    expect(parseCacheWarmingMode(mode)).toBe(mode);
  });

  it.each([['always'], [''], ['Idle']])('falls back to the default for the stored string %j', (stored) => {
    expect(parseCacheWarmingMode(stored)).toBe(DEFAULT_CACHE_WARMING);
  });

  it.each([[undefined], [null], [42], [{ mode: 'idle' }], [['idle']]])(
    'falls back to the default for the non-string value %j',
    (stored) => {
      expect(parseCacheWarmingMode(stored)).toBe(DEFAULT_CACHE_WARMING);
    },
  );

  it('matches the value pi coerces an unknown mode to', () => {
    expect(DEFAULT_CACHE_WARMING).toBe('streaming');
  });
});

describe('damocles.cacheWarming contribution', () => {
  it('declares the same modes as CACHE_WARMING_MODES', () => {
    expect(contribution?.enum).toEqual([...CACHE_WARMING_MODES]);
  });

  // package.json cannot import the constant, so the manifest default is checked here instead.
  it('defaults to DEFAULT_CACHE_WARMING', () => {
    expect(contribution?.default).toBe(DEFAULT_CACHE_WARMING);
  });

  // Warming bills the user, so a cloned repo's .vscode/settings.json must not be able to enable it.
  it('is application-scoped, not settable per workspace', () => {
    expect(contribution?.scope).toBe('application');
  });
});

describe('pi union drift', () => {
  it('has the same modes as pi', () => {
    expect(unionsMatch).toBe(true);
  });
});
