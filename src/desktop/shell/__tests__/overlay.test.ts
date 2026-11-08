// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import {
  MAX_QUICK_OPEN_LISTING_RESULTS, quickOpenRowKey,
  type OverlayRequest, type OverlayToast, type QuickOpenCompletion, type QuickOpenFolderResult, type QuickOpenPathResult, type QuickOpenQuery, type QuickOpenResponse, type QuickOpenResult,
} from '../../preload/overlay-channels';
import type { NoticeSeverity } from '../../preload/notifications';
import NotifierApp from '../overlay/NotifierApp.vue';
import OverlayApp from '../overlay/OverlayApp.vue';
import { placePanel, placePopup } from '../overlay/placement';
import { shellI18n } from '../i18n';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { FakeResizeObserver, fakeOverlayApi, opened, type FakeOverlayApi } from './fakes';
import { MAX_INPUT_VALUE_LENGTH } from '@shared/input-validation';

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

  it('hangs a panel below its chip, or above it when there is more room there, capped to that room and inside the viewport', () => {
    const viewport = { width: 800, height: 600 };
    expect(placePanel({ x: 100, y: 6, width: 90, height: 28 }, 416, viewport)).toEqual({ left: 100, top: 40, maxHeight: 552 });
    expect(placePanel({ x: 700, y: 6, width: 90, height: 28 }, 416, viewport)).toMatchObject({ left: 376, top: 40 });
    expect(placePanel({ x: 10, y: 560, width: 50, height: 20 }, 416, viewport)).toEqual({ left: 10, bottom: 46, maxHeight: 546 });
  });

  it('gives a panel no negative height in a viewport too short for it', () => {
    expect(placePanel({ x: 0, y: 0, width: 10, height: 16 }, 416, { width: 800, height: 20 })).toEqual({ left: 8, top: 22, maxHeight: 0 });
  });
});

