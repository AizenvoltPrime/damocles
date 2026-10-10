// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { Component } from 'vue';
import type { ToolCall } from '@shared/types/session';
import ToolOverlay from '../ToolOverlay.vue';
import McpToolOverlay from '../McpToolOverlay.vue';
import { i18n } from '@/i18n';
import en from '@/i18n/locales/en.json';

vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: () => {}, onMessage: () => () => {}, getState: () => undefined, setState: () => {} }),
}));

const STATUSES: Record<ToolCall['status'], true> = {
  pending: true, running: true, awaiting_approval: true, approved: true, denied: true,
  completed: true, failed: true, abandoned: true, cancelled: true, unrecorded: true,
};

const mounted: VueWrapper[] = [];

function badge(overlay: Component, name: string, status: ToolCall['status']): string | undefined {
  const wrapper = mount(overlay, {
    props: { tool: { id: 't-1', name, input: {}, status } },
    global: { plugins: [i18n], stubs: { LiveOutputPane: true, MarkdownRenderer: true, CodeBlock: true, ToolResultImages: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper.find('[data-testid="overlay-status"]').attributes('title');
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  i18n.global.locale.value = 'en';
});

describe.each([
  ['ToolOverlay', ToolOverlay as Component, 'Bash'],
  ['McpToolOverlay', McpToolOverlay as Component, 'mcp__db__query'],
])('%s status badge', (_label, overlay, name) => {
  it.each(Object.keys(STATUSES) as Array<ToolCall['status']>)('labels %s in English and Greek, never with the raw status', (status) => {
    const english = badge(overlay, name, status);
    i18n.global.locale.value = 'el';
    const greek = badge(overlay, name, status);

    expect(english).toBeTruthy();
    expect(english).not.toBe(status);
    expect(greek).toBeTruthy();
    expect(greek).not.toBe(english);
  });

  it('labels a call that never ran as the card does', () => {
    expect(badge(overlay, name, 'abandoned')).toBe(en.toolCall.notExecuted);
  });
});
