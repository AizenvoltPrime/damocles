// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import type { OverlayRequest, OverlayToast } from '../../preload/overlay-channels';
import type { NoticeSeverity } from '../../preload/notifications';
import NotifierApp from '../overlay/NotifierApp.vue';
import OverlayApp from '../overlay/OverlayApp.vue';
import { placePopup } from '../overlay/placement';
import { shellI18n } from '../i18n';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { FakeResizeObserver, fakeOverlayApi, type FakeOverlayApi } from './fakes';

const mounted: VueWrapper[] = [];
let api: FakeOverlayApi;

function mountOverlay(): VueWrapper {
  // The real TransitionGroup, since a popup answers main only once its exit has played.
  const wrapper = mount(OverlayApp, {
    props: { api, settingsBridge: createOverlaySettingsBridge(api) },
    global: { plugins: [shellI18n, createPinia()], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

// The desktop popup window's page, the only one that renders toasts.
function mountNotifier(): VueWrapper {
  const wrapper = mount(NotifierApp, {
    props: { api },
    global: { plugins: [shellI18n], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

async function open(wrapper: VueWrapper, id: string, request: OverlayRequest): Promise<void> {
  api.request(id, request);
  await flushPromises();
  await wrapper.vm.$nextTick();
}

const press = (key: string, init: KeyboardEventInit = {}): void => {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
};

function notice(id: string, severity: NoticeSeverity, message: string, actions: string[]): OverlayToast {
  return { id, at: Date.now(), lifeMs: 8000, remainingMs: 8000, body: { kind: 'notice', severity, message, actions } };
}

const ANCHOR = { x: 40, y: 50, width: 0, height: 0 };
const MENU: OverlayRequest = {
  kind: 'menu',
  label: 'Actions for Fix login',
  anchor: ANCHOR,
  items: [
    { kind: 'item', id: 'open', label: 'Open', icon: 'message-square' },
    { kind: 'separator' },
    { kind: 'item', id: 'rename', label: 'Rename session', icon: 'pencil' },
    { kind: 'item', id: 'remove', label: 'Remove tag', icon: 'x', disabled: true },
    { kind: 'item', id: 'delete', label: 'Delete session', icon: 'trash-2', danger: true },
  ],
};

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  api = fakeOverlayApi();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

describe('placement', () => {
  it('opens below the anchor, flips above when the bottom would clip, and stays inside the viewport', () => {
    const viewport = { width: 800, height: 600 };
    expect(placePopup({ x: 100, y: 100, width: 50, height: 20 }, { width: 200, height: 100 }, viewport)).toEqual({ left: 100, top: 120 });
    expect(placePopup({ x: 100, y: 550, width: 50, height: 20 }, { width: 200, height: 100 }, viewport)).toEqual({ left: 100, top: 450 });
    expect(placePopup({ x: 780, y: 0, width: 0, height: 0 }, { width: 200, height: 100 }, viewport)).toEqual({ left: 592, top: 8 });
  });
});

describe('overlay requests', () => {
  it('acknowledges a request once rendered and answers the chosen menu item', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'r1', MENU);

    expect(api.ack).toHaveBeenCalledWith('r1');
    const menu = wrapper.get('[role="menu"]');
    expect(menu.attributes('aria-label')).toBe('Actions for Fix login');
    expect(menu.findAll('[role="menuitem"]').map((item) => item.text())).toEqual(['Open', 'Rename session', 'Remove tag', 'Delete session']);
    expect(menu.findAll('[role="separator"]')).toHaveLength(1);
    expect(document.activeElement?.getAttribute('data-item-id')).toBe('open');

    await wrapper.get('[data-item-id="rename"]').trigger('click');
    // The answer waits for the exit, so main's switch to hidden cannot cut it short.
    expect(api.answer).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('r1', { kind: 'menu', itemId: 'rename' }));
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
  });

  it('moves through items with the arrow keys, Home, End and type-ahead, and never chooses a disabled item', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'r1', MENU);
    const focused = (): string | null | undefined => document.activeElement?.getAttribute('data-item-id');

    press('ArrowDown');
    expect(focused()).toBe('rename');
    press('ArrowUp');
    press('ArrowUp');
    expect(focused()).toBe('delete');
    press('Home');
    expect(focused()).toBe('open');
    press('End');
    expect(focused()).toBe('delete');
    press('r');
    expect(focused()).toBe('rename');
    press('r');
    expect(focused()).toBe('remove');
    press('Enter');
    expect(api.answer).not.toHaveBeenCalled();
    press('d');
    press('Enter');
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('r1', { kind: 'menu', itemId: 'delete' }));
  });

  it('keeps the first item focused when the menu opens under a resting pointer, and focuses an item once the pointer moves', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'r1', MENU);
    const rename = wrapper.get('[data-item-id="rename"]').element;
    rename.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, screenX: 400, screenY: 300 }));
    rename.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, screenX: 400, screenY: 300 }));
    expect(document.activeElement?.getAttribute('data-item-id')).toBe('open');
    rename.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, screenX: 401, screenY: 300 }));
    expect(document.activeElement?.getAttribute('data-item-id')).toBe('rename');
  });

  it('dismisses on Escape and on a click or right-click outside, and drops a cancelled request without answering', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'r1', MENU);
    press('Escape');
    await vi.waitFor(() => expect(api.answer).toHaveBeenLastCalledWith('r1', { kind: 'dismissed' }));

    await open(wrapper, 'r2', MENU);
    await wrapper.get('[data-testid="overlay-backdrop"]').trigger('click');
    await vi.waitFor(() => expect(api.answer).toHaveBeenLastCalledWith('r2', { kind: 'dismissed' }));

    await open(wrapper, 'r3', MENU);
    await wrapper.get('[data-testid="overlay-backdrop"]').trigger('contextmenu');
    await vi.waitFor(() => expect(api.answer).toHaveBeenLastCalledWith('r3', { kind: 'dismissed' }));

    await open(wrapper, 'r4', MENU);
    api.cancel('r4');
    await vi.waitFor(() => expect(wrapper.find('[role="menu"]').exists()).toBe(false));
    press('Escape');
    expect(api.answer).toHaveBeenCalledTimes(3);
  });

  it('filters a menu that asks for a filter box and marks the checked item', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'r1', {
      kind: 'menu',
      label: 'All tags',
      anchor: ANCHOR,
      filterPlaceholder: 'Filter 3 tags',
      items: [
        { kind: 'item', id: '0', label: 'api', icon: 'tag', shortcut: '2', checked: false },
        { kind: 'item', id: '1', label: 'auth', icon: 'tag', shortcut: '1', checked: true },
        { kind: 'item', id: '2', label: 'docs', icon: 'tag', shortcut: '4', checked: false },
      ],
    });
    const filter = wrapper.get('[data-testid="overlay-menu-filter"]');
    expect(document.activeElement).toBe(filter.element);
    expect(wrapper.get('[data-item-id="1"]').attributes()).toMatchObject({ role: 'menuitemcheckbox', 'aria-checked': 'true' });

    await filter.setValue('au');
    expect(wrapper.findAll('[data-menu-item]').map((item) => item.attributes('data-item-id'))).toEqual(['1']);
    await filter.setValue('zzz');
    expect(wrapper.text()).toContain('No matches');
    await filter.setValue('do');
    await filter.trigger('keydown', { key: 'Enter' });
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('r1', { kind: 'menu', itemId: '2' }));
  });

  it('traps focus in the confirm dialog, starting on Cancel, and answers the choice', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'r1', {
      kind: 'confirm',
      title: 'Delete Session',
      message: 'Delete this session? This action cannot be undone.',
      detail: { label: 'Session:', text: '<b>Fix login</b>' },
      warning: { text: 'This chat is still running. Deleting it stops the agent.', running: true },
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    const dialog = wrapper.get('[role="alertdialog"]');
    expect(dialog.attributes('aria-modal')).toBe('true');
    expect(dialog.attributes('aria-labelledby')!.split(' ').map((id) => wrapper.get(`#${id}`).text()).join(' ')).toBe('Caution Delete Session');
    expect(dialog.text()).toContain('<b>Fix login</b>');
    expect(dialog.find('b').exists()).toBe(false);
    expect(wrapper.get('[data-testid="overlay-confirm-warning"] svg').classes()).toContain('d-spinning');
    const cancel = wrapper.get('[data-testid="overlay-confirm-cancel"]');
    const accept = wrapper.get('[data-testid="overlay-confirm-accept"]');
    expect(document.activeElement).toBe(cancel.element);
    expect(accept.classes()).toEqual(expect.arrayContaining(['bg-(--d-danger)', 'text-(--d-on-danger)']));

    press('Tab');
    expect(document.activeElement).toBe(cancel.element);
    (accept.element as HTMLElement).focus();
    press('Tab');
    expect(document.activeElement).toBe(cancel.element);
    press('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(accept.element);

    await accept.trigger('click');
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('r1', { kind: 'confirm', confirmed: true }));
  });

  it('focuses Confirm first when the confirmation is not destructive, and Escape or the scrim answers not confirmed', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    const request: OverlayRequest = { kind: 'confirm', title: 'Reset layout', message: 'Put every pane back?', confirmLabel: 'Reset', cancelLabel: 'Cancel', danger: false };
    await open(wrapper, 'r1', request);
    expect(document.activeElement).toBe(wrapper.get('[data-testid="overlay-confirm-accept"]').element);
    press('Escape');
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('r1', { kind: 'confirm', confirmed: false }));

    await open(wrapper, 'r2', request);
    await wrapper.get('[data-overlay-id="r2"]').trigger('click');
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('r2', { kind: 'confirm', confirmed: false }));
  });

  it('answers a message dialog\'s scrim click as Cancel, and a click inside the dialog as nothing', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'm1', { kind: 'message', severity: 'info', message: 'Switch?', actions: ['Switch'], cancelLabel: 'Cancel', defaultAction: 0 });
    await wrapper.get('[role="alertdialog"]').trigger('click');
    await flushPromises();
    expect(api.answer).not.toHaveBeenCalled();
    await wrapper.get('[data-overlay-id="m1"]').trigger('click');
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('m1', { kind: 'message', action: null }));
  });

  it('marks only a warning about running work with a spinner', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'r1', {
      kind: 'confirm',
      title: 'Delete Session',
      message: 'Delete this session? This action cannot be undone.',
      warning: { text: 'This chat is waiting for you. Deleting it stops the agent.', running: false },
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    const warning = wrapper.get('[data-testid="overlay-confirm-warning"]');
    expect(warning.text()).toBe('This chat is waiting for you. Deleting it stops the agent.');
    expect(warning.find('.d-spinning').exists()).toBe(false);
    expect(warning.find('svg').exists()).toBe(true);
  });

  it('answers the tag picker with the trimmed tag, a suggestion, or null to remove', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    const request: OverlayRequest = { kind: 'tagPicker', anchor: ANCHOR, current: 'auth', tags: ['auth', 'api', 'docs'], placeholder: 'Enter tag...' };

    await open(wrapper, 'r1', request);
    const input = wrapper.get('[data-testid="overlay-tag-input"]');
    expect(input.attributes('placeholder')).toBe('Enter tag...');
    expect((input.element as HTMLInputElement).value).toBe('auth');
    await input.setValue('  release  ');
    await input.trigger('keydown', { key: 'Enter' });
    await vi.waitFor(() => expect(api.answer).toHaveBeenLastCalledWith('r1', { kind: 'tagPicker', tag: 'release' }));

    await open(wrapper, 'r2', request);
    const second = wrapper.get('[data-testid="overlay-tag-input"]');
    await second.setValue('');
    expect(wrapper.findAll('[role="option"]').map((option) => option.text())).toEqual(['api', 'docs']);
    await second.trigger('keydown', { key: 'ArrowDown' });
    await second.trigger('keydown', { key: 'ArrowDown' });
    await second.trigger('keydown', { key: 'Enter' });
    await vi.waitFor(() => expect(api.answer).toHaveBeenLastCalledWith('r2', { kind: 'tagPicker', tag: 'docs' }));

    await open(wrapper, 'r3', request);
    await wrapper.get('[data-testid="overlay-tag-remove"]').trigger('click');
    await vi.waitFor(() => expect(api.answer).toHaveBeenLastCalledWith('r3', { kind: 'tagPicker', tag: null }));
  });
});

