import { describe, expect, it } from 'vitest';
import { e2eForgeOverrides } from '../forge';

describe('core forge', () => {
  const servers = { 'github.com': { webUrl: 'https://127.0.0.1:4443' } };

  it('points the built-in servers at the forge stub only with the e2e hooks on', () => {
    expect(e2eForgeOverrides({ e2eHooks: true, e2eForgeServers: servers })).toBe(servers);
    expect(e2eForgeOverrides({ e2eHooks: false, e2eForgeServers: servers })).toBeUndefined();
  });
});
