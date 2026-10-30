// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import App from '@/App.vue';
import { WITTY_PHRASES } from '@/data/wittyPhrases';
import { i18n } from '@/i18n';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useUIStore } from '@/stores/useUIStore';

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

let app: VueWrapper | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  app?.unmount();
  app = null;
  vi.useRealTimers();
});

// A page that loaded again mid-turn has its cards rebuilt by the replay and the turn's elapsed time from core's snapshot,
// and none of the live events a watching page saw.
describe('the status bar of a page that rebuilt a running turn', () => {
  it('names the running card and counts from the turn start core gave', async () => {
    app = mount(App, { global: { plugins: [i18n] } });
    const streaming = useStreamingStore();
    streaming.addToolCall({ id: 'b1', name: 'Bash', input: { command: 'npm test' } });
    streaming.updateToolStatus('b1', 'running');
    useUIStore().setProcessing(true, 30_000);
    await nextTick();

    expect(app.get('[data-testid="status-label"]').text()).toContain('Running Bash');
    expect(app.get('[data-testid="status-elapsed"]').text()).toBe('30s');

    streaming.updateToolStatus('b1', 'completed', { result: 'ok' });
    await nextTick();
    // a random witty phrase takes its place, and some of those start with "Running"
    const label = app.get('[data-testid="status-label"]').text();
    expect(label).not.toContain('Bash');
    expect(WITTY_PHRASES.some((phrase) => label.startsWith(phrase))).toBe(true);
  });
});