describe('overlay requests', () => {
  // Main's deadline counts only to the acknowledgement, so a slow first render must not delay it.
  it('acknowledges a request as it arrives, before rendering it, and reports it shown once rendered', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    api.request('r1', MENU);
    expect(api.ack).toHaveBeenCalledWith('r1');
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(api.shown).not.toHaveBeenCalled();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[role="menu"]').exists()).toBe(true);
    expect(api.shown).toHaveBeenCalledWith('r1');
  });

  it('never reports a request shown that main withdrew before it rendered', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    api.request('r1', MENU);
    api.cancel('r1');
    await wrapper.vm.$nextTick();
    expect(api.ack).toHaveBeenCalledWith('r1');
    expect(api.shown).not.toHaveBeenCalled();
  });

  // Create Tag asks a name, then at once a message: each box leaves the page once its own answer is out.
  it('answers chained input boxes in turn, each leaving once its exit has played', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    vi.mocked(api.answer).mockImplementationOnce((id) => {
      if (id === 'name') api.request('message', { kind: 'input', prompt: 'Please provide a message to annotate the tag', placeholder: 'Message' });
    });
    await open(wrapper, 'name', { kind: 'input', prompt: 'Please provide a tag name', placeholder: 'Tag name', validation: 'tagName' });
    const field = () => wrapper.get<HTMLInputElement>('[data-overlay-id="message"] [data-testid="quick-input-field"]');
    await wrapper.get('[data-testid="quick-input-field"]').setValue('v2.0');
    await wrapper.get('[data-testid="quick-input-field"]').trigger('keydown', { key: 'Enter' });
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('name', { kind: 'input', value: 'v2.0' }));
    await vi.waitFor(() => expect(wrapper.find('[data-overlay-id="message"]').exists()).toBe(true));
    expect(wrapper.find('[data-overlay-id="name"]').exists()).toBe(false);
    await field().setValue('Release two');
    await field().trigger('keydown', { key: 'Enter' });
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('message', { kind: 'input', value: 'Release two' }));
    expect(wrapper.find('[data-overlay-id]').exists()).toBe(false);
  });

  it('answers the chosen menu item', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'r1', MENU);

    expect(api.shown).toHaveBeenCalledWith('r1');
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

  // happy-dom applies no white-space rule, so this pins the class that keeps a question's paragraph breaks, as VS Code's dialog does.
  it('keeps the line breaks of a message dialog\'s question, so each of its questions reads as its own paragraph', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    const message = 'Are you sure you want to DELETE 1 untracked file? This is IRREVERSIBLE!\n\nAre you sure you want to discard changes in \'a.ts\'?';
    await open(wrapper, 'm1', { kind: 'message', severity: 'danger', message, actions: ['Discard All 2 Files'], cancelLabel: 'Cancel' });
    const dialog = wrapper.get('[role="alertdialog"]');
    const heading = wrapper.get(`#${dialog.attributes('aria-labelledby')!.split(' ').at(-1)!}`);
    expect(heading.element.textContent).toBe(message);
    expect(heading.classes()).toContain('whitespace-pre-line');
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

describe('menu submenus', () => {
  const SUBMENUS: OverlayRequest = {
    kind: 'menu',
    label: 'Views and More Actions',
    anchor: ANCHOR,
    items: [
      {
        kind: 'submenu',
        id: 'submenu:view',
        label: 'View & Sort',
        icon: 'list-filter',
        items: [
          { kind: 'item', id: 'tree', label: 'View as Tree', checked: true, radio: true },
          { kind: 'item', id: 'list', label: 'View as List', checked: false, radio: true },
        ],
      },
      { kind: 'submenu', id: 'submenu:commit', label: 'Commit', items: [{ kind: 'item', id: 'commit', label: 'Commit' }, { kind: 'item', id: 'amend', label: 'Commit (Amend)' }] },
      { kind: 'item', id: 'output', label: 'Show Git Output' },
    ],
  };
  const focused = (): string | null | undefined => document.activeElement?.getAttribute('data-item-id');
  const submenu = (wrapper: VueWrapper) => wrapper.find('[data-testid="overlay-submenu"]');
  const pressNow = async (key: string): Promise<void> => {
    press(key);
    await flushPromises();
  };
  let pointer = 0;
  const hover = async (element: Element): Promise<void> => {
    element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, screenX: 400 + ++pointer, screenY: 300 }));
    await flushPromises();
  };

  it('opens a submenu with ArrowRight, comes back with ArrowLeft or Escape without closing the menu, and answers a leaf', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'r1', SUBMENUS);
    expect(focused()).toBe('submenu:view');
    await pressNow('ArrowRight');
    expect(submenu(wrapper).attributes('aria-label')).toBe('View & Sort');
    expect(focused()).toBe('tree');
    await pressNow('ArrowDown');
    expect(focused()).toBe('list');
    await pressNow('ArrowLeft');
    expect(submenu(wrapper).exists()).toBe(false);
    expect(focused()).toBe('submenu:view');
    await pressNow('ArrowRight');
    await pressNow('Escape');
    expect(submenu(wrapper).exists()).toBe(false);
    expect(focused()).toBe('submenu:view');
    expect(wrapper.find('[data-testid="overlay-menu"]').exists()).toBe(true);
    expect(api.answer).not.toHaveBeenCalled();
    await pressNow('ArrowDown');
    await pressNow('Enter');
    expect(focused()).toBe('commit');
    await pressNow('ArrowDown');
    await pressNow('Enter');
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('r1', { kind: 'menu', itemId: 'amend' }));
  });

  it('shows a submenu\'s hint under its label, and draws its shells\' glyphs in their colours', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'r1', {
      kind: 'menu',
      label: 'New terminal with a shell',
      anchor: ANCHOR,
      items: [
        { kind: 'submenu', id: 'project-0', label: 'api', hint: 'prod', items: [{ kind: 'item', id: 'shell-0', label: 'Dev', glyph: 'wrench', color: 'magenta' }] },
        { kind: 'item', id: 'info-1', label: 'web', hint: 'lab', disabled: true, disabledReason: 'Not connected' },
      ],
    });
    const row = wrapper.get('[data-item-id="project-0"]');
    expect(row.get('[data-testid="overlay-menu-hint"]').text()).toBe(', prod');
    // the host hint alone tells same-named projects apart, so it reads at faint-text's AA shade at rest, not only on hover
    expect(row.get('[data-testid="overlay-menu-hint"]').classes()).toContain('text-(--d-faint-text)');
    expect(row.get('[data-testid="overlay-menu-hint"]').classes()).not.toContain('text-(--d-faint)');
    await pressNow('ArrowRight');
    const shell = submenu(wrapper).get('[data-item-id="shell-0"] svg');
    expect(shell.attributes('style')).toContain('var(--terminal-tint-5)');
    await pressNow('Enter');
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('r1', { kind: 'menu', itemId: 'shell-0' }));
  });

  it('marks mutually exclusive choices as radio items', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'r1', SUBMENUS);
    await pressNow('ArrowRight');
    expect(submenu(wrapper).findAll('[data-submenu-item]').map((item) => [item.attributes('role'), item.attributes('aria-checked')])).toEqual([
      ['menuitemradio', 'true'],
      ['menuitemradio', 'false'],
    ]);
  });

  it('keeps an open submenu while the pointer crosses other rows on its way there, and gives way once it rests on one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const wrapper = mountOverlay();
      await flushPromises();
      await open(wrapper, 'r1', SUBMENUS);
      const row = (id: string) => wrapper.get(`[data-item-id="${id}"]`).element;
      await hover(row('output'));
      await hover(row('submenu:commit'));
      expect(submenu(wrapper).attributes('aria-label')).toBe('Commit');

      await hover(row('output'));
      await hover(row('output'));
      vi.advanceTimersByTime(299);
      await flushPromises();
      expect(submenu(wrapper).attributes('aria-label')).toBe('Commit');
      submenu(wrapper).element.dispatchEvent(new MouseEvent('mouseenter'));
      vi.advanceTimersByTime(400);
      await flushPromises();
      expect(submenu(wrapper).attributes('aria-label')).toBe('Commit');

      await hover(row('submenu:view'));
      vi.advanceTimersByTime(300);
      await flushPromises();
      expect(submenu(wrapper).attributes('aria-label')).toBe('View & Sort');

      await hover(row('output'));
      vi.advanceTimersByTime(300);
      await flushPromises();
      expect(submenu(wrapper).exists()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a disabled item\'s reason where its shortcut would sit, undimmed and describing the item, at either level', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'r1', {
      kind: 'menu',
      label: 'Views and More Actions',
      anchor: ANCHOR,
      items: [
        { kind: 'item', id: 'pull', label: 'Pull', icon: 'arrow-down-to-line', shortcut: 'Ctrl+P', disabled: true, disabledReason: 'No remotes' },
        { kind: 'item', id: 'clone', label: 'Clone', icon: 'copy-plus', shortcut: 'Ctrl+K' },
        { kind: 'submenu', id: 'submenu:stash', label: 'Stash', icon: 'archive', items: [{ kind: 'item', id: 'stashPopLatest', label: 'Pop Latest Stash', icon: 'arrow-up-from-line', disabled: true, disabledReason: 'No stashes' }] },
      ],
    });
    const pull = wrapper.get('[data-item-id="pull"]');
    const reason = pull.get('[data-testid="overlay-menu-reason"]');
    expect(reason.text()).toBe('No remotes');
    // the reason takes the shortcut's place
    expect(pull.text()).not.toContain('Ctrl+P');
    expect(wrapper.get('[data-item-id="clone"]').text()).toContain('Ctrl+K');
    // the dimming is on the icon and label, never on the row or the reason
    expect(pull.classes()).not.toContain('opacity-50');
    expect(reason.classes()).not.toContain('opacity-50');
    expect(pull.findAll('.opacity-50').map((element) => element.element.tagName.toLowerCase())).toEqual(['svg', 'span']);
    expect(pull.get('span.opacity-50').text()).toBe('Pull');
    expect(reason.classes()).toContain('text-(--d-faint)');
    // described to assistive technology, still focusable and never chosen
    expect(pull.attributes('aria-disabled')).toBe('true');
    expect(pull.attributes('aria-describedby')).toBe(reason.attributes('id'));
    expect(wrapper.get(`#${pull.attributes('aria-describedby')!}`).text()).toBe('No remotes');
    expect(reason.attributes('aria-hidden')).toBe('true');
    expect(wrapper.get('[data-item-id="clone"]').attributes('aria-describedby')).toBeUndefined();
    expect(document.activeElement).toBe(pull.element);
    await pull.trigger('click');
    press('Enter');
    await flushPromises();
    expect(api.answer).not.toHaveBeenCalled();
    await pressNow('ArrowDown');
    await pressNow('ArrowDown');
    await pressNow('ArrowRight');
    const pop = submenu(wrapper).get('[data-item-id="stashPopLatest"]');
    expect(document.activeElement).toBe(pop.element);
    expect(pop.get('[data-testid="overlay-menu-reason"]').text()).toBe('No stashes');
    expect(wrapper.get(`#${pop.attributes('aria-describedby')!}`).text()).toBe('No stashes');
    expect(pop.classes()).not.toContain('opacity-50');
    await pressNow('Enter');
    expect(api.answer).not.toHaveBeenCalled();
  });

  it("filters over every submenu's leaves", async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'r1', { ...SUBMENUS, filterPlaceholder: 'Filter actions' });
    const filter = wrapper.get('[data-testid="overlay-menu-filter"]');
    await filter.setValue('amend');
    expect(wrapper.findAll('[data-menu-item]').map((item) => item.attributes('data-item-id'))).toEqual(['amend']);
    await filter.setValue('view');
    expect(wrapper.findAll('[data-menu-item]').map((item) => item.attributes('data-item-id'))).toEqual(['tree', 'list']);
    await filter.trigger('keydown', { key: 'Enter' });
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('r1', { kind: 'menu', itemId: 'tree' }));
  });
});

