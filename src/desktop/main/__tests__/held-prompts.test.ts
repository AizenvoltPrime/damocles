import { describe, expect, it } from 'vitest';
import type { UserContentBlock } from '../../../shared/types/content';
import { HeldPrompts } from '../held-prompts';

const PROMPT: UserContentBlock[] = [{ type: 'text', text: 'Fix the login' }];

function setup() {
  const stored = new Map<string, readonly UserContentBlock[] | undefined>();
  const core = new Map<string, readonly UserContentBlock[]>();
  const chats = [{ panelId: 'a', corePanelId: 'core-a' as string | undefined }, { panelId: 'b', corePanelId: undefined as string | undefined }];
  const prompts = new HeldPrompts({
    chats: () => chats,
    held: (corePanelId) => core.get(corePanelId),
    store: { setHeldPrompt: (panelId, held) => stored.set(panelId, held) },
  });
  return { stored, core, chats, prompts };
}

describe('HeldPrompts', () => {
  it('keeps the prompt core holds for each chat, and clears one core no longer holds', () => {
    const { stored, core, prompts } = setup();
    core.set('core-a', PROMPT);
    prompts.keep();
    expect(stored.get('a')).toEqual(PROMPT);
    core.delete('core-a');
    prompts.keep();
    expect(stored.get('a')).toBeUndefined();
  });

  it('leaves a kept prompt stored while its chat is putting it back, then forgets it once it is in the composer', () => {
    const { stored, chats, prompts } = setup();
    stored.set('b', PROMPT);
    prompts.restoring('b');
    // a reload or quit before the chat restored holds nothing in core yet
    prompts.keep();
    expect(stored.get('b')).toEqual(PROMPT);
    chats[1] = { panelId: 'b', corePanelId: 'core-b' };
    prompts.keep();
    expect(stored.get('b')).toEqual(PROMPT);
    prompts.restored('b');
    expect(stored.get('b')).toBeUndefined();
    prompts.keep();
    expect(stored.get('b')).toBeUndefined();
  });
});
