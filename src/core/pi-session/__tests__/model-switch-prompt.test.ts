import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { getCurrentSystemMessage, getSystemMessageText, type SystemMessage, type Tool } from '@earendil-works/pi-ai';
import { foldThroughModelSwitch, registerModelSwitchPromptFold } from '../model-switch-prompt';
import { log } from '../../logger';

vi.mock('../../logger', () => ({ log: vi.fn() }));

/** pi-ai's own replay, the one the production handler passes. */
const replay = (messages: readonly AgentMessage[]): SystemMessage | undefined => getCurrentSystemMessage(messages as Parameters<typeof getCurrentSystemMessage>[0]);

const tool = (name: string): Tool => ({ name, description: `${name} tool`, parameters: { type: 'object', properties: {} } as Tool['parameters'] });
const system = (sections: Record<string, string | null>, extra: Partial<SystemMessage> = {}, timestamp = 1): AgentMessage =>
  ({ role: 'system', content: '', sections, timestamp, ...extra }) as AgentMessage;
const user = (text: string): AgentMessage => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 2 }) as AgentMessage;

const HEAD = system({ preamble: 'p', damocles_environment: 'env', damocles_model: 'Opus', damocles_tone: 'tone' }, { toolsAdded: [tool('read')] });

describe('foldThroughModelSwitch', () => {
  it('folds a switch back to the first model into a head byte-identical to the original leading message', () => {
    const messages = [HEAD, user('one'), system({ damocles_model: 'Haiku' }), user('two'), system({ damocles_model: 'Opus' }), user('three')];

    const folded = foldThroughModelSwitch(messages, replay)!;

    const head = folded[0] as SystemMessage;
    expect(getSystemMessageText(head)).toBe(getSystemMessageText(HEAD as SystemMessage));
    // Section order decides the rendered bytes, which `toEqual` ignores.
    expect(Object.keys(head.sections ?? {})).toEqual(Object.keys((HEAD as SystemMessage).sections ?? {}));
    expect(JSON.stringify(head.toolsAdded)).toBe(JSON.stringify((HEAD as SystemMessage).toolsAdded));
    expect(folded.slice(1)).toEqual([user('one'), user('two'), user('three')]);
  });

  it('folds a tool change made before the switch into the head, and leaves one made after it in place', () => {
    const before = system({}, { toolsAdded: [tool('grep')] });
    const after = system({}, { toolsAdded: [tool('find')] });
    const messages = [HEAD, user('one'), before, user('two'), system({ damocles_model: 'Haiku' }), user('three'), after, user('four')];

    const folded = foldThroughModelSwitch(messages, replay)!;

    expect((folded[0] as SystemMessage).toolsAdded?.map((t) => t.name)).toEqual(['read', 'grep']);
    expect(folded.slice(1)).toEqual([user('one'), user('two'), user('three'), after, user('four')]);
  });

  it('does not fold at a removal of the model section, nor at its return with the text it held', () => {
    // pi writes a removal when a run's `before_agent_start` produced no Damocles prompt.
    const removal = system({ damocles_environment: null, damocles_model: null, damocles_tone: null });
    const restored = system({ damocles_environment: 'env', damocles_model: 'Opus', damocles_tone: 'tone' });

    expect(foldThroughModelSwitch([HEAD, user('one'), removal, user('two')], replay)).toBeUndefined();
    expect(foldThroughModelSwitch([HEAD, user('one'), removal, user('two'), restored, user('three')], replay)).toBeUndefined();
  });

  it('folds at the return of the model section when it names another model than the one it last held', () => {
    const removal = system({ damocles_model: null });
    const messages = [HEAD, user('one'), removal, user('two'), system({ damocles_model: 'Haiku' }), user('three')];

    const head = foldThroughModelSwitch(messages, replay)![0] as SystemMessage;

    expect(head.sections?.['damocles_model']).toBe('Haiku');
  });

  it('returns undefined when the transcript holds no switch', () => {
    expect(foldThroughModelSwitch([HEAD, user('one'), system({ damocles_output_form: 'off' }), user('two')], replay)).toBeUndefined();
  });
});

describe('the registered context_with_system handler', () => {
  it("returns no change, so pi sends its own transcript, when the fold throws", async () => {
    let handler: ((event: unknown) => Promise<unknown>) | undefined;
    registerModelSwitchPromptFold({ on: (_event: string, h: (event: unknown) => Promise<unknown>) => { handler = h; } } as never);
    const head = { ...(HEAD as SystemMessage) };
    // Only pi-ai's replay reads `content`, so the throw comes from inside the fold.
    Object.defineProperty(head, 'content', { get: () => { throw new Error('replay failed'); } });

    const result = await handler!({ type: 'context_with_system', messages: [head, user('one'), system({ damocles_model: 'Haiku' }), user('two')] });

    expect(result).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fold failed'), expect.any(Error));
  });
});
