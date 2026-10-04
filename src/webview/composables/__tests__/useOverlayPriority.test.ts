// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { h, markRaw } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import BindPlanOverlay from '@/components/BindPlanOverlay.vue';
import OverlayShell from '@/components/OverlayShell.vue';
import { useBindPlanStore } from '@/stores/useBindPlanStore';
import { usePromptNavigatorStore } from '@/stores/usePromptNavigatorStore';
import { usePermissionStore } from '@/stores';
import { createNavigatorHandlers } from '@/composables/message-handler/handlers/navigator-handlers';
import { isForegroundOverlayOpen } from '../useOverlayPriority';
import { i18n } from '@/i18n';

vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: () => {}, onMessage: () => () => {}, getState: () => undefined, setState: () => {} }),
}));

const StubIcon = markRaw({ render: () => h('span') });
const mounted: VueWrapper[] = [];

function toggleNavigator(): void {
  const navigatorStore = usePromptNavigatorStore();
  createNavigatorHandlers().togglePromptNavigator!({ type: 'togglePromptNavigator' }, { stores: { promptNavigatorStore: navigatorStore } } as never);
}

/** Stands in for the mounted navigator, which is an `OverlayShell` like every full overlay. */
function mountNavigatorShell(): VueWrapper {
  const wrapper = mount(OverlayShell, { props: { title: 'Prompt navigator', icon: StubIcon }, global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = '';
});

describe('the prompt navigator toggle and the foreground overlays', () => {
  it('does not open the navigator over the bind-plan overlay, which no list names', () => {
    useBindPlanStore().open();
    mounted.push(mount(BindPlanOverlay, { global: { plugins: [i18n] }, attachTo: document.body }));

    toggleNavigator();

    expect(isForegroundOverlayOpen()).toBe(true);
    expect(usePromptNavigatorStore().isOpen).toBe(false);
  });

  it('opens with nothing in the foreground, and closes again from its own toggle', () => {
    toggleNavigator();
    expect(usePromptNavigatorStore().isOpen).toBe(true);
    mountNavigatorShell();

    expect(isForegroundOverlayOpen()).toBe(false);
    toggleNavigator();
    expect(usePromptNavigatorStore().isOpen).toBe(false);
  });

  it('leaves an open navigator alone while an overlay sits above it', () => {
    toggleNavigator();
    mountNavigatorShell();
    mountNavigatorShell();

    toggleNavigator();

    expect(usePromptNavigatorStore().isOpen).toBe(true);
  });

  it('does not open over a prompt docked in the composer, which is outside the overlay stack', () => {
    usePermissionStore().addPermission('t', { toolName: 'Bash', input: {} } as never);

    toggleNavigator();

    expect(usePromptNavigatorStore().isOpen).toBe(false);
  });
});
