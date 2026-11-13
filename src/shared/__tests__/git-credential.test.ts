import { describe, expect, it } from 'vitest';
import { parseCredentialOrigin } from '../git-credential';

describe('an agent shell origin as it crosses a process boundary', () => {
  it('keeps its tool call and pinned client when given, and reads as before without them', () => {
    expect(parseCredentialOrigin({ kind: 'agentShell', panelId: 'p1', sessionId: 's1', toolCallId: 'call-1', clientId: 'client-a' })).toEqual({ kind: 'agentShell', panelId: 'p1', sessionId: 's1', toolCallId: 'call-1', clientId: 'client-a' });
    expect(parseCredentialOrigin({ kind: 'agentShell', panelId: 'p1', sessionId: 's1' })).toEqual({ kind: 'agentShell', panelId: 'p1', sessionId: 's1' });
  });

  it('refuses a tool call or client that is no id, and any other field', () => {
    expect(parseCredentialOrigin({ kind: 'agentShell', panelId: 'p1', sessionId: 's1', toolCallId: '' })).toBeUndefined();
    expect(parseCredentialOrigin({ kind: 'agentShell', panelId: 'p1', sessionId: 's1', clientId: 'a\nb' })).toBeUndefined();
    expect(parseCredentialOrigin({ kind: 'agentShell', panelId: 'p1', sessionId: 's1', clientId: 7 })).toBeUndefined();
    expect(parseCredentialOrigin({ kind: 'agentShell', panelId: 'p1', sessionId: 's1', projectKey: '/w' })).toBeUndefined();
  });
});
