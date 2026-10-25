import { describe, expect, it } from 'vitest';
import { HiddenOpening } from '../hidden-opening';

interface Chat {
  readonly panelId: string;
}

// a view's id differs from the panel id core answers it by
const coreIdOf = (chat: Chat): string => `core-${chat.panelId}`;

describe('HiddenOpening', () => {
  it('keeps hidden only the local chat the opening answers, and shows every other chat opened meanwhile', async () => {
    const opening = new HiddenOpening<Chat>(coreIdOf);
    const shown: string[] = [];
    const fork: Chat = { panelId: 'fork' };
    const remote: Chat = { panelId: 'remote' };
    const target: Chat = { panelId: 'target' };
    const result = await opening.run(async () => {
      expect(opening.hold(fork, true)).toBe(true);
      expect(opening.hold(remote, false)).toBe(false);
      expect(opening.hold(target, true)).toBe(true);
      expect(opening.holds(target)).toBe(true);
      return 'core-target';
    }, (chat) => shown.push(chat.panelId));
    expect(result).toEqual({ panelId: 'core-target', chat: target });
    expect(shown).toEqual(['fork']);
    expect(opening.holds(target)).toBe(false);
    expect(opening.hold({ panelId: 'later' }, true)).toBe(false);
  });

  it('shows every chat it held when the opening fails', async () => {
    const opening = new HiddenOpening<Chat>(coreIdOf);
    const shown: string[] = [];
    await expect(opening.run(async () => {
      opening.hold({ panelId: 'a' }, true);
      throw new Error('closed');
    }, (chat) => shown.push(chat.panelId))).rejects.toThrow('closed');
    expect(shown).toEqual(['a']);
  });
});
