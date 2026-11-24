// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { inject } from 'vue';
import { createChatApp } from '@/chat-app';
import { CODE_HIGHLIGHTER } from '@/composables/code-highlighter';
import { SHIKI_HIGHLIGHTER } from '@/composables/useShikiHighlighter';
import { CHAT_VIEW_PROVIDE } from './code-highlighter';

describe('the chat view\'s app', () => {
  it('provides every component the highlighter the tests\' CHAT_VIEW_PROVIDE stands in for', () => {
    const provided = createChatApp().runWithContext(() => inject(CODE_HIGHLIGHTER));
    expect(provided).toBe(SHIKI_HIGHLIGHTER);
    expect(provided).toBe(CHAT_VIEW_PROVIDE[CODE_HIGHLIGHTER as symbol]);
  });
});
