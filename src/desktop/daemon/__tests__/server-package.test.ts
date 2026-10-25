import { describe, expect, it } from 'vitest';
import { daemonE2eHooks, SERVER_PACKAGE } from '../server-package';

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