describe('overlay locale', () => {
  it('follows a language change main publishes after the first read', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    expect(document.documentElement.lang).toBe('en');
    api.pushState({ locale: 'el', platform: 'win32' });
    await flushPromises();
    expect(document.documentElement.lang).toBe('el');
    await open(wrapper, 'r1', MENU);
    expect(wrapper.get('[role="menu"]').attributes('aria-label')).toBe('Actions for Fix login');
  });

  it('labels the popup page\'s stack and its collapsed toasts in Greek after a language change', async () => {
    const wrapper = mountNotifier();
    await flushPromises();
    api.pushState({ locale: 'el', platform: 'win32' });
    for (const id of ['t1', 't2', 't3', 't4']) api.toast(notice(id, 'info', `toast ${id}`, []));
    await flushPromises();

    expect(document.documentElement.lang).toBe('el');
    expect(wrapper.get('[data-testid="overlay-toasts"]').attributes('aria-label')).toBe('Ειδοποιήσεις');
    expect(wrapper.get('[data-testid="overlay-toasts-more"]').text()).toBe('1 ακόμα · Απόρριψη όλων');
  });
});

describe('toasts', () => {
  it('render only in the popup page, never in the overlay', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    api.toast(notice('t1', 'info', 'saved', []));
    await flushPromises();
    expect(wrapper.find('[data-testid="overlay-toasts"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="overlay-toast"]').exists()).toBe(false);
    expect(api.onToast).not.toHaveBeenCalled();
  });

  it('shows at most three, collapses the rest into "N more · Dismiss all" and reports the stack area', async () => {
    const wrapper = mountNotifier();
    await flushPromises();
    expect(api.reportToastArea).toHaveBeenLastCalledWith({ width: 0, height: 0, parts: [] });
    const stack = wrapper.get('[data-testid="overlay-toasts"]');
    Object.defineProperty(stack.element, 'offsetWidth', { value: 380 });
    Object.defineProperty(stack.element, 'offsetHeight', { value: 99.2 });

    for (const id of ['t1', 't2', 't3', 't4', 't5']) api.toast(notice(id, 'info', `toast ${id}`, id === 't5' ? ['Retry'] : []));
    await flushPromises();
    expect(wrapper.findAll('[data-testid="overlay-toast"]').map((toast) => toast.text())).toEqual([
      expect.stringContaining('toast t3'),
      expect.stringContaining('toast t4'),
      expect.stringContaining('toast t5'),
    ]);
    expect(wrapper.get('[data-testid="overlay-toasts-more"]').text()).toBe('2 more · Dismiss all');
    expect(api.reportToastArea).toHaveBeenLastCalledWith({ width: 412, height: 132, parts: [] });

    await wrapper.findAll('[data-testid="overlay-toast"]')[2]!.get('[data-toast-primary]').trigger('click');
    expect(api.resolveToast).toHaveBeenCalledWith('t5', 'Retry');
    api.dismissToast('t4');
    // A toast and the pill stay in the DOM while their exit plays.
    await vi.waitFor(() => expect(wrapper.find('[data-testid="overlay-toasts-more"]').exists()).toBe(false));
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="overlay-toast"]')).toHaveLength(3));

    api.toast(notice('t6', 'error', 'boom', []));
    await flushPromises();
    await wrapper.get('[data-testid="overlay-toasts-more"]').trigger('click');
    expect(vi.mocked(api.resolveToast).mock.calls.slice(1)).toEqual([['t1'], ['t2'], ['t3'], ['t6']]);
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="overlay-toast"]')).toHaveLength(0));
    // The area shrinks once the last exit has played, so main never cuts it short.
    await vi.waitFor(() => expect(api.reportToastArea).toHaveBeenLastCalledWith({ width: 0, height: 0, parts: [] }));
  });

  it('reports the layout boxes of its toasts and pill within the area, and when the pointer moves onto or off them', async () => {
    const wrapper = mountNotifier();
    await flushPromises();
    const stack = wrapper.get('[data-testid="overlay-toasts"]');
    const layout = (element: Element, box: { left: number; top: number; width: number; height: number }): void => {
      for (const [key, value] of Object.entries({ offsetLeft: box.left, offsetTop: box.top, offsetWidth: box.width, offsetHeight: box.height })) {
        Object.defineProperty(element, key, { value, configurable: true });
      }
    };
    layout(stack.element, { left: 0, top: 0, width: 380, height: 220 });
    for (const id of ['t1', 't2', 't3', 't4']) api.toast(notice(id, 'info', `toast ${id}`, []));
    await flushPromises();
    const pill = wrapper.get('[data-testid="overlay-toasts-more"]');
    const cards = wrapper.findAll('[data-testid="overlay-toast"]');
    layout(pill.element, { left: 144, top: 0, width: 92, height: 24 });
    cards.forEach((card, index) => layout(card.element, { left: 0, top: 34 + index * 66, width: 380, height: 56 }));
    FakeResizeObserver.instances.find((observer) => observer.observed.includes(stack.element))!.callback();
    expect(api.reportToastArea).toHaveBeenLastCalledWith({
      width: 412,
      height: 252,
      parts: [
        { x: 160, y: 16, width: 92, height: 24 },
        { x: 16, y: 50, width: 380, height: 56 },
        { x: 16, y: 116, width: 380, height: 56 },
        { x: 16, y: 182, width: 380, height: 56 },
      ],
    });

    const over = (target: EventTarget): void => {
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    };
    over(cards[1]!.get('p').element);
    over(cards[2]!.element);
    expect(api.reportToastPointer).toHaveBeenCalledTimes(1);
    expect(api.reportToastPointer).toHaveBeenLastCalledWith(true);
    over(document.body);
    expect(api.reportToastPointer).toHaveBeenLastCalledWith(false);
    over(pill.element);
    expect(api.reportToastPointer).toHaveBeenLastCalledWith(true);
    // The pointer leaves the page from the pill.
    pill.element.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
    expect(api.reportToastPointer).toHaveBeenLastCalledWith(false);
    expect(api.reportToastPointer).toHaveBeenCalledTimes(4);
  });

  it('shows toasts in arrival order and announces an error assertively and every other toast politely, through regions present while empty', async () => {
    const wrapper = mountNotifier();
    await flushPromises();
    const polite = wrapper.get('[data-testid="overlay-toasts-polite"]');
    const assertive = wrapper.get('[data-testid="overlay-toasts-assertive"]');
    expect(polite.attributes('aria-live')).toBe('polite');
    expect(assertive.attributes('aria-live')).toBe('assertive');

    // What a screen reader hears: the text each region gains, whether as new nodes or as changed text.
    const heard = (region: Element): string[] => {
      const texts: string[] = [];
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'characterData') texts.push(record.target.textContent?.trim() ?? '');
          for (const node of record.addedNodes) texts.push(node.textContent?.trim() ?? '');
        }
      }).observe(region, { childList: true, characterData: true, subtree: true });
      return texts;
    };
    const politeHeard = heard(polite.element);
    const assertiveHeard = heard(assertive.element);

    // Main replays every waiting toast in one burst when the page loads.
    api.toast(notice('i', 'info', 'saved', []));
    api.toast(notice('w', 'warning', 'careful', []));
    api.toast(notice('e', 'error', 'failed', []));
    await flushPromises();
    expect(wrapper.findAll('[data-testid="overlay-toast"]').map((toast) => toast.attributes('data-toast-id'))).toEqual(['i', 'w', 'e']);
    expect(politeHeard.filter(Boolean)).toEqual(['Information: saved', 'Warning: careful']);
    expect(assertiveHeard.filter(Boolean)).toEqual(['Error: failed']);

    // A toast's announcement goes with it, unheard; the same text again is heard again.
    api.dismissToast('i');
    api.toast(notice('i2', 'info', 'saved', []));
    await flushPromises();
    expect(politeHeard.filter(Boolean)).toEqual(['Information: saved', 'Warning: careful', 'Information: saved']);
    expect(polite.findAll('p').map((node) => node.text())).toEqual(['Warning: careful', 'Information: saved']);
  });

  it('takes F6 focus on the newest toast, keeps Tab inside the stack, hands Escape to main and refocuses when the focused toast goes', async () => {
    const wrapper = mountNotifier();
    api.toast(notice('old', 'info', 'older', []));
    api.toast(notice('new', 'error', 'crashed', ['Reload Chat']));
    await flushPromises();
    const toast = (id: string) => wrapper.get(`[data-toast-id="${id}"]`);

    api.focusToasts();
    expect(document.activeElement?.textContent?.trim()).toBe('Reload Chat');
    const last = toast('new').findAll('button').at(-1)!;
    expect(last.text()).toBe('Reload Chat');
    (last.element as HTMLElement).focus();
    press('Tab');
    expect(document.activeElement).toBe(toast('old').get('[data-testid="overlay-toast-dismiss"]').element);
    press('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last.element);

    press('Escape');
    expect(api.leaveToasts).toHaveBeenCalledTimes(1);
    expect(api.resolveToast).not.toHaveBeenCalled();

    await toast('new').get('[data-testid="overlay-toast-dismiss"]').trigger('click');
    await flushPromises();
    expect(api.resolveToast).toHaveBeenCalledWith('new', undefined);
    expect(document.activeElement).toBe(toast('old').get('[data-testid="overlay-toast-dismiss"]').element);
    expect(api.leaveToasts).toHaveBeenCalledTimes(1);

    // The last toast going takes focus out of the popup window at once, while its exit still plays.
    await toast('old').get('[data-testid="overlay-toast-dismiss"]').trigger('click');
    expect(api.leaveToasts).toHaveBeenCalledTimes(2);
  });

  it('keeps focus in the stack when the card or the pill holding it goes unanswered', async () => {
    const wrapper = mountNotifier();
    for (const id of ['t1', 't2', 't3']) api.toast(notice(id, 'info', `toast ${id}`, ['Open']));
    await flushPromises();
    const primary = (id: string): Element => wrapper.get(`[data-toast-id="${id}"] [data-toast-primary]`).element;

    // A newer toast collapses the focused card into the pill.
    (primary('t1') as HTMLElement).focus();
    api.toast(notice('t4', 'info', 'toast t4', ['Open']));
    await flushPromises();
    expect(document.activeElement).toBe(primary('t4'));

    // Main dismisses the toast behind the focused pill, and the pill goes.
    (wrapper.get('[data-testid="overlay-toasts-more"]').element as HTMLElement).focus();
    api.dismissToast('t1');
    await flushPromises();
    expect(document.activeElement).toBe(primary('t4'));
    expect(api.leaveToasts).not.toHaveBeenCalled();
  });

  it('ends the hold of a card that leaves the visible three, so main runs its timer again while it waits in the pill', async () => {
    const wrapper = mountNotifier();
    for (const id of ['t1', 't2', 't3']) api.toast(notice(id, 'info', `toast ${id}`, []));
    await flushPromises();
    await wrapper.get('[data-toast-id="t1"]').trigger('mouseenter');
    expect(api.holdToast).toHaveBeenLastCalledWith('t1', true);

    api.toast(notice('t4', 'info', 'toast t4', []));
    await flushPromises();
    expect(api.holdToast).toHaveBeenLastCalledWith('t1', false);
    expect(api.holdToast).toHaveBeenCalledTimes(2);

    // A held card main takes away is finished there; nothing is left to release.
    await wrapper.get('[data-toast-id="t2"]').trigger('mouseenter');
    api.dismissToast('t2');
    await flushPromises();
    expect(vi.mocked(api.holdToast).mock.calls.slice(2)).toEqual([['t2', true]]);
  });
});

