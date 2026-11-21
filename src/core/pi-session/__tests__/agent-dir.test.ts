import { describe, it, expect } from 'vitest';
import { cacheWarmingSetting } from '../agent-dir';
import { installFakePlatform } from '../../../__mocks__/fake-platform';

describe('cacheWarmingSetting', () => {
  // pi coerces an unknown mode to "idle"; the extension must seed the same value rather than a
  // mode pi will silently ignore.
  it('falls back to idle when damocles.cacheWarming is unset', () => {
    installFakePlatform();
    expect(cacheWarmingSetting()).toBe('idle');
  });
});
