import { describe, expect, it } from 'vitest';
import { chatActions, refusesMirrored } from '../chat-actions';
import { NEW_CHAT_ID_PREFIX } from '../../preload/shell-channels';

describe('chatActions', () => {
  it('offers a mirrored chat of a host with no connection nothing besides Open', () => {
    expect(chatActions('11111111-2222-4333-8444-555555555555', true)).toEqual([]);
    expect(chatActions(`${NEW_CHAT_ID_PREFIX}panel-1`, true)).toEqual([]);
  });

  it('offers a saved chat rename, tag and delete, and a chat with no session file only delete', () => {
    expect(chatActions('11111111-2222-4333-8444-555555555555', false)).toEqual(['rename', 'tag', 'delete']);
    expect(chatActions(`${NEW_CHAT_ID_PREFIX}panel-1`, false)).toEqual(['delete']);
  });
});

describe('refusesMirrored', () => {
  const guard = () => {
    const errors: string[] = [];
    const deps = {
      mirrored: (authority: string) => authority === 'ssh+h1',
      hostName: (authority: string) => (authority === 'ssh+h1' ? 'prod-1' : 'other'),
      t: (message: string, ...args: string[]) => message.replace('{0}', args[0] ?? ''),
      error: (message: string) => void errors.push(message),
    };
    return { errors, refuses: (authority: string) => refusesMirrored(deps, authority) };
  };

  it('refuses a change on a host with no connection and tells the user which host', () => {
    const { errors, refuses } = guard();
    expect(refuses('ssh+h1')).toBe(true);
    expect(errors).toEqual(['prod-1 is not connected, so its chats are read-only until it connects.']);
  });

  it('lets a change through on a connected host or this computer, silently', () => {
    const { errors, refuses } = guard();
    expect(refuses('ssh+h2')).toBe(false);
    expect(refuses('local')).toBe(false);
    expect(errors).toEqual([]);
  });
});
