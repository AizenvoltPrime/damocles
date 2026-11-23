// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ChatConnection } from '@shared/host-connection';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';
import { useDockCardVisibility } from '@/composables/useDockCardVisibility';
import { useConnectionStore } from '@/stores/useConnectionStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { installVisibilityObserver } from '@/__tests__/visibility-observer';

let wrapper: VueWrapper | null = null;
let push: (next: ChatConnection) => void = () => undefined;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  // only what the connection store reads of main's bridge
  window.damoclesBridge = {
    getConnection: () => undefined,
    onConnection: (listener: (next: ChatConnection) => void) => {
      push = listener;
      return () => undefined;
    },
  } as unknown as NonNullable<typeof window.damoclesBridge>;
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as { damoclesBridge?: unknown }).damoclesBridge;
});

function card(): VueWrapper {
  const Card = defineComponent({
    setup() {
      const root = ref<HTMLElement | null>(null);
      const { isVisible, explain } = useDockCardVisibility(root);
      return () => h('section', { ref: root, 'data-visible': String(isVisible.value), 'data-explain': String(explain.value) });
    },
  });
  wrapper = mount(Card, { attachTo: document.body });
  return wrapper;
}

describe('a card of the chat page\'s prompts', () => {
  it('is checked only where the host paints theme CSS', async () => {
    const visibility = installVisibilityObserver(false);
    useSettingsStore().setHostCapabilities(VSCODE_HOST_CAPABILITIES);
    const w = card();
    await nextTick();
    expect(visibility.observed()).toEqual([]);
    expect(w.attributes('data-visible')).toBe('true');

    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, damoclesTheme: true });
    await nextTick();
    expect(visibility.observed()).toEqual([w.element]);
    expect(w.attributes('data-visible')).toBe('false');
  });

  // The prompts are dimmed while the host is away, which the check reads as not visible; the page says why above them.
  it('is held without saying that it checks its visibility while its host is away', async () => {
    installVisibilityObserver(false);
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, damoclesTheme: true });
    const connection = useConnectionStore();
    connection.attach();
    push({ state: { phase: 'offline' }, queued: [] } as unknown as ChatConnection);
    expect(connection.awayShown).toBe(true);
    const w = card();
    await nextTick();
    vi.advanceTimersByTime(2000);
    await nextTick();
    expect(w.attributes('data-visible')).toBe('false');
    expect(w.attributes('data-explain')).toBe('false');

    push({ state: { phase: 'connected' }, queued: [] } as unknown as ChatConnection);
    await nextTick();
    expect(w.attributes('data-explain')).toBe('true');
  });
});
