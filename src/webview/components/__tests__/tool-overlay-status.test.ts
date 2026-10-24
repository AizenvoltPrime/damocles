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
  pending: true, running: true, awaiting_approval: true, approved: true, denied: true, blocked: true,
  completed: true, failed: true, abandoned: true, cancelled: true, unrecorded: true,
};

const mounted: VueWrapper[] = [];

function open(overlay: Component, tool: ToolCall): VueWrapper {
  const wrapper = mount(overlay, {
    props: { tool },
    global: { plugins: [i18n], stubs: { LiveOutputPane: true, MarkdownRenderer: true, CodeBlock: true, ToolResultImages: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

function badge(overlay: Component, name: string, status: ToolCall['status']): string | undefined {
  return open(overlay, { id: 't-1', name, input: {}, status }).find('[data-testid="overlay-status"]').attributes('title');
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

describe.each([
  ['ToolOverlay', ToolOverlay as Component, 'Bash', en.toolOverlay],
  ['McpToolOverlay', McpToolOverlay as Component, 'mcp__db__query', en.mcpToolOverlay],
])('%s opened on a blocked call', (_label, overlay, name, text) => {
  const feedback = 'Start-Process starts in a computed directory, so it cannot be read.';
  const reason = (wrapper: VueWrapper) => wrapper.find('[data-testid="tool-overlay-blocked-reason"]');
  const hasResponse = (wrapper: VueWrapper) => wrapper.findAll('button[aria-expanded]').some((b) => b.text().includes(text.response));

  it('shows the block reason instead of the empty response', () => {
    const wrapper = open(overlay, { id: 't-1', name, input: {}, status: 'blocked', feedback });

    expect(reason(wrapper).text()).toBe(feedback);
    expect(wrapper.text()).not.toContain(text.noResponse);
  });

  it('shows the reason, not the refusal text as a response, for a call restored from history', () => {
    const result = `This tool call was blocked automatically and the user was not consulted. Blocked by Damocles policy: ${feedback}`;
    const wrapper = open(overlay, { id: 't-1', name, input: {}, status: 'blocked', feedback, result });

    expect(reason(wrapper).text()).toBe(feedback);
    expect(hasResponse(wrapper)).toBe(false);
  });

  it('falls back to the empty response for a blocked call without a reason', () => {
    const wrapper = open(overlay, { id: 't-1', name, input: {}, status: 'blocked' });

    expect(reason(wrapper).exists()).toBe(false);
    expect(wrapper.text()).toContain(text.noResponse);
  });

  it('keeps the empty response for a completed call with no output, and the response for one with output', () => {
    expect(open(overlay, { id: 't-1', name, input: {}, status: 'completed' }).text()).toContain(text.noResponse);
    const answered = open(overlay, { id: 't-2', name, input: {}, status: 'completed', result: 'ok' });
    expect(hasResponse(answered)).toBe(true);
    expect(reason(answered).exists()).toBe(false);
  });

  it('still shows a failed call\u2019s error message', () => {
    const wrapper = open(overlay, { id: 't-1', name, input: {}, status: 'failed', errorMessage: 'spawn ENOENT' });

    expect(wrapper.text()).toContain('spawn ENOENT');
    expect(reason(wrapper).exists()).toBe(false);
  });
});