describe('quick picks main asks', () => {
  const PICK: OverlayRequest = {
    kind: 'quickPick',
    placeholder: 'Select a branch or tag to checkout',
    items: [
      { id: '0', label: 'Create new branch...', icon: 'add', alwaysShow: true, echoQuery: true },
      { id: '1', label: 'Create new branch from...', icon: 'add', alwaysShow: true, echoQuery: true },
      { id: '2', label: 'Checkout detached...', icon: 'detached', alwaysShow: true },
      { id: '3', label: 'feat/login', icon: 'branch', group: 'branches', description: 'abc1234 \u2022 subject' },
    ],
  };
  const row = (wrapper: VueWrapper, id: string) => wrapper.get(`[data-testid="quick-pick-item"][data-item-id="${id}"]`);

  it('echoes the trimmed filter text, quoted, on the create items as it is typed, without moving their rows', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'p1', PICK);
    expect(row(wrapper, '0').text()).toBe('Create new branch...');
    const height = row(wrapper, '0').attributes('style');
    const input = wrapper.get('[data-testid="quick-pick-input"]');
    await input.setValue('  fix/login ');
    await flushPromises();
    expect(row(wrapper, '0').text()).toContain('Create new branch...');
    expect(row(wrapper, '0').text()).toContain('\u201cfix/login\u201d');
    expect(row(wrapper, '1').text()).toContain('\u201cfix/login\u201d');
    // only an echoing item echoes
    expect(row(wrapper, '2').text()).toBe('Checkout detached...');
    expect(row(wrapper, '0').attributes('style')).toBe(height);
    await input.setValue('fix/log');
    await flushPromises();
    expect(row(wrapper, '0').text()).toContain('\u201cfix/log\u201d');
    await input.setValue('   ');
    await flushPromises();
    expect(row(wrapper, '0').text()).toBe('Create new branch...');
  });

  it('quotes the echo in Greek with guillemets', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    shellI18n.global.locale.value = 'el';
    await open(wrapper, 'p1', PICK);
    await wrapper.get('[data-testid="quick-pick-input"]').setValue('fix');
    await flushPromises();
    expect(row(wrapper, '0').text()).toContain('\u00abfix\u00bb');
  });

  it('answers the picked item with the filter text as typed, and limits the text to what main accepts', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'p1', PICK);
    const input = wrapper.get('[data-testid="quick-pick-input"]');
    expect(input.attributes('maxlength')).toBe(String(MAX_INPUT_VALUE_LENGTH));
    await input.setValue(' fix login');
    await flushPromises();
    await row(wrapper, '0').trigger('click');
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('p1', { kind: 'quickPick', itemId: '0', query: ' fix login' }));
  });

  // VS Code's quick pick names a group's first option with the separator's label, since the separator is presentational.
  it("names each group's first option with the group's label", async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'p1', {
      kind: 'quickPick',
      placeholder: 'Select a branch or tag to checkout',
      items: [
        { id: 'b1', label: 'v1', icon: 'branch', hint: 'local', group: 'branches' },
        { id: 'b2', label: 'main', icon: 'branch', description: 'abc1234 \u2022 subject', group: 'branches' },
        { id: 't1', label: 'v1', icon: 'tag', group: 'tags' },
      ],
    });
    expect(row(wrapper, 'b1').attributes('aria-label')).toBe('v1, local, branches');
    expect(row(wrapper, 'b2').attributes('aria-label')).toBe('main, abc1234 \u2022 subject');
    expect(row(wrapper, 't1').attributes('aria-label')).toBe('v1, tags');
  });
});