describe('command palette', () => {
  const COMMANDS = [
    { id: 'damocles.toggleSidebar', label: 'View: Toggle Sidebar', englishLabel: 'View: Toggle Sidebar', category: 'View', accelerator: 'Ctrl+B', enabled: true, recent: true },
    { id: 'damocles.chat.contextUsage', label: 'Chat: Context usage', englishLabel: 'Chat: Context usage', category: 'Chat', accelerator: null, enabled: true, recent: false },
    { id: 'damocles.chat.tools', label: 'Chat: Tools', englishLabel: 'Chat: Tools', category: 'Chat', accelerator: null, enabled: false, recent: false },
  ];

  async function type(wrapper: VueWrapper, value: string): Promise<void> {
    await wrapper.get('[data-testid="quick-pick-input"]').setValue(value);
    await flushPromises();
  }

  it('opens with ">" typed, lists categories and keycaps, and answers the command Enter picks', async () => {
    api.commands.list = COMMANDS;
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'p1', { kind: 'quickOpen', mode: 'commands' });
    const input = wrapper.get('[data-testid="quick-pick-input"]');
    expect((input.element as HTMLInputElement).value).toBe('>');
    expect(input.attributes('aria-label')).toBe('Command Palette');
    expect(wrapper.text()).toContain('recently used');
    const sidebar = wrapper.get('[data-item-id="damocles.toggleSidebar"]');
    expect(sidebar.attributes('aria-keyshortcuts')).toBe('Control+B');
    expect(sidebar.findAll('kbd').map((cap) => cap.text())).toEqual(['Ctrl', 'B']);
    expect(input.attributes('aria-activedescendant')).toBe(sidebar.attributes('id'));

    await type(wrapper, '>context');
    press('Enter');
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('p1', { kind: 'quickOpen', command: 'damocles.chat.contextUsage' }));
    expect(api.listCommands).toHaveBeenCalledTimes(1);
  });

  it('keeps the first command active under a resting pointer, so Enter runs it, and activates a row once the pointer moves', async () => {
    api.commands.list = COMMANDS;
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'p1', { kind: 'quickOpen', mode: 'commands' });
    const input = wrapper.get('[data-testid="quick-pick-input"]');
    const first = wrapper.get('[data-item-id="damocles.toggleSidebar"]');
    const context = wrapper.get('[data-item-id="damocles.chat.contextUsage"]');
    const move = (x: number): void => { context.element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, screenX: x, screenY: 200 })); };
    move(300);
    move(300);
    await flushPromises();
    expect(input.attributes('aria-activedescendant')).toBe(first.attributes('id'));
    move(301);
    await flushPromises();
    expect(input.attributes('aria-activedescendant')).toBe(context.attributes('id'));
  });

  it('dims a disabled command, which neither Enter nor a click runs', async () => {
    api.commands.list = COMMANDS;
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'p1', { kind: 'quickOpen', mode: 'commands' });
    await type(wrapper, '>tools');
    const tools = wrapper.get('[data-item-id="damocles.chat.tools"]');
    expect(tools.attributes('aria-disabled')).toBe('true');
    expect(tools.classes()).toContain('opacity-50');
    press('Enter');
    await tools.trigger('click');
    await flushPromises();
    expect(api.answer).not.toHaveBeenCalled();
  });

  it('switches Quick Open to the palette on a leading ">" and back when it is deleted', async () => {
    api.commands.list = COMMANDS;
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'q1', { kind: 'quickOpen', mode: 'files' });
    const input = wrapper.get('[data-testid="quick-pick-input"]');
    expect(input.attributes('aria-label')).toBe('Quick Open');
    await type(wrapper, '>');
    expect(input.attributes('aria-label')).toBe('Command Palette');
    expect(wrapper.find('[data-item-id="damocles.chat.contextUsage"]').exists()).toBe(true);
    await type(wrapper, '');
    expect(input.attributes('aria-label')).toBe('Quick Open');
    expect(wrapper.find('[data-item-id="damocles.chat.contextUsage"]').exists()).toBe(false);
  });

  it('shows a folder scope as a chip before the query, lists its files without groups and answers the pick', async () => {
    const result = (relativePath: string) => ({
      projectKey: 'api-key', projectName: 'api', relativePath, label: relativePath.split('/').at(-1)!, description: 'src/routes', labelMatches: [], descriptionMatches: [], recent: false,
    });
    api.quickOpen.answer = (query) => ({ generation: query.generation, currentProjectKey: 'web-key', mention: false, results: [result('src/routes/admin.ts'), result('src/routes/users.ts')] });
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'q1', { kind: 'quickOpen', mode: 'files', scope: { projectKey: 'api-key', projectName: 'api', folder: 'src/routes/' } });
    const input = wrapper.get('[data-testid="quick-pick-input"]');
    expect(wrapper.get('[data-testid="quick-pick-scope"]').attributes('title')).toBe('api / src/routes/');
    expect(wrapper.get('[data-testid="quick-pick-scope"]').text()).toContain('api / src/routes/');
    expect(input.attributes('aria-label')).toBe('Go to a file in api / src/routes/');
    expect(input.attributes('placeholder')).toBe('Search files in this folder (append : to go to line, @ to mention in chat)');
    expect(wrapper.findAll('[role="presentation"]')).toHaveLength(0);
    expect(wrapper.findAll('[data-testid="quick-pick-item"]').map((item) => item.text())).toEqual([expect.stringContaining('admin.ts'), expect.stringContaining('users.ts')]);
    await wrapper.findAll('[data-testid="quick-pick-item"]')[1]!.trigger('click');
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('q1', { kind: 'quickOpen', pick: { projectKey: 'api-key', relativePath: 'src/routes/users.ts', mention: false } }));

    // Greek labels the scope too, and the next request without one is plain Quick Open again.
    shellI18n.global.locale.value = 'el';
    await open(wrapper, 'q2', { kind: 'quickOpen', mode: 'files', scope: { projectKey: 'api-key', projectName: 'api', folder: '' } });
    expect(wrapper.get('[data-testid="quick-pick-input"]').attributes('aria-label')).toBe('Μετάβαση σε αρχείο στο api');
    shellI18n.global.locale.value = 'en';
  });

  it('picks from the answer to the newest query when an older answer lands last', async () => {
    const result = { projectKey: 'web-key', projectName: 'web', relativePath: 'src/foo.ts', label: 'foo.ts', description: 'src', labelMatches: [], descriptionMatches: [], recent: false };
    const late: Array<() => void> = [];
    vi.mocked(api.queryQuickOpen).mockImplementation((query) => new Promise((resolve) => {
      const answer = { generation: query.generation, mention: false, results: [result], ...(query.query === 'foo:12' ? { line: 12 } : {}) };
      if (query.query === 'foo:12') late.push(() => resolve(answer));
      else resolve(answer);
    }));
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'q1', { kind: 'quickOpen', mode: 'files' });
    await type(wrapper, 'foo:12');
    await type(wrapper, 'foo');
    for (const settle of late) settle();
    await flushPromises();
    press('Enter');
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('q1', { kind: 'quickOpen', pick: { projectKey: 'web-key', relativePath: 'src/foo.ts', mention: false } }));
  });

  it('in Greek finds a command by its English title', async () => {
    vi.mocked(api.getState).mockResolvedValue({ locale: 'el', platform: 'win32' });
    api.commands.list = [{ ...COMMANDS[1]!, label: 'Συνομιλία: Χρήση περιβάλλοντος', category: 'Συνομιλία' }];
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'p1', { kind: 'quickOpen', mode: 'commands' });
    await type(wrapper, '>context usage');
    expect(wrapper.get('[data-item-id="damocles.chat.contextUsage"]').text()).toContain('Chat: Context usage');
  });
});
