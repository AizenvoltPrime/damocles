import { afterEach, describe, expect, it } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { installPlatform } from '../../platform-host';
import { PiSession } from '../pi-session';

afterEach(() => installPlatform(createFakePlatform()));

describe('a chat\'s shell environment', () => {
  it('names the agent socket of the chat\'s own host, whatever platform the process installed', () => {
    // the process-wide platform is a local core's, with no remote host
    installPlatform(createFakePlatform());
    const host = createFakeRemoteHost();
    host.setAgentFolder('/run/agents');
    host.set('clientPolicy', 'client-a', { voice: false, allowBypass: false, agentForwarding: true });
    const session = Object.create(PiSession.prototype) as PiSession;
    Object.assign(session, {
      folder: undefined,
      worktree: { shellEnvironment: () => undefined },
      options: { platform: { ...createFakePlatform(), remote: host.remote } },
    });
    const options = (session as unknown as { shellOptions(): { env?: Record<string, string | undefined> } }).shellOptions();
    expect(options.env?.['SSH_AUTH_SOCK']).toBe('/run/agents/agent-of-client-a.sock');
  });
});
