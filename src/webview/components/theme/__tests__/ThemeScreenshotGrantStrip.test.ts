// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ChatConnection } from '@shared/host-connection';
import ThemeScreenshotGrantStrip from '@/components/theme/ThemeScreenshotGrantStrip.vue';
import { i18n, loadLocale } from '@/i18n';
import { useConnectionStore } from '@/stores/useConnectionStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';
import { installVisibilityObserver } from '@/__tests__/visibility-observer';

const posted = vi.hoisted(() => [] as unknown[]);
vi.mock('@/composables/usePlatformBridge', () => ({ usePlatformBridge: () => ({ postMessage: (message: unknown) => void posted.push(message) }) }));

const CHECKING = 'This card must be fully visible before you can answer. Scroll it into view or move what covers it.';

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  posted.length = 0;
  i18n.global.locale.value = 'en';
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  i18n.global.locale.value = 'en';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as { damoclesBridge?: unknown }).damoclesBridge;
});

async function shown(): Promise<VueWrapper> {
  wrapper = mount(ThemeScreenshotGrantStrip, { global: { plugins: [i18n] }, attachTo: document.body });
  await nextTick();
  return wrapper;
}

// Past the wait before a strip that stays covered says why (useTrustedVisibility's EXPLAIN_AFTER_MS).
async function pastTheExplainWait(): Promise<void> {
  vi.advanceTimersByTime(600);
  await nextTick();
}

const revoke = (w: VueWrapper) => w.get('[data-testid="theme-screenshot-grant-revoke"]');
const status = (w: VueWrapper) => w.get('[data-testid="theme-screenshot-grant-status"]');

describe('the screenshot grant strip', () => {
  it('says what the chat may do without asking, as trusted UI, and revokes once', async () => {
    const w = await shown();
    const strip = w.get('[data-testid="theme-screenshot-grant"]');
    expect(strip.attributes('data-trusted')).toBeDefined();
    expect(strip.element.parentElement!.hasAttribute('data-trusted')).toBe(true);
    expect(strip.get('p').text().replace(/\s+/g, ' ')).toBe('Screenshots allowed for this chat. Screenshots of this window go to the model without asking, and a draft may show on it for a moment.');
    expect(revoke(w).attributes('aria-describedby')).toBe('theme-screenshot-grant-body');
    expect(status(w).attributes('role')).toBe('status');
    expect(status(w).text()).toBe('');

    await revoke(w).trigger('click');
    await revoke(w).trigger('click');
    expect(posted).toEqual([{ type: 'revokeThemeScreenshotGrant' }]);
    expect(revoke(w).text()).toBe('Revoking…');
    expect(revoke(w).attributes('aria-disabled')).toBe('true');
    expect(status(w).text()).toBe('Revoking…');
  });

  it('lets its text be scrolled from the keyboard, as a named region', async () => {
    const w = await shown();
    const text = w.get('[data-testid="theme-screenshot-grant-text"]');
    expect(text.attributes('role')).toBe('region');
    expect(text.attributes('aria-label')).toBe('About the screenshot grant');
    expect(text.attributes('tabindex')).toBe('0');
    expect(text.find('p').exists()).toBe(true);
  });

  it('takes no Revoke while it is not fully visible, and says why', async () => {
    const visibility = installVisibilityObserver(false);
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, damoclesTheme: true });
    const w = await shown();
    expect(w.find('[data-testid="trusted-checking"]').exists()).toBe(false);
    await pastTheExplainWait();
    expect(revoke(w).attributes('aria-disabled')).toBe('true');
    await revoke(w).trigger('click');
    expect(posted).toEqual([]);
    expect(w.get('[data-testid="trusted-checking"]').text()).toBe(CHECKING);
    expect(revoke(w).attributes('aria-describedby')).toBe('theme-screenshot-grant-checking');
    expect(w.get('#theme-screenshot-grant-checking').text()).toBe(CHECKING);

    visibility.report(true);
    await nextTick();
    expect(revoke(w).attributes('aria-describedby')).toBe('theme-screenshot-grant-body');
    await revoke(w).trigger('click');
    expect(posted).toEqual([{ type: 'revokeThemeScreenshotGrant' }]);
  });

  // The strip sits outside the dimmed prompts, so nothing else on the page explains a held Revoke while the host is away.
  it('says why Revoke is held while its host is away too', async () => {
    let push: (next: ChatConnection) => void = () => undefined;
    // only what the connection store reads of main's bridge
    window.damoclesBridge = {
      getConnection: () => undefined,
      onConnection: (listener: (next: ChatConnection) => void) => {
        push = listener;
        return () => undefined;
      },
    } as unknown as NonNullable<typeof window.damoclesBridge>;
    installVisibilityObserver(false);
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, damoclesTheme: true });
    const connection = useConnectionStore();
    connection.attach();
    push({ state: { phase: 'offline' }, queued: [] } as unknown as ChatConnection);
    expect(connection.awayShown).toBe(true);

    const w = await shown();
    await pastTheExplainWait();
    expect(revoke(w).attributes('aria-disabled')).toBe('true');
    expect(w.get('[data-testid="trusted-checking"]').text()).toBe(CHECKING);
  });

  it('hands focus on when it leaves while it holds focus, and not otherwise', async () => {
    const granted = ref(true);
    const released = vi.fn();
    // as the page shows it: only while the chat holds the grant
    const Page = defineComponent({ setup: () => () => (granted.value ? h(ThemeScreenshotGrantStrip, { onReleaseFocus: released }) : null) });
    wrapper = mount(Page, { global: { plugins: [i18n] }, attachTo: document.body });
    await nextTick();
    await revoke(wrapper).trigger('click');
    (revoke(wrapper).element as HTMLElement).focus();
    granted.value = false;
    await nextTick();
    expect(wrapper.find('[data-testid="theme-screenshot-grant"]').exists()).toBe(false);
    expect(released).toHaveBeenCalledTimes(1);

    granted.value = true;
    await nextTick();
    expect(wrapper.find('[data-testid="theme-screenshot-grant"]').exists()).toBe(true);
    granted.value = false;
    await nextTick();
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('speaks Greek in the el locale', async () => {
    expect(await loadLocale('el')).toBe(true);
    i18n.global.locale.value = 'el';
    const w = await shown();
    expect(w.text()).toContain('Τα στιγμιότυπα επιτρέπονται σε αυτή τη συνομιλία.');
    expect(w.text()).toContain('χωρίς να σας ρωτά');
    expect(revoke(w).text()).toBe('Ανάκληση');
  });
});
