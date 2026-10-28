import { describe, expect, it } from 'vitest';
import { daemonE2eHooks, e2eConnectionLimits, SERVER_PACKAGE } from '../server-package';

// A daemon running from a server package never serves e2e.* nor gives its core e2e hooks.
describe('daemonE2eHooks', () => {
  it('refuses the hooks in a server package whatever DAMOCLES_E2E_HOOKS says', () => {
    for (const value of ['1', '0', 'true', undefined]) expect(daemonE2eHooks({ DAMOCLES_E2E_HOOKS: value }, true)).toBe(false);
  });

  it('gives a dev-tree daemon the hooks only when the variable is 1', () => {
    expect(daemonE2eHooks({ DAMOCLES_E2E_HOOKS: '1' }, false)).toBe(true);
    expect(daemonE2eHooks({ DAMOCLES_E2E_HOOKS: 'true' }, false)).toBe(false);
    expect(daemonE2eHooks({}, false)).toBe(false);
  });

  it('is a dev-tree daemon in source; build-server.mjs flips the flag in the package bundle', () => {
    expect(SERVER_PACKAGE).toBe(false);
    expect(daemonE2eHooks({ DAMOCLES_E2E_HOOKS: '1' })).toBe(true);
  });
});

describe('e2eConnectionLimits', () => {
  it('reads a shorter grace and held-frame bound as positive integers, and nothing else', () => {
    expect(e2eConnectionLimits({})).toEqual({});
    expect(e2eConnectionLimits({ DAMOCLES_E2E_RECONNECTION_GRACE_MS: '3000', DAMOCLES_E2E_MAX_HELD_BYTES: '2097152' })).toEqual({ graceMs: 3000, maxHeldBytes: 2097152 });
    for (const bad of ['0', '-1', '1e3', ' 5', 'soon']) expect(() => e2eConnectionLimits({ DAMOCLES_E2E_RECONNECTION_GRACE_MS: bad })).toThrow(/positive integer/);
  });

  it('refuses a grace setTimeout cannot wait for, which would fire after 1 ms', () => {
    expect(e2eConnectionLimits({ DAMOCLES_E2E_RECONNECTION_GRACE_MS: String(2 ** 31 - 1) })).toEqual({ graceMs: 2 ** 31 - 1 });
    expect(() => e2eConnectionLimits({ DAMOCLES_E2E_RECONNECTION_GRACE_MS: String(2 ** 31) })).toThrow(/up to 2147483647/);
    expect(e2eConnectionLimits({ DAMOCLES_E2E_MAX_HELD_BYTES: String(2 ** 40) })).toEqual({ maxHeldBytes: 2 ** 40 });
  });
});
