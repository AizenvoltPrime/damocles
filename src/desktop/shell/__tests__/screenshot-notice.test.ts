// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import ScreenshotNotice from '../components/ScreenshotNotice.vue';
import App from '../App.vue';
import { loadShellLocale, shellI18n } from '../i18n';
import type { ShellScreenshotNotice, ShellState } from '../../preload/shell-channels';
import { FakeResizeObserver, STATE, fakeShellApi } from './fakes';
import { installVisibilityObserver, type FakeVisibility } from '../../../webview/__tests__/visibility-observer';

// the half second a trusted surface is held after it shows, or shows another request, which the setup skips elsewhere
vi.unmock('@/composables/trusted-hold');

const mounted: VueWrapper[] = [];
let visibility: FakeVisibility;
beforeEach(() => {
  vi.useFakeTimers();
  shellI18n.global.locale.value = 'en';
  visibility = installVisibilityObserver();
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  shellI18n.global.locale.value = 'en';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const LOCAL: ShellScreenshotNotice = { id: 'sn-1', chat: 'Warmer sidebar', origin: 'local' };

function notice(given: Partial<ShellScreenshotNotice> = {}): VueWrapper {
  const wrapper = mount(ScreenshotNotice, { props: { notice: { ...LOCAL, ...given } }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

// past the hold of a newly shown trusted surface
const settle = async (): Promise<void> => {
  vi.advanceTimersByTime(600);
  await flushPromises();
};

const root = (w: VueWrapper) => w.get('[data-testid="screenshot-notice"]');
const live = (w: VueWrapper): string => w.get('[data-testid="screenshot-notice-live"]').text();
const SPOKEN = 'Screenshot taken. “Warmer sidebar” took a screenshot of this window for the model, as you allowed for that chat.';

describe('the screenshot notice', () => {
  it('names the granting chat as a trusted, labelled region, and speaks once its live region is in the page', async () => {
    const w = notice();
    expect(root(w).attributes('data-trusted')).toBeDefined();
    expect(root(w).attributes('role')).toBe('region');
    expect(root(w).attributes('aria-labelledby')).toBe('screenshot-notice-title');
    expect(w.get('#screenshot-notice-title').text()).toBe('Screenshot taken.');
    expect(w.get('[data-testid="screenshot-notice-body"]').text()).toBe('“Warmer sidebar” took a screenshot of this window for the model, as you allowed for that chat.');
    expect(w.find('[data-testid="screenshot-notice-host"]').exists()).toBe(false);
    const region = w.get('[data-testid="screenshot-notice-live"]');
    expect(region.attributes('role')).toBe('status');
    expect(region.attributes('aria-live')).toBe('polite');
    expect(live(w)).toBe('');

    vi.advanceTimersByTime(250);
    await nextTick();
    expect(live(w)).toBe(SPOKEN);
  });

  // browse mode would read the notice a second time from a live region that kept its text
  it('empties its live region once spoken, speaks a language change while it speaks, and speaks again only for another chat', async () => {
    const w = notice();
    vi.advanceTimersByTime(250);
    await nextTick();
    expect(await loadShellLocale('el')).toBe(true);
    shellI18n.global.locale.value = 'el';
    await nextTick();
    expect(live(w)).toBe('Τραβήχτηκε στιγμιότυπο. Η συνομιλία «Warmer sidebar» τράβηξε στιγμιότυπο αυτού του παραθύρου για το μοντέλο, όπως επιτρέψατε για εκείνη τη συνομιλία.');
    shellI18n.global.locale.value = 'en';
    vi.advanceTimersByTime(4_000);
    await nextTick();
    expect(live(w)).toBe('');

    // a newer capture of the same chat keeps the id and says nothing new
    await w.setProps({ notice: { ...LOCAL } });
    vi.advanceTimersByTime(250);
    await nextTick();
    expect(live(w)).toBe('');
    await w.setProps({ notice: { ...LOCAL, id: 'sn-2', chat: 'Docs' } });
    vi.advanceTimersByTime(250);
    await nextTick();
    expect(live(w)).toBe('Screenshot taken. “Docs” took a screenshot of this window for the model, as you allowed for that chat.');
  });

  it('isolates a right-to-left chat title, and says "a chat" for an untitled one', async () => {
    const chat = 'צבעים 2';
    const w = notice({ chat });
    expect(w.get('[data-testid="screenshot-notice-body"]').findAll('bdi').map((run) => run.text())).toEqual([chat]);
    vi.advanceTimersByTime(250);
    await nextTick();
    expect(live(w)).not.toMatch(/[\u2066-\u2069]/);

    const untitled = notice({ chat: '' });
    expect(untitled.get('[data-testid="screenshot-notice-body"]').text()).toBe('A chat took a screenshot of this window for the model, as you allowed for that chat.');
  });

  it("shows a remote chat's host as this computer's host store names it, with its badge", () => {
    const w = notice({ origin: 'ssh+h1', host: { name: 'prod-1', color: 'danger' } });
    const badge = w.get('[data-testid="screenshot-notice-host"]');
    expect(badge.text()).toBe('prod-1');
    expect(badge.attributes('data-trusted-mark')).toBeDefined();
    expect(w.get('[data-testid="screenshot-notice-body"]').text()).toBe('“Warmer sidebar” on prod-1 took a screenshot of this window for the model, as you allowed for that chat.');
    expect(w.get('[data-testid="screenshot-notice-body"]').findAll('bdi').map((run) => run.text())).toEqual(['Warmer sidebar', 'prod-1']);
    const untitled = notice({ chat: '', origin: 'ssh+h1', host: { name: 'prod-1' } });
    expect(untitled.get('[data-testid="screenshot-notice-body"]').text()).toBe('A chat on prod-1 took a screenshot of this window for the model, as you allowed for that chat.');
  });

  it('revokes only while it is fully visible, and dismisses whenever asked, each naming its notice', async () => {
    visibility.report(false);
    const w = notice();
    await settle();
    const revoke = w.get('[data-testid="screenshot-notice-revoke"]');
    expect(revoke.attributes('aria-disabled')).toBe('true');
    await revoke.trigger('click');
    expect(w.emitted('revoke')).toBeUndefined();
    await w.get('[data-testid="screenshot-notice-dismiss"]').trigger('click');
    expect(w.emitted('dismiss')).toEqual([['sn-1']]);
    expect(w.get('[data-testid="trusted-checking"]').text()).toBe('This card must be fully visible before you can answer. Scroll it into view or move what covers it.');

    visibility.report(true);
    await flushPromises();
    expect(revoke.attributes('aria-disabled')).toBeUndefined();
    await revoke.trigger('click');
    expect(w.emitted('revoke')).toEqual([['sn-1']]);
  });

  // Revoke now names another chat's grant, so a click meant for the one before must not land on it
  it("holds Revoke again when another chat's notice replaces it in place, and not for the same chat's", async () => {
    const w = notice();
    await settle();
    const element = root(w).element;
    const revoke = w.get('[data-testid="screenshot-notice-revoke"]');
    expect(revoke.attributes('aria-disabled')).toBeUndefined();
    await w.setProps({ notice: { ...LOCAL, chat: 'Warmest sidebar' } });
    expect(revoke.attributes('aria-disabled')).toBeUndefined();
    await w.setProps({ notice: { ...LOCAL, id: 'sn-2', chat: 'Docs' } });
    expect(root(w).element).toBe(element);
    expect(revoke.attributes('aria-disabled')).toBe('true');
    await revoke.trigger('click');
    expect(w.emitted('revoke')).toBeUndefined();
    await settle();
    await revoke.trigger('click');
    expect(w.emitted('revoke')).toEqual([['sn-2']]);
  });

  it('reports the pointer and keyboard focus in it, once each, and again under the id of a replacement', async () => {
    const w = notice();
    await root(w).trigger('pointerenter');
    w.get('[data-testid="screenshot-notice-revoke"]').element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await root(w).trigger('pointerenter');
    // focus moving between its own buttons stays inside
    const dismiss = w.get('[data-testid="screenshot-notice-dismiss"]').element;
    w.get('[data-testid="screenshot-notice-revoke"]').element.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: dismiss }));
    expect(w.emitted('hold')).toEqual([['sn-1', 'pointer', true], ['sn-1', 'focus', true]]);
    await w.setProps({ notice: { ...LOCAL, id: 'sn-2' } });
    expect(w.emitted('hold')!.slice(2)).toEqual([['sn-2', 'pointer', true], ['sn-2', 'focus', true]]);
    await root(w).trigger('pointerleave');
    dismiss.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
    expect(w.emitted('hold')!.slice(4)).toEqual([['sn-2', 'pointer', false], ['sn-2', 'focus', false]]);
  });

  // main owns the notice's lifetime: the component never closes itself
  it('stays until its publisher takes it away', async () => {
    const w = notice();
    vi.advanceTimersByTime(60_000);
    await flushPromises();
    expect(w.find('[data-testid="screenshot-notice"]').exists()).toBe(true);
    expect(w.emitted('dismiss')).toBeUndefined();
  });

  // At density 0.85 a size-7 or min-w-7 utility would replace the 1.5rem floor of the base layer (--d-hit-min).
  it('sizes Dismiss as the chat header\'s icon buttons, leaving the hit floor in force, and never fades its trusted root', () => {
    const w = notice();
    const dismiss = w.get('[data-testid="screenshot-notice-dismiss"]').classes();
    expect(dismiss).toEqual(expect.arrayContaining(['d-tool-btn', 'w-7.5', 'px-0']));
    expect(dismiss.join(' ')).not.toMatch(/(^|\s)(min-w-|min-h-|size-|h-)/);
    expect(root(w).classes().join(' ')).not.toMatch(/d-fade|o-fade-out|opacity-|shadow-/);
  });

  it('speaks Greek in the el locale', async () => {
    expect(await loadShellLocale('el')).toBe(true);
    shellI18n.global.locale.value = 'el';
    const w = notice();
    expect(w.get('#screenshot-notice-title').text()).toBe('Τραβήχτηκε στιγμιότυπο.');
    expect(w.get('[data-testid="screenshot-notice-body"]').text()).toBe('Η συνομιλία «Warmer sidebar» τράβηξε στιγμιότυπο αυτού του παραθύρου για το μοντέλο, όπως επιτρέψατε για εκείνη τη συνομιλία.');
    expect(w.get('[data-testid="screenshot-notice-revoke"]').text()).toBe('Ανάκληση');
    const remote = notice({ origin: 'ssh+h1', host: { name: 'prod-1' } });
    expect(remote.get('[data-testid="screenshot-notice-body"]').text()).toBe('Η συνομιλία «Warmer sidebar» στο prod-1 τράβηξε στιγμιότυπο αυτού του παραθύρου για το μοντέλο, όπως επιτρέψατε για εκείνη τη συνομιλία.');
  });
});

describe('the screenshot notice in the window', () => {
  const { selectedChat: _noChat, ...WITHOUT_CHAT } = STATE;
  const NONE: ShellState = { ...WITHOUT_CHAT, chatViewShown: false };
  const SHOWN: ShellState = { ...NONE, screenshotNotice: LOCAL };

  async function window(): Promise<ReturnType<typeof fakeShellApi>> {
    vi.useRealTimers();
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const api = fakeShellApi([], { getState: vi.fn(async () => SHOWN) });
    mounted.push(mount(App, { props: { api }, global: { plugins: [shellI18n], stubs: { transition: false } }, attachTo: document.body }));
    await flushPromises();
    return api;
  }
  const shown = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-testid="screenshot-notice"]')];

  it('updates in place for a newer notice, and on close plays its leave inert, so its stale Revoke answers nothing', async () => {
    const api = await window();
    const [element] = shown();
    api.push({ ...SHOWN, screenshotNotice: { ...LOCAL, id: 'sn-2', chat: 'Docs' } });
    await nextTick();
    expect(shown()).toEqual([element]);
    expect(element!.classList.contains('t-strip-leave-active')).toBe(false);

    api.push(NONE);
    await nextTick();
    expect(shown()).toEqual([element]);
    expect(element!.classList.contains('t-strip-leave-active')).toBe(true);
    expect(element!.hasAttribute('inert')).toBe(true);
    element!.querySelector<HTMLElement>('[data-testid="screenshot-notice-revoke"]')!.click();
    expect(api.revokeScreenshotGrant).not.toHaveBeenCalled();

    // a notice raised while the last one leaves waits for it to go
    api.push({ ...SHOWN, screenshotNotice: { ...LOCAL, id: 'sn-3' } });
    await nextTick();
    expect(shown()).toHaveLength(1);
    await vi.waitFor(() => expect(shown().some((candidate) => candidate !== element)).toBe(true));
    expect(shown()).toHaveLength(1);
  });

  it("passes the notice's own id to Revoke, Dismiss and its holds", async () => {
    const api = await window();
    await new Promise((resolve) => setTimeout(resolve, 550));
    await flushPromises();
    const [element] = shown();
    element!.dispatchEvent(new PointerEvent('pointerenter'));
    element!.querySelector<HTMLElement>('[data-testid="screenshot-notice-revoke"]')!.click();
    element!.querySelector<HTMLElement>('[data-testid="screenshot-notice-dismiss"]')!.click();
    expect(api.holdScreenshotNotice).toHaveBeenCalledWith('sn-1', 'pointer', true);
    expect(api.revokeScreenshotGrant).toHaveBeenCalledWith('sn-1');
    expect(api.dismissScreenshotNotice).toHaveBeenCalledWith('sn-1');
  });
});
