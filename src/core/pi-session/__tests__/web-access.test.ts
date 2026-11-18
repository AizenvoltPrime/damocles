import { describe, it, expect } from 'vitest';
import { installFakePlatform } from '../../../__mocks__/fake-platform';
import { isWebSearchEnabled } from '../web-access';

describe('web-access', () => {
  it('is on by default', () => {
    installFakePlatform();
    expect(isWebSearchEnabled()).toBe(true);
  });

  it('is off when false is saved', () => {
    installFakePlatform({ settings: { user: { 'damocles.pi.webSearch.enabled': false } } });
    expect(isWebSearchEnabled()).toBe(false);
  });

  it('is off when a non-boolean is saved', () => {
    installFakePlatform({ settings: { user: { 'damocles.pi.webSearch.enabled': 'false' } } });
    expect(isWebSearchEnabled()).toBe(false);
  });
});