describe('a quick pick of many (Join Terminals...)', () => {
  const JOIN: OverlayRequest = {
    kind: 'quickPick',
    placeholder: 'Select the terminals to join',
    pickMany: { max: 2 },
    items: [
      { id: 'term-2', label: 'tests', glyph: 'cmd', description: 'alpha' },
      { id: 'term-3', label: 'logs', glyph: 'bash', description: 'alpha' },
      { id: 'term-4', label: 'build', glyph: 'cmd', description: 'beta' },
      { id: 'more', label: '2 more not shown', info: true },
    ],
  };
  const row = (wrapper: VueWrapper, id: string) => wrapper.get(`[data-testid="quick-pick-item"][data-item-id="${id}"]`);
  const input = (wrapper: VueWrapper) => wrapper.get('[data-testid="quick-pick-input"]');
  const list = (wrapper: VueWrapper) => wrapper.get('[data-testid="quick-pick-list"]');
  const ok = (wrapper: VueWrapper) => wrapper.get('[data-testid="quick-pick-ok"]');
  const key = (wrapper: VueWrapper, init: KeyboardEventInit) => input(wrapper).trigger('keydown', init);
  const listKey = (wrapper: VueWrapper, init: KeyboardEventInit) => list(wrapper).trigger('keydown', init);
  // the row the listbox names as active while it has keyboard focus
  const activeInList = (wrapper: VueWrapper) => wrapper.findAll('[data-testid="quick-pick-item"]').find((item) => item.attributes('id') === list(wrapper).attributes('aria-activedescendant'))?.attributes('data-item-id');

  it('draws checkbox rows in a multi-select listbox with a count of the checks, and an info row with neither', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'j1', JOIN);
    expect(list(wrapper).attributes('aria-multiselectable')).toBe('true');
    expect(row(wrapper, 'term-2').attributes('aria-checked')).toBe('false');
    expect(row(wrapper, 'term-2').find('[data-testid="quick-pick-checkbox"]').exists()).toBe(true);
    expect(row(wrapper, 'more').attributes('aria-checked')).toBeUndefined();
    expect(row(wrapper, 'more').find('[data-testid="quick-pick-checkbox"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="quick-pick-count"]').text()).toBe('0 of 2 selected');
    expect(wrapper.get('[data-testid="quick-pick-hint"]').text()).toBe('Down Arrow moves into the list, Space or a click checks a row, Enter or OK accepts');
  });

  // In a multi-select listbox aria-selected means "in the selection"; the checks are aria-checked, the active row aria-activedescendant.
  it('marks no option aria-selected, before or after the keyboard enters the list', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'j1', JOIN);
    const selected = () => wrapper.findAll('[data-testid="quick-pick-item"]').filter((item) => item.attributes('aria-selected') !== undefined);
    expect(selected()).toEqual([]);
    await key(wrapper, { key: 'ArrowDown' });
    await listKey(wrapper, { key: ' ' });
    expect(selected()).toEqual([]);
    expect(input(wrapper).attributes('aria-activedescendant')).toBeUndefined();
  });

  it('moves into the list on Down Arrow, where Space checks the active row, and answers the checks in the request order on Enter', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'j1', JOIN);
    await key(wrapper, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(list(wrapper).element);
    expect(list(wrapper).attributes('tabindex')).toBe('-1');
    expect(activeInList(wrapper)).toBe('term-2');
    await listKey(wrapper, { key: 'ArrowDown' });
    expect(activeInList(wrapper)).toBe('term-3');
    await listKey(wrapper, { key: ' ' });
    expect(row(wrapper, 'term-3').attributes('aria-checked')).toBe('true');
    expect(row(wrapper, 'term-3').get('[data-testid="quick-pick-checkbox"]').attributes('data-checked')).toBe('true');
    await row(wrapper, 'term-2').trigger('click');
    await row(wrapper, 'term-2').trigger('click');
    await row(wrapper, 'term-2').trigger('click');
    expect(wrapper.get('[data-testid="quick-pick-count"]').text()).toBe('2 of 2 selected');
    expect(api.answer).not.toHaveBeenCalled();
    await listKey(wrapper, { key: 'Enter' });
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('j1', { kind: 'quickPickMany', itemIds: ['term-2', 'term-3'] }));
  });

  it('checks no more than max, never an info row, and accepts the list\'s active row alone while none is checked', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'j1', JOIN);
    await row(wrapper, 'more').trigger('click');
    expect(row(wrapper, 'more').attributes('aria-checked')).toBeUndefined();
    await row(wrapper, 'term-2').trigger('click');
    await row(wrapper, 'term-3').trigger('click');
    await row(wrapper, 'term-4').trigger('click');
    expect(row(wrapper, 'term-4').attributes('aria-checked')).toBe('false');
    expect(row(wrapper, 'term-4').attributes('aria-disabled')).toBe('true');
    expect(row(wrapper, 'term-4').classes()).toContain('cursor-not-allowed');
    await row(wrapper, 'term-3').trigger('click');
    expect(row(wrapper, 'term-4').attributes('aria-disabled')).toBeUndefined();
    await row(wrapper, 'term-2').trigger('click');
    // with none checked, Enter in the field has no row to take
    await key(wrapper, { key: 'Enter' });
    expect(api.answer).not.toHaveBeenCalled();
    await key(wrapper, { key: 'ArrowDown' });
    await listKey(wrapper, { key: 'ArrowDown' });
    await listKey(wrapper, { key: 'ArrowDown' });
    await listKey(wrapper, { key: 'Enter' });
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('j1', { kind: 'quickPickMany', itemIds: ['term-4'] }));
  });

  it('keeps the checks while filtering, where Space types, and returns to the field past the list\'s ends or on a typed key', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'j1', JOIN);
    await row(wrapper, 'term-2').trigger('click');
    await input(wrapper).setValue('build');
    await flushPromises();
    expect(wrapper.findAll('[data-testid="quick-pick-item"]').map((item) => item.attributes('data-item-id'))).toEqual(['term-4']);
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    input(wrapper).element.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(false);
    expect(row(wrapper, 'term-4').attributes('aria-checked')).toBe('false');
    await key(wrapper, { key: 'ArrowDown' });
    await listKey(wrapper, { key: ' ' });
    expect(row(wrapper, 'term-4').attributes('aria-checked')).toBe('true');
    await listKey(wrapper, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(input(wrapper).element);
    expect(list(wrapper).attributes('aria-activedescendant')).toBeUndefined();
    await key(wrapper, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(list(wrapper).element);
    const typed = new KeyboardEvent('keydown', { key: 'u', bubbles: true, cancelable: true });
    list(wrapper).element.dispatchEvent(typed);
    expect(typed.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input(wrapper).element);
    await input(wrapper).setValue('');
    await flushPromises();
    expect(row(wrapper, 'term-2').attributes('aria-checked')).toBe('true');
    await key(wrapper, { key: 'Enter' });
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('j1', { kind: 'quickPickMany', itemIds: ['term-2', 'term-4'] }));
  });

  // VS Code's canSelectMany OK button: a pointer alone completes the pick, and Tab reaches it from the field.
  it('accepts the checks with OK, enabled while a row is checked, which Tab reaches and leaves', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'j1', JOIN);
    expect(ok(wrapper).text()).toBe('OK');
    expect(ok(wrapper).attributes('disabled')).toBeDefined();
    expect(ok(wrapper).attributes('aria-describedby')).toBe(wrapper.get('[data-testid="quick-pick-count"]').attributes('id'));
    await key(wrapper, { key: 'Tab' });
    expect(document.activeElement).toBe(input(wrapper).element);
    await row(wrapper, 'term-3').trigger('click');
    expect(ok(wrapper).attributes('disabled')).toBeUndefined();
    await key(wrapper, { key: 'Tab' });
    expect(document.activeElement).toBe(ok(wrapper).element);
    await ok(wrapper).trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(input(wrapper).element);
    await ok(wrapper).trigger('click');
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('j1', { kind: 'quickPickMany', itemIds: ['term-3'] }));
  });

  it('dismisses on Escape from the field, the list or OK', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'j1', JOIN);
    await key(wrapper, { key: 'Escape' });
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('j1', { kind: 'dismissed' }));
    await open(wrapper, 'j2', JOIN);
    await key(wrapper, { key: 'ArrowDown' });
    await listKey(wrapper, { key: 'Escape' });
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('j2', { kind: 'dismissed' }));
    await open(wrapper, 'j3', JOIN);
    await row(wrapper, 'term-2').trigger('click');
    await ok(wrapper).trigger('keydown', { key: 'Escape' });
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('j3', { kind: 'dismissed' }));
  });
});

