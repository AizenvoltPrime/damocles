import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { repin, runPin, runPinnedTurn } from '../../client-snapshots';
import { recordCredentialSources } from '../credential-broker';

const HOUR = 60 * 60 * 1000;

describe('the credential source of a turn Continue with my sign-in moved', () => {
  it('records the new device\'s providers before the reply it billed', async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const recorded: unknown[] = [];
    const session = {
      subscribe: (listener: (event: unknown) => void) => listeners.push(listener),
      sessionManager: { appendCustomEntry: (_type: string, data: unknown) => recorded.push(data) },
    } as unknown as AgentSession;
    const emit = (event: unknown): void => listeners.forEach((listener) => listener(event));
    const host = createFakeRemoteHost();
    host.set('clientAuth', 'client-a', { providers: { anthropic: { type: 'oauth', expires: Date.now() + HOUR, hasKey: false, flatFee: false } } });
    host.set('clientAuth', 'client-c', { providers: { openai: { type: 'api_key', hasKey: true, flatFee: false } } });
    host.setActing('client-a');
    recordCredentialSources(session, host.remote);
    await runPinnedTurn(host.remote, 'panel-1', async () => {
      emit({ type: 'agent_start' });
      emit({ type: 'message_start', message: { role: 'assistant' } });
      // the turn waited behind Sign-in needed, and device c clicked Continue with my sign-in
      repin(runPin()!, 'client-c');
      emit({ type: 'message_start', message: { role: 'user' } });
      emit({ type: 'message_start', message: { role: 'assistant' } });
    });
    expect(recorded).toEqual([{ clientProviders: ['anthropic'] }, { clientProviders: ['openai'] }]);
  });
});
