// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import type { OverlayRequest } from '../../preload/overlay-channels';
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

async function open(wrapper: VueWrapper, id: string, request: OverlayRequest): Promise<void> {
  api.request(id, request);
  await flushPromises();
  await wrapper.vm.$nextTick();
}

const press = (key: string, init: KeyboardEventInit = {}): void => {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
};

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
    expect(wrapper.get(`#${dialog.attributes('aria-labelledby')}`).text()).toBe('Delete Session');
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
    expect(wrapper.get('[data-testid="overlay-toasts"]').attributes('aria-label')).toBe('Ειδοποιήσεις');
  });

  it('labels the collapsed toasts with one Greek message', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    api.pushState({ locale: 'el', platform: 'win32' });
    for (const id of ['t1', 't2', 't3', 't4']) api.toast({ id, severity: 'info', message: `toast ${id}`, actions: [] });
    await flushPromises();

    expect(wrapper.get('[data-testid="overlay-toasts-more"]').text()).toBe('1 ακόμα · Απόρριψη όλων');
  });
});

describe('toasts', () => {
  it('shows at most three, collapses the rest into "N more · Dismiss all" and reports the stack area', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    expect(api.reportToastArea).toHaveBeenLastCalledWith({ width: 0, height: 0 });
    const stack = wrapper.get('[data-testid="overlay-toasts"]');
    (stack.element as HTMLElement).getBoundingClientRect = () => ({ left: 0, top: 0, right: 360, bottom: 99.2, x: 0, y: 0, width: 360, height: 99.2, toJSON: () => ({}) });

    for (const id of ['t1', 't2', 't3', 't4', 't5']) api.toast({ id, severity: 'info', message: `toast ${id}`, actions: id === 't5' ? ['Retry'] : [] });
    await flushPromises();
    expect(wrapper.findAll('[data-testid="overlay-toast"]').map((toast) => toast.text())).toEqual([
      expect.stringContaining('toast t3'),
      expect.stringContaining('toast t4'),
      expect.stringContaining('toast t5'),
    ]);
    expect(wrapper.get('[data-testid="overlay-toasts-more"]').text()).toBe('2 more · Dismiss all');
    expect(api.reportToastArea).toHaveBeenLastCalledWith({ width: 392, height: 132 });

    await wrapper.findAll('[data-testid="overlay-toast"]')[2]!.get('button').trigger('click');
    expect(api.resolveToast).toHaveBeenCalledWith('t5', 'Retry');
    api.dismissToast('t4');
    await flushPromises();
    expect(wrapper.find('[data-testid="overlay-toasts-more"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="overlay-toast"]')).toHaveLength(3);

    api.toast({ id: 't6', severity: 'error', message: 'boom', actions: [] });
    await flushPromises();
    await wrapper.get('[data-testid="overlay-toasts-more"]').trigger('click');
    expect(vi.mocked(api.resolveToast).mock.calls.slice(1)).toEqual([['t1'], ['t2'], ['t3'], ['t6']]);
    expect(wrapper.findAll('[data-testid="overlay-toast"]')).toHaveLength(0);
    expect(api.reportToastArea).toHaveBeenLastCalledWith({ width: 0, height: 0 });
  });

  it('shows toasts in arrival order and announces an error assertively and every other toast politely, through regions present while empty', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    const polite = wrapper.get('[data-testid="overlay-toasts-polite"]');
    const assertive = wrapper.get('[data-testid="overlay-toasts-assertive"]');
    expect(polite.attributes('aria-live')).toBe('polite');
    expect(assertive.attributes('aria-live')).toBe('assertive');

    api.toast({ id: 'i', severity: 'info', message: 'saved', actions: [] });
    api.toast({ id: 'w', severity: 'warning', message: 'careful', actions: [] });
    api.toast({ id: 'e', severity: 'error', message: 'failed', actions: [] });
    await flushPromises();
    expect(wrapper.findAll('[data-testid="overlay-toast"]').map((toast) => toast.attributes('data-toast-id'))).toEqual(['i', 'w', 'e']);
    expect(polite.text()).toContain('careful');
    expect(assertive.text()).toContain('failed');
    expect(assertive.text()).not.toContain('careful');
  });

  it('lies under a popup, so a dialog scrim covers the toasts', async () => {
    const wrapper = mountOverlay();
    api.toast({ id: 't1', severity: 'info', message: 'saved', actions: [] });
    await open(wrapper, 'c1', { kind: 'confirm', title: 'Delete', message: 'Sure?', confirmLabel: 'Delete', cancelLabel: 'Cancel', danger: true });
    const stack = wrapper.get('[data-testid="overlay-toasts"]').element;
    const dialog = wrapper.get('[data-testid="overlay-confirm"]').element;
    expect(stack.compareDocumentPosition(dialog) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('takes F6 focus on the newest toast, keeps Tab inside the stack, hands Escape to main and refocuses when the focused toast goes', async () => {
    const wrapper = mountOverlay();
    api.toast({ id: 'old', severity: 'info', message: 'older', actions: [] });
    api.toast({ id: 'new', severity: 'error', message: 'crashed', actions: ['Reload Chat'] });
    await flushPromises();
    const toast = (id: string) => wrapper.get(`[data-toast-id="${id}"]`);

    api.focusToasts();
    expect(document.activeElement?.textContent?.trim()).toBe('Reload Chat');
    (toast('new').get('[data-testid="overlay-toast-dismiss"]').element as HTMLElement).focus();
    press('Tab');
    expect(document.activeElement).toBe(toast('old').get('button').element);
    press('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(toast('new').get('[data-testid="overlay-toast-dismiss"]').element);

    press('Escape');
    expect(api.leaveToasts).toHaveBeenCalledTimes(1);
    expect(api.resolveToast).not.toHaveBeenCalled();

    await toast('new').get('[data-testid="overlay-toast-dismiss"]').trigger('click');
    await flushPromises();
    expect(api.resolveToast).toHaveBeenCalledWith('new', undefined);
    expect(document.activeElement).toBe(toast('old').get('button').element);
  });
});