describe('an input box\'s folder button', () => {
  const BOX: OverlayRequest = { kind: 'input', prompt: 'Please provide a worktree path', placeholder: 'Worktree path', value: '/r.worktrees/wt', valueSelection: [13, 15], browse: { tooltip: 'Select Worktree Destination' } };

  it('asks main through browseInput and applies the value and selection it answers, returning focus to the field', async () => {
    vi.mocked(api.browseInput).mockResolvedValueOnce(opened({ value: '/picked/wt', valueSelection: [8, 10] }));
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'b1', BOX);
    const button = wrapper.get('[data-testid="quick-input-browse"]');
    expect(button.attributes('aria-label')).toBe('Select Worktree Destination');
    await button.trigger('click');
    await flushPromises();
    expect(api.browseInput).toHaveBeenCalledWith('/r.worktrees/wt');
    const field = wrapper.get<HTMLInputElement>('[data-testid="quick-input-field"]').element;
    expect(field.value).toBe('/picked/wt');
    expect([field.selectionStart, field.selectionEnd]).toEqual([8, 10]);
    expect(document.activeElement).toBe(field);
  });

  it('shows no folder button for a box main gave none', async () => {
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'b1', { kind: 'input', prompt: 'Name' });
    expect(wrapper.find('[data-testid="quick-input-browse"]').exists()).toBe(false);
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
    expect(api.resolveToast).toHaveBeenCalledWith('t5', 0);
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

  it('relabels a showing toast main sends again under its id in place, without a second toast or a second announcement', async () => {
    const wrapper = mountNotifier();
    await flushPromises();
    const polite = wrapper.get('[data-testid="overlay-toasts-polite"]');
    api.toast(notice('n', 'info', 'Connected to prod', []));
    api.toast(notice('m', 'info', 'other', []));
    await flushPromises();
    api.toast(notice('n', 'info', 'Connected to prod-1', []));
    await flushPromises();
    const toasts = wrapper.findAll('[data-testid="overlay-toast"]');
    expect(toasts.map((toast) => toast.attributes('data-toast-id'))).toEqual(['n', 'm']);
    expect(toasts[0]!.text()).toContain('Connected to prod-1');
    expect(polite.findAll('p').map((node) => node.text())).toEqual(['Information: Connected to prod', 'Information: other']);
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

  it('keeps focus in the field when anything else in the picker is pressed, so the keyboard still drives it', async () => {
    api.commands.list = COMMANDS;
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'p1', { kind: 'quickOpen', mode: 'commands' });
    for (const part of ['[data-testid="quick-pick"]', '[data-testid="quick-pick-list"]', '[data-quick-pick-item]']) {
      const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      wrapper.get(part).element.dispatchEvent(press);
      expect(press.defaultPrevented, part).toBe(true);
    }
    const inField = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    wrapper.get('[data-testid="quick-pick-input"]').element.dispatchEvent(inField);
    expect(inField.defaultPrevented).toBe(false);
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
      kind: 'project' as const, projectKey: 'api-key', projectName: 'api', relativePath, label: relativePath.split('/').at(-1)!, description: 'src/routes', labelMatches: [], descriptionMatches: [], recent: false,
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
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('q1', { kind: 'quickOpen', pick: { kind: 'project', projectKey: 'api-key', relativePath: 'src/routes/users.ts', mention: false } }));

    // Greek labels the scope too, and the next request without one is plain Quick Open again.
    shellI18n.global.locale.value = 'el';
    await open(wrapper, 'q2', { kind: 'quickOpen', mode: 'files', scope: { projectKey: 'api-key', projectName: 'api', folder: '' } });
    expect(wrapper.get('[data-testid="quick-pick-input"]').attributes('aria-label')).toBe('Μετάβαση σε αρχείο στο api');
    shellI18n.global.locale.value = 'en';
  });

  it('picks from the answer to the newest query when an older answer lands last', async () => {
    const result = { kind: 'project' as const, projectKey: 'web-key', projectName: 'web', relativePath: 'src/foo.ts', label: 'foo.ts', description: 'src', labelMatches: [], descriptionMatches: [], recent: false };
    const late: Array<() => void> = [];
    vi.mocked(api.queryQuickOpen).mockImplementation((query) => new Promise((resolve) => {
      const answer = opened({ generation: query.generation, mention: false, results: [result], ...(query.query === 'foo:12' ? { line: 12 } : {}) });
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
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('q1', { kind: 'quickOpen', pick: { kind: 'project', projectKey: 'web-key', relativePath: 'src/foo.ts', mention: false } }));
  });

  it('shows a typed path as its only row with the host chip, and picks it by authority and path at the line and column', async () => {
    // mention: a path row never mentions, whatever main parsed
    api.quickOpen.answer = (query) => ({
      generation: query.generation, mention: true, line: 3, column: 5,
      results: [{ kind: 'path', authority: 'ssh-remote+box', path: '/home/u/a.txt', label: 'a.txt', description: '/home/u', labelMatches: [[0, 5]], descriptionMatches: [[0, 7]], host: 'box', recent: false }],
    });
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'q1', { kind: 'quickOpen', mode: 'files' });
    await type(wrapper, '/home/u/a.txt:3:5');
    const items = wrapper.findAll('[data-testid="quick-pick-item"]');
    expect(items).toHaveLength(1);
    expect(items[0]!.text()).toContain('a.txt');
    expect(items[0]!.text()).toContain('/home/u');
    expect(items[0]!.get('[data-testid="quick-pick-badge"]').text()).toBe('box');
    expect(items[0]!.find('img, svg').exists()).toBe(true);
    press('Enter');
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('q1', { kind: 'quickOpen', pick: { kind: 'path', authority: 'ssh-remote+box', path: '/home/u/a.txt', line: 3, column: 5, mention: false } }));
  });

  it('shows the text results until main brings the typed path it resolved after them, then picks that path at the line and column', async () => {
    const typed = '/home/u/a.txt:3:5';
    const text = { kind: 'project' as const, projectKey: 'web-key', projectName: 'web', relativePath: 'src/a.txt', label: 'a.txt', description: 'src', labelMatches: [], descriptionMatches: [], recent: false };
    const row = { kind: 'path' as const, authority: 'ssh-remote+box', path: '/home/u/a.txt', label: 'a.txt', description: '/home/u', labelMatches: [[0, 5]] as const, descriptionMatches: [[0, 7]] as const, host: 'box', recent: false as const };
    api.quickOpen.answer = (query) => ({ generation: query.generation, mention: false, line: 3, column: 5, results: [text], ...(query.query === typed ? { pathPending: true as const } : {}) });
    let bring: (() => void) | undefined;
    vi.mocked(api.quickOpenPath).mockImplementation((generation) => new Promise((resolve) => {
      bring = () => resolve(opened({ generation, mention: false, line: 3, column: 5, results: [row] }));
    }));
    const wrapper = mountOverlay();
    await flushPromises();
    await open(wrapper, 'q1', { kind: 'quickOpen', mode: 'files' });
    await type(wrapper, typed);
    const shown = (): string[] => wrapper.findAll('[data-testid="quick-pick-item"]').map((item) => item.text());
    expect(shown()).toEqual([expect.stringContaining('src')]);
    expect(wrapper.get('[data-testid="quick-pick-hint"]').text()).toBe('Enter opens the file at line 3, column 5');
    expect(api.quickOpenPath).toHaveBeenCalledTimes(1);
    bring!();
    await flushPromises();
    expect(shown()).toEqual([expect.stringContaining('/home/u')]);
    press('Enter');
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('q1', { kind: 'quickOpen', pick: { kind: 'path', authority: 'ssh-remote+box', path: '/home/u/a.txt', line: 3, column: 5, mention: false } }));
  });

  it('keeps the list it shows when a query or the command list answers closed, with no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      const result = { kind: 'project' as const, projectKey: 'web-key', projectName: 'web', relativePath: 'src/foo.ts', label: 'foo.ts', description: 'src', labelMatches: [], descriptionMatches: [], recent: false };
      api.quickOpen.answer = (query) => ({ generation: query.generation, mention: false, results: [result] });
      const wrapper = mountOverlay();
      await flushPromises();
      await open(wrapper, 'q1', { kind: 'quickOpen', mode: 'files' });
      expect(wrapper.findAll('[data-testid="quick-pick-item"]')).toHaveLength(1);

      vi.mocked(api.queryQuickOpen).mockResolvedValueOnce({ ok: false, reason: 'closed' });
      await type(wrapper, 'fo');
      expect(wrapper.findAll('[data-testid="quick-pick-item"]')).toHaveLength(1);
      expect(wrapper.find('[data-testid="quick-pick-empty"]').exists()).toBe(false);

      vi.mocked(api.listCommands).mockResolvedValueOnce({ ok: false, reason: 'closed' });
      await type(wrapper, '>');
      expect(wrapper.find('[data-testid="quick-pick-empty"]').exists()).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  it('says the files or commands could not load, never that nothing matched, when a query or the command list fails', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      api.commands.list = COMMANDS;
      vi.mocked(api.queryQuickOpen).mockRejectedValueOnce(new Error('Malformed Quick Open query'));
      const wrapper = mountOverlay();
      const failed = (): string | undefined => {
        const notice = wrapper.find('[data-testid="quick-pick-failed"]');
        return notice.exists() ? notice.text() : undefined;
      };
      await flushPromises();
      await open(wrapper, 'q1', { kind: 'quickOpen', mode: 'files' });
      expect(wrapper.find('[data-testid="quick-pick-empty"]').exists()).toBe(false);
      expect(failed()).toBe('Damocles could not search the files.');

      // Main's index answers failed when its worker failed.
      api.quickOpen.answer = (query) => ({ generation: query.generation, mention: false, results: [], failed: true });
      await type(wrapper, 'fo');
      expect(wrapper.find('[data-testid="quick-pick-empty"]').exists()).toBe(false);
      expect(failed()).toBe('Damocles could not search the files.');

      vi.mocked(api.listCommands).mockRejectedValueOnce(new Error('no commands'));
      await type(wrapper, '>');
      expect(wrapper.find('[data-testid="quick-pick-empty"]').exists()).toBe(false);
      expect(failed()).toBe('The commands could not load.');
      // A failed list is not kept: the next palette query asks again.
      await type(wrapper, '>c');
      expect(failed()).toBeUndefined();
      expect(wrapper.find('[data-item-id="damocles.chat.contextUsage"]').exists()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  describe('a typed folder', () => {
    const folder = (input: string, label: string, caret?: number): QuickOpenFolderResult => ({
      kind: 'folder', authority: 'local', label, labelMatches: [], input, ...(caret === undefined ? {} : { caret }),
    });
    const file = (name: string, complete: QuickOpenCompletion): QuickOpenPathResult => ({
      kind: 'path', authority: 'local', path: `C:\\tmp\\${name}`, label: name, description: 'C:\\tmp', labelMatches: [], descriptionMatches: [], recent: false, complete,
    });
    const LISTING: readonly QuickOpenResult[] = [
      folder('C:\\', '..'),
      folder('C:\\tmp\\src\\', 'src'),
      folder('"C:\\tmp\\ spaced\\"', ' spaced', 16),
      file('a.txt', { input: 'C:\\tmp\\a.txt' }),
      file('ab (2).txt', { input: '"C:\\tmp\\ab (2).txt"', caret: 18 }),
    ];
    const listing = (extra: Partial<QuickOpenResponse> = {}) => (query: QuickOpenQuery): QuickOpenResponse => ({ generation: query.generation, mention: false, results: LISTING, ...extra });
    const field = (wrapper: VueWrapper): HTMLInputElement => wrapper.get('[data-testid="quick-pick-input"]').element as HTMLInputElement;
    const queries = (): string[] => vi.mocked(api.queryQuickOpen).mock.calls.map(([query]) => query.query);
    // by attribute value, since a CSS selector would read the keys' backslashes as escapes
    const rowOf = (wrapper: VueWrapper, result: QuickOpenResult) => wrapper.findAll('[data-testid="quick-pick-item"]').find((row) => row.attributes('data-item-id') === quickOpenRowKey(result))!;

    async function typed(answer: (query: QuickOpenQuery) => QuickOpenResponse, query = 'C:\\tmp\\'): Promise<VueWrapper> {
      api.quickOpen.answer = answer;
      const wrapper = mountOverlay();
      await flushPromises();
      await open(wrapper, 'q1', { kind: 'quickOpen', mode: 'files' });
      await type(wrapper, query);
      return wrapper;
    }

    it('starts on the first entry after .., which Enter goes into, and on .. only when the folder lists nothing else', async () => {
      const wrapper = await typed(listing());
      const input = wrapper.get('[data-testid="quick-pick-input"]');
      const src = rowOf(wrapper, LISTING[1]!);
      expect(src.attributes('aria-selected')).toBe('true');
      expect(rowOf(wrapper, LISTING[0]!).attributes('aria-selected')).toBe('false');
      expect(input.attributes('aria-activedescendant')).toBe(src.attributes('id'));
      // a pointer resting where the list opened leaves the first entry active; one that moves onto .. takes it
      const hover = async (screenX: number): Promise<void> => {
        rowOf(wrapper, LISTING[0]!).element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, screenX, screenY: 4 }));
        await flushPromises();
      };
      await hover(4);
      await hover(4);
      expect(src.attributes('aria-selected')).toBe('true');
      await hover(8);
      expect(rowOf(wrapper, LISTING[0]!).attributes('aria-selected')).toBe('true');
      expect(input.attributes('aria-activedescendant')).toBe(rowOf(wrapper, LISTING[0]!).attributes('id'));

      api.quickOpen.answer = (query) => ({ generation: query.generation, mention: false, results: [LISTING[0]!] });
      await type(wrapper, 'C:\\tmp\\empty\\');
      const up = rowOf(wrapper, LISTING[0]!);
      expect(up.attributes('aria-selected')).toBe('true');
      expect(input.attributes('aria-activedescendant')).toBe(up.attributes('id'));
      press('Enter');
      await flushPromises();
      expect(field(wrapper).value).toBe('C:\\');
      expect(api.answer).not.toHaveBeenCalled();
    });

    it('goes into a folder on Enter or a click, setting the query and caret main built, and answers nothing', async () => {
      const wrapper = await typed(listing());
      press('Enter');
      await flushPromises();
      expect(field(wrapper).value).toBe('C:\\tmp\\src\\');
      expect(field(wrapper).selectionStart).toBe('C:\\tmp\\src\\'.length);
      expect(queries().at(-1)).toBe('C:\\tmp\\src\\');
      const slides = (name: string): boolean => rowOf(wrapper, LISTING[1]!).classes().some((css) => css.startsWith(`animate-[${name}_`));
      // the folder's rows slide in from the end going down, from the start going up
      expect(slides('d-pane-in')).toBe(true);

      await rowOf(wrapper, LISTING[2]!).trigger('click');
      await flushPromises();
      expect(field(wrapper).value).toBe('"C:\\tmp\\ spaced\\"');
      expect([field(wrapper).selectionStart, field(wrapper).selectionEnd]).toEqual([16, 16]);
      // Shift+Enter on a folder goes into it too: a folder is never a pick
      press('ArrowUp');
      press('Enter', { shiftKey: true });
      await flushPromises();
      expect(field(wrapper).value).toBe('C:\\');
      expect(slides('d-slide')).toBe(true);
      expect(document.activeElement).toBe(field(wrapper));
      expect(api.answer).not.toHaveBeenCalled();
    });

    it('slides in only the rows a folder\'s entry rendered before the list scrolled', async () => {
      const many = Array.from({ length: 200 }, (_, i) => file(`f${String(i).padStart(3, '0')}.txt`, { input: `C:\\tmp\\f${i}.txt` }));
      const wrapper = await typed((query) => (query.query === 'C:\\tmp\\src\\' ? { generation: query.generation, mention: false, results: many } : listing()(query)));
      const slides = (result: QuickOpenResult): boolean => rowOf(wrapper, result).classes().some((css) => css.startsWith('animate-[d-pane-in_'));
      press('Enter');
      await flushPromises();
      expect(slides(many[0]!)).toBe(true);
      const list = wrapper.get('[data-testid="quick-pick-list"]').element;
      list.scrollTop = 150 * 28;
      list.dispatchEvent(new Event('scroll'));
      await flushPromises();
      expect(slides(many[150]!)).toBe(false);
    });

    it('completes the active row on Tab, a file to its path and a folder to the query going into it, never moving focus', async () => {
      const wrapper = await typed(listing());
      const tab = (shiftKey = false): KeyboardEvent => {
        const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
        field(wrapper).dispatchEvent(event);
        return event;
      };
      // the first entry after .. is active from the start
      expect(tab().defaultPrevented).toBe(true);
      await flushPromises();
      expect(field(wrapper).value).toBe('C:\\tmp\\src\\');

      for (let i = 0; i < 3; i++) press('ArrowDown');
      await flushPromises();
      expect(tab().defaultPrevented).toBe(true);
      await flushPromises();
      expect(field(wrapper).value).toBe('"C:\\tmp\\ab (2).txt"');
      expect(field(wrapper).selectionStart).toBe(18);
      expect(document.activeElement).toBe(field(wrapper));

      // Shift+Tab neither completes nor leaves the field
      expect(tab(true).defaultPrevented).toBe(true);
      await flushPromises();
      expect(field(wrapper).value).toBe('"C:\\tmp\\ab (2).txt"');
      expect(document.activeElement).toBe(field(wrapper));
      expect(api.answer).not.toHaveBeenCalled();
    });

    it('opens the typed file on Enter at the line and column main parsed, which no other row of the listing takes', async () => {
      const exact: QuickOpenPathResult = { ...file('a.txt', { input: 'C:\\tmp\\a.txt' }), exact: true };
      const sibling = file('a.txt.bak', { input: 'C:\\tmp\\a.txt.bak' });
      const answer = (query: QuickOpenQuery): QuickOpenResponse => ({ generation: query.generation, mention: false, line: 2, column: 4, results: [exact, sibling] });
      const wrapper = await typed(answer, 'C:\\tmp\\a.txt:2:4');
      press('Enter');
      await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('q1', { kind: 'quickOpen', pick: { kind: 'path', authority: 'local', path: 'C:\\tmp\\a.txt', line: 2, column: 4, mention: false } }));
      wrapper.unmount();
      mounted.splice(mounted.indexOf(wrapper), 1);

      vi.mocked(api.answer).mockClear();
      await typed(answer, 'C:\\tmp\\a.txt:2:4');
      press('ArrowDown');
      press('Enter');
      await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('q1', { kind: 'quickOpen', pick: { kind: 'path', authority: 'local', path: 'C:\\tmp\\a.txt.bak', mention: false } }));
    });

    it('draws a folder with its folder icon and names it a folder, ids each row by main\'s key, and notes a cut listing beside the line hint', async () => {
      const wrapper = await typed(listing({ line: 2, truncated: { listed: 4 } }));
      const rows = wrapper.findAll('[data-testid="quick-pick-item"]');
      expect(rows.map((row) => row.attributes('data-item-id'))).toEqual(LISTING.map(quickOpenRowKey));
      expect(rows.map((row) => row.attributes('aria-label'))).toEqual(['.., folder', 'src, folder', ' spaced, folder', 'a.txt, C:\\tmp', 'ab (2).txt, C:\\tmp']);
      expect(rows.map((row) => row.get('[data-testid="quick-pick-file-icon"]').attributes('data-directory'))).toEqual(['true', 'true', 'true', undefined, undefined]);
      expect(wrapper.get('[data-testid="quick-pick-hint"]').text()).toBe('Enter opens the file at line 2 · Showing the first 4 entries. Type more of a name to narrow the list.');

      api.quickOpen.answer = listing({ truncated: { listed: 4 } });
      await type(wrapper, 'C:\\tmp\\a');
      // the line hint swaps out before the notice stands alone
      await vi.waitFor(() => expect(wrapper.findAll('[data-testid="quick-pick-hint"]')).toHaveLength(1));
      const hint = wrapper.get('[data-testid="quick-pick-hint"]');
      expect(hint.text()).toBe('Showing the first 4 entries. Type more of a name to narrow the list.');
      api.quickOpen.answer = listing({ truncated: { listed: 1 } });
      await type(wrapper, 'C:\\tmp\\ab');
      await vi.waitFor(() => expect(wrapper.get('[data-testid="quick-pick-hint"]').text()).toBe('Showing the first entry. Type more of a name to narrow the list.'));
      // the Enter glyph marks only what Enter does
      expect(hint.find('svg').exists()).toBe(false);
    });

    it('says no entry starts with the typed name, or that the folder cannot be read, in either language', async () => {
      const wrapper = await typed((query) => ({ generation: query.generation, mention: false, results: [], emptyText: 'folderNoMatch', emptyName: 'zzz' }), 'C:\\tmp\\zzz');
      const empty = (): string => wrapper.get('[data-testid="quick-pick-empty"]').text();
      expect(empty()).toBe("No entries here start with 'zzz'.");
      api.quickOpen.answer = (query) => ({ generation: query.generation, mention: false, results: [], emptyText: 'folderDenied' });
      await type(wrapper, 'C:\\locked\\');
      expect(empty()).toBe("Damocles can't read this folder.");
      shellI18n.global.locale.value = 'el';
      await type(wrapper, 'C:\\locked\\a');
      expect(empty()).toBe('Το Damocles δεν μπορεί να διαβάσει αυτόν τον φάκελο.');
      api.quickOpen.answer = (query) => ({ generation: query.generation, mention: false, results: [], emptyText: 'folderNoMatch', emptyName: 'zzz' });
      await type(wrapper, 'C:\\tmp\\zzz');
      expect(empty()).toBe('Καμία καταχώριση εδώ δεν ξεκινά με «zzz».');
      shellI18n.global.locale.value = 'en';
    });

    it('says a folder with no parent has no entries, in either language, naming no typed name', async () => {
      const wrapper = await typed((query) => ({ generation: query.generation, mention: false, results: [], emptyText: 'folderEmpty' }), 'E:\\');
      const empty = (): string => wrapper.get('[data-testid="quick-pick-empty"]').text();
      expect(empty()).toBe('This folder has no entries to show.');
      shellI18n.global.locale.value = 'el';
      await type(wrapper, 'F:\\');
      expect(empty()).toBe('Αυτός ο φάκελος δεν έχει καταχωρίσεις για εμφάνιση.');
      shellI18n.global.locale.value = 'en';
    });

    it('says the host stopped reading a folder before it kept an entry, in place of a count of none', async () => {
      const stopped = 'Damocles stopped reading this folder before it found an entry to show. Type a file\'s full name to open it.';
      const wrapper = await typed((query) => ({ generation: query.generation, mention: false, results: [], truncated: { listed: 0 } }), 'C:\\big\\x');
      expect(wrapper.get('[data-testid="quick-pick-empty"]').text()).toBe(stopped);
      expect(wrapper.find('[data-testid="quick-pick-hint"]').exists()).toBe(false);
      // with only .. listed, the note stands beside it
      api.quickOpen.answer = (query) => ({ generation: query.generation, mention: false, results: [LISTING[0]!], truncated: { listed: 0 } });
      await type(wrapper, 'C:\\big\\');
      await vi.waitFor(() => expect(wrapper.get('[data-testid="quick-pick-hint"]').text()).toBe(stopped));
      expect(wrapper.find('[data-testid="quick-pick-empty"]').exists()).toBe(false);
    });

    it('keeps the arrow keys and Enter working over a listing of a thousand rows, rendering only those in view', async () => {
      const many = Array.from({ length: MAX_QUICK_OPEN_LISTING_RESULTS }, (_, i) => file(`f${String(i).padStart(4, '0')}.txt`, { input: `C:\\tmp\\f${i}.txt` }));
      const wrapper = await typed((query) => ({ generation: query.generation, mention: false, results: many, truncated: { listed: many.length } }));
      expect(wrapper.findAll('[data-testid="quick-pick-item"]').length).toBeLessThan(100);
      const input = wrapper.get('[data-testid="quick-pick-input"]');
      // ArrowUp from the first row wraps to the last, which the list scrolls to and renders
      press('ArrowUp');
      wrapper.get('[data-testid="quick-pick-list"]').element.dispatchEvent(new Event('scroll'));
      await flushPromises();
      const last = rowOf(wrapper, many.at(-1)!);
      expect(last.attributes('aria-selected')).toBe('true');
      expect(input.attributes('aria-activedescendant')).toBe(last.attributes('id'));
      expect(wrapper.get('[data-testid="quick-pick-hint"]').text()).toBe('Showing the first 1,000 entries. Type more of a name to narrow the list.');
      press('Enter');
      await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('q1', { kind: 'quickOpen', pick: { kind: 'path', authority: 'local', path: 'C:\\tmp\\f0999.txt', mention: false } }));
    });
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
