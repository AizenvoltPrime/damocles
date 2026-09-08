// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { CompactionAbortedNotice } from '@shared/types/session';
import VirtualizedMessageList from '../VirtualizedMessageList.vue';
import { i18n } from '@/i18n';

// `vue3-lottie` runs canvas setup at import time, which happy-dom does not provide.
vi.mock('vue3-lottie', () => ({ Vue3Lottie: { name: 'Vue3Lottie', render: () => null } }));

/**
 * A notice arrives with no message of its own, so the welcome screen has to yield to it. The list is
 * mounted with no scroll container, so nothing is measured and only the welcome branch is under test.
 */

function mountList(props: Record<string, unknown>) {
  return mount(VirtualizedMessageList, {
    props: { messages: [], ...props },
    global: { plugins: [createPinia(), i18n] },
  });
}

describe('the welcome screen against the transcript', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // happy-dom ships no font loading API, and the list measures text on mount.
    Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
  });

  it('shows the welcome screen when the session has nothing at all', () => {
    expect(mountList({}).text()).toContain('Welcome to Damocles');
  });

  it('yields to a compaction-aborted notice that arrived before any message', () => {
    const aborted: CompactionAbortedNotice = { id: '500-0', trigger: 'threshold', willRetry: true, timestamp: 500 };

    expect(mountList({ compactionAbortedNotices: [aborted] }).text()).not.toContain('Welcome to Damocles');
  });
});
