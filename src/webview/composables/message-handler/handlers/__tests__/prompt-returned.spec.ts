import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { createUIHandlers } from '../ui-handlers';
import type { HandlerContext, StoreContext } from '../../types';
import { useUIStore } from '@/stores/useUIStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { defined } from '@/__tests__/helpers';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

const toastMock = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('vue-sonner', () => ({ toast: toastMock }));

const CONTENT = [{ type: 'text' as const, text: 'go' }];

type PromptReturned = Extract<ExtensionToWebviewMessage, { type: 'promptReturned' }>;

function returned(msg: Omit<PromptReturned, 'type' | 'content'> & Partial<Pick<PromptReturned, 'content'>>, restoreQueued = vi.fn()): void {
  const ctx = { stores: { uiStore: useUIStore(), streamingStore: useStreamingStore() } as unknown as StoreContext, refs: { chatInputRef: ref({ restoreQueued }) } } as unknown as HandlerContext;
  defined(createUIHandlers().promptReturned, 'promptReturned handler')({ type: 'promptReturned', content: CONTENT, ...msg }, ctx);
}

describe('promptReturned for a prompt pi refused before storing it', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    toastMock.info.mockClear();
  });

  it('takes its echo out of the transcript and puts it back in the composer', () => {
    const store = useStreamingStore();
    store.addUserMessage('earlier', false, undefined, undefined, 'c0', 0);
    store.addUserMessage(CONTENT, false, undefined, undefined, 'c1', 1);
    const restoreQueued = vi.fn();

    returned({ reason: 'promptRejected', correlationId: 'c1' }, restoreQueued);

    expect(store.messages.map((m) => m.correlationId)).toEqual(['c0']);
    expect(restoreQueued).toHaveBeenCalledWith(CONTENT);
    expect(toastMock.info).toHaveBeenCalledWith('Your message could not be sent, so it is back in the input. The chat says why.');
  });

  it('takes the echo out even when nothing comes back to the composer', () => {
    const store = useStreamingStore();
    store.addUserMessage('earlier', false, undefined, undefined, 'c0', 0);
    store.addUserMessage(CONTENT, false, undefined, undefined, 'c1', 1);
    const restoreQueued = vi.fn();

    returned({ reason: 'promptRejected', correlationId: 'c1', content: [] }, restoreQueued);

    expect(store.messages.map((m) => m.correlationId)).toEqual(['c0']);
    expect(restoreQueued).not.toHaveBeenCalled();
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it('names the provider to sign in to when the card names its account', () => {
    returned({ reason: 'promptRejected', correlationId: 'c1', account: 'deepseek' });

    expect(toastMock.info).toHaveBeenCalledWith("Sign in to DeepSeek to send messages with this chat's model. Your message is back in the input.");
  });
});

describe('promptReturned toast for a model the chat cannot run', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    toastMock.info.mockClear();
  });

  it('tells the user to sign in to the provider whose row settings open at, with the reason below', () => {
    returned({ reason: 'modelUnavailable', detail: 'Sign in to DeepSeek to use DeepSeek V4 Pro', account: 'deepseek' });

    expect(toastMock.info).toHaveBeenCalledWith(
      "Sign in to DeepSeek to send messages with this chat's model. Your message is back in the input.",
      { description: 'Sign in to DeepSeek to use DeepSeek V4 Pro' },
    );
  });

  it('names the provider when nothing can run but one sign-in would let the chat run its model', () => {
    returned({ reason: 'modelSignInRequired', account: 'anthropic' });

    expect(toastMock.info).toHaveBeenCalledWith("Sign in to Anthropic to send messages with this chat's model. Your message is back in the input.");
  });

  it('asks for a pick in This chat only when no sign-in fixes it', () => {
    returned({ reason: 'modelUnavailable', detail: 'Your GitHub Copilot plan does not include Opus 5.5 (GitHub Copilot)' });

    expect(toastMock.info).toHaveBeenCalledWith('Pick a model this chat can run. Your message is back in the input.', {
      description: 'Your GitHub Copilot plan does not include Opus 5.5 (GitHub Copilot)',
    });
  });

  it('keeps the general sign-in title when no provider is named', () => {
    returned({ reason: 'modelSignInRequired' });

    expect(toastMock.info).toHaveBeenCalledWith('Sign in to a model provider in Models & accounts to send messages. Your message is back in the input.');
  });
});
