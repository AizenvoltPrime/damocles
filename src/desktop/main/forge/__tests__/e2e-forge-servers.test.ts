import { describe, expect, it } from 'vitest';
import { forgeE2eServers } from '../e2e-forge-servers';

const STUB = JSON.stringify({
  'github.com': { webUrl: 'https://127.0.0.1:4001', apiUrl: 'https://127.0.0.1:4001/api/v3', oauth: { clientId: 'Ov23stub', clientSecret: 'stub-secret' } },
  'gitlab.com': { webUrl: 'https://127.0.0.1:4002', oauth: { clientId: 'stub-gitlab' } },
});

describe('DAMOCLES_E2E_FORGE_SERVERS', () => {
  it('is read only by a development build run with DAMOCLES_E2E_HOOKS=1', () => {
    expect(forgeE2eServers({ packaged: true, env: { DAMOCLES_E2E_HOOKS: '1', DAMOCLES_E2E_FORGE_SERVERS: STUB } })).toBeUndefined();
    expect(() => forgeE2eServers({ packaged: false, env: { DAMOCLES_E2E_FORGE_SERVERS: STUB } })).toThrow(/needs DAMOCLES_E2E_HOOKS=1/);
    expect(forgeE2eServers({ packaged: false, env: { DAMOCLES_E2E_HOOKS: '1' } })).toBeUndefined();
    expect(forgeE2eServers({ packaged: false, env: { DAMOCLES_E2E_HOOKS: '1', DAMOCLES_E2E_FORGE_SERVERS: STUB } })).toEqual({
      'github.com': { webUrl: 'https://127.0.0.1:4001', apiUrl: 'https://127.0.0.1:4001/api/v3', oauth: { clientId: 'Ov23stub', clientSecret: 'stub-secret' } },
      'gitlab.com': { webUrl: 'https://127.0.0.1:4002', oauth: { clientId: 'stub-gitlab' } },
    });
  });

  it('fails on a server that is not built in, a non-https URL or a malformed client', () => {
    const env = (value: unknown) => ({ packaged: false, env: { DAMOCLES_E2E_HOOKS: '1', DAMOCLES_E2E_FORGE_SERVERS: JSON.stringify(value) } });
    expect(() => forgeE2eServers(env({ 'gitlab.indigital.gr': { webUrl: 'https://127.0.0.1:1' } }))).toThrow(/not a built-in/);
    expect(() => forgeE2eServers(env({ 'github.com': { webUrl: 'http://127.0.0.1:1' } }))).toThrow(/https/);
    expect(() => forgeE2eServers(env({ 'github.com': { webUrl: 'https://127.0.0.1:1', oauth: { clientId: 'bad id' } } }))).toThrow(/malformed/);
    expect(() => forgeE2eServers({ packaged: false, env: { DAMOCLES_E2E_HOOKS: '1', DAMOCLES_E2E_FORGE_SERVERS: '[1]' } })).toThrow(/JSON object/);
  });
});
