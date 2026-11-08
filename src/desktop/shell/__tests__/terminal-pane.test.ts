// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { computed, defineComponent, h, inject, nextTick, shallowRef } from 'vue';
import type { TerminalInfo, TerminalState } from '../../preload/terminal-channels';
import TerminalPane from '../layout/TerminalPane.vue';
import TerminalPanel from '../terminal/TerminalPanel.vue';
import { endTerminalDrag, startTerminalDrag, TERMINAL_DRAG_MIME } from '../terminal/terminal-drag';
import { TERMINAL_STORE, type TerminalStore } from '../terminal/terminal-store';
import { shellI18n } from '../i18n';
import { STATE, TERMINAL_STATE, fakeShellApi } from './fakes';

const info = (id: string, title: string): TerminalInfo => ({
  id, title, name: null, profileId: 'pwsh', icon: 'powershell', customIcon: null, color: null, projectKey: 'alpha', projectName: 'alpha', status: 'running', exitCode: null, description: null, running: null, integrated: false, restoring: false, windowsBuild: null, pathFlavor: 'posix', placement: 'panel',
});

function fakeStore(state: TerminalState): TerminalStore {
  const current = shallowRef<TerminalState | null>(state);
  return {
    state: current,
    active: computed(() => current.value?.terminals.find((t) => t.id === current.value?.activeId) ?? null),
    focusRequest: shallowRef(null),
    renaming: shallowRef(null),
    requestFocus: vi.fn(),
    move: vi.fn(),
    moved: shallowRef(null),
    attach: () => () => undefined,
    start: async () => undefined,
  } as unknown as TerminalStore;
}

let wrapper: VueWrapper | undefined;
afterEach(() => wrapper?.unmount());

// Each terminal's xterm input, as TerminalPanel's views hold them.
const PanelStub = defineComponent({
  setup() {
    const store = inject(TERMINAL_STORE)!;
    return () => h('div', (store.state.value?.terminals ?? []).map((terminal) => h('div', { 'data-terminal-id': terminal.id }, [h('textarea', { class: 'xterm-helper-textarea' })])));
  },
});

describe('focus when a terminal is killed', () => {
  const groups = (ids: string[]) => ids.map((id, index) => ({ id: `group-${index}`, paneIds: [id], activePaneId: id, sizes: [1] }));
  const twoTerminals = { ...TERMINAL_STATE, terminals: [info('term-1', 'one'), info('term-2', 'two')], groups: groups(['term-1', 'term-2']), activeId: 'term-1' };

  function mountPane(): TerminalStore {
    const store = fakeStore(twoTerminals);
    wrapper = mount(TerminalPane, {
      props: { api: fakeShellApi(), state: STATE, maximized: false, hideShortcut: 'Ctrl+`' },
      global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: store }, stubs: { transition: true, TerminalPanel: PanelStub, PaneGrip: true } },
      attachTo: document.body,
    });
    return store;
  }

  // VS Code focuses the group's new active pane; the kill was the user's own action.
  it('moves focus to the new active terminal when it was in the killed one', async () => {
    const store = mountPane();
    (wrapper!.get('[data-terminal-id="term-1"] textarea').element as HTMLElement).focus();
    store.state.value = { ...TERMINAL_STATE, terminals: [info('term-2', 'two')], groups: groups(['term-2']), activeId: 'term-2' };
    await nextTick();
    expect(store.requestFocus).toHaveBeenCalledWith('term-2');
  });

  it('leaves focus alone when it was elsewhere in the pane or the killed terminal was another one', async () => {
    const store = mountPane();
    (wrapper!.get('[data-testid="terminal-maximize"]').element as HTMLElement).focus();
    store.state.value = { ...TERMINAL_STATE, terminals: [info('term-2', 'two')], groups: groups(['term-2']), activeId: 'term-2' };
    await nextTick();
    (wrapper!.get('[data-terminal-id="term-2"] textarea').element as HTMLElement).focus();
    store.state.value = { ...TERMINAL_STATE, terminals: [info('term-2', 'two'), info('term-3', 'three')], groups: groups(['term-2', 'term-3']), activeId: 'term-3' };
    await nextTick();
    store.state.value = { ...TERMINAL_STATE, terminals: [info('term-2', 'two')], groups: groups(['term-2']), activeId: 'term-2' };
    await nextTick();
    expect(store.requestFocus).not.toHaveBeenCalled();
  });
});

describe('terminal pane header', () => {
  // Switching terminals updates the header in place; only the change between one tab and the summary animates.
  it('keeps the same summary element when the active terminal changes', async () => {
    const terminals = [info('term-1', 'PowerShell'), info('term-2', 'Ubuntu-24.04')];
    const store = fakeStore({ ...TERMINAL_STATE, terminals, activeId: 'term-1' });
    wrapper = mount(TerminalPane, {
      props: { api: fakeShellApi(), state: STATE, maximized: false, hideShortcut: 'Ctrl+`' },
      global: {
        plugins: [shellI18n],
        provide: { [TERMINAL_STORE as symbol]: store },
        stubs: { transition: true, TerminalPanel: true, PaneGrip: true },
      },
    });
    const before = wrapper.get('[data-testid="terminal-summary"]').element;
    expect(before.textContent).toContain('PowerShell');

    store.state.value = { ...TERMINAL_STATE, terminals, activeId: 'term-2' };
    await wrapper.vm.$nextTick();

    const after = wrapper.get('[data-testid="terminal-summary"]').element;
    expect(after.textContent).toContain('Ubuntu-24.04');
    expect(after).toBe(before);
  });
  it('names a home folder terminal\'s place, and says New Terminal starts in the home folder while no project is open', () => {
    const home = { ...info('term-1', 'PowerShell'), projectKey: null, projectName: '' };
    const store = fakeStore({ ...TERMINAL_STATE, terminals: [home], groups: [{ id: 'group-1', paneIds: ['term-1'], activePaneId: 'term-1', sizes: [1] }], activeId: 'term-1' });
    wrapper = mount(TerminalPane, {
      props: { api: fakeShellApi(), state: { ...STATE, projects: [] }, maximized: false, hideShortcut: 'Ctrl+`' },
      global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: store }, stubs: { transition: true, TerminalPanel: true, PaneGrip: true } },
    });
    expect(wrapper.get('[data-testid="terminal-tab-project"]').text()).toBe('Home folder');
    expect(wrapper.get('[data-testid="terminal-tab"]').attributes('aria-label')).toBe('PowerShell, Home folder, Running');
    expect(wrapper.get('[data-testid="terminal-new"]').attributes('title')).toContain('Shift+click starts one in your home folder.');
  });

  it('heads the panel\'s terminals only: one in the panel beside one in the editor shows as the single tab', () => {
    const store = fakeStore({ ...TERMINAL_STATE, terminals: [info('term-1', 'PowerShell'), { ...info('term-2', 'logs'), placement: 'editor' }], groups: [{ id: 'group-1', paneIds: ['term-1'], activePaneId: 'term-1', sizes: [1] }], activeId: 'term-1' });
    wrapper = mount(TerminalPane, {
      props: { api: fakeShellApi(), state: STATE, maximized: false, hideShortcut: 'Ctrl+`' },
      global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: store }, stubs: { transition: true, TerminalPanel: true, PaneGrip: true } },
    });
    expect(wrapper.get('[data-testid="terminal-tab-title"]').text()).toBe('PowerShell');
    expect(wrapper.find('[data-testid="terminal-summary"]').exists()).toBe(false);
  });

  it('drags the single tab with the terminal id alone, dimmed until the drag ends', async () => {
    const store = fakeStore({ ...TERMINAL_STATE, terminals: [info('term-1', 'PowerShell')], groups: [{ id: 'group-1', paneIds: ['term-1'], activePaneId: 'term-1', sizes: [1] }], activeId: 'term-1' });
    wrapper = mount(TerminalPane, {
      props: { api: fakeShellApi(), state: STATE, maximized: false, hideShortcut: 'Ctrl+`' },
      global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: store }, stubs: { transition: true, TerminalPanel: true, PaneGrip: true } },
    });
    const tab = wrapper.get('[data-testid="terminal-tab"]');
    expect(tab.attributes('draggable')).toBe('true');
    const payload: Record<string, string> = {};
    const start = new Event('dragstart', { bubbles: true }) as DragEvent;
    Object.defineProperty(start, 'dataTransfer', { value: { setData: (format: string, value: string) => void (payload[format] = value), effectAllowed: 'none' } });
    tab.element.dispatchEvent(start);
    await nextTick();
    expect(payload).toEqual({ [TERMINAL_DRAG_MIME]: 'term-1' });
    expect(start.dataTransfer!.effectAllowed).toBe('move');
    expect(tab.attributes('data-dragging')).toBe('true');
    await tab.trigger('dragend');
    expect(tab.attributes('data-dragging')).toBeUndefined();
  });

  it('opens the project-first pick on a click, main\'s menu under the arrow, and starts the default shell at once on Shift+click', async () => {
    const api = fakeShellApi();
    let closeMenu!: () => void;
    vi.mocked(api.terminal.openNewMenu).mockImplementation(() => new Promise<void>((resolve) => (closeMenu = resolve)));
    const terminals = [info('term-1', 'PowerShell')];
    const store = fakeStore({ ...TERMINAL_STATE, terminals, groups: [{ id: 'group-1', paneIds: ['term-1'], activePaneId: 'term-1', sizes: [1] }], activeId: 'term-1' });
    wrapper = mount(TerminalPane, {
      props: { api, state: STATE, maximized: false, hideShortcut: 'Ctrl+`' },
      global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: store }, stubs: { transition: true, TerminalPanel: true, PaneGrip: true } },
      attachTo: document.body,
    });
    await wrapper.get('[data-testid="terminal-new"]').trigger('click');
    expect(api.terminal.openNew).toHaveBeenCalledTimes(1);
    expect(api.terminal.create).not.toHaveBeenCalled();

    await wrapper.get('[data-testid="terminal-new"]').trigger('click', { shiftKey: true });
    await flushPromises();
    expect(api.terminal.create).toHaveBeenCalledWith({ profileId: null, target: { current: true } });
    expect(store.requestFocus).toHaveBeenCalledWith('term-1');
    expect(api.terminal.openNew).toHaveBeenCalledTimes(1);

    const chevron = wrapper.get('[data-testid="terminal-new-menu"]');
    await chevron.trigger('click');
    expect(api.terminal.openNewMenu).toHaveBeenCalledTimes(1);
    const anchor = vi.mocked(api.terminal.openNewMenu).mock.calls[0]![0];
    expect(Object.keys(anchor).sort()).toEqual(['height', 'width', 'x', 'y']);
    expect(chevron.attributes('aria-expanded')).toBe('true');
    // a second click while the menu is open opens no second one
    await chevron.trigger('click');
    expect(api.terminal.openNewMenu).toHaveBeenCalledTimes(1);
    closeMenu();
    await flushPromises();
    expect(chevron.attributes('aria-expanded')).toBe('false');
    expect(api.overlayRequests).toEqual([]);
  });

  it('splits the active pane from the header, and not once its group is full', async () => {
    const api = fakeShellApi();
    const ids = ['term-1', 'term-2', 'term-3', 'term-4', 'term-5', 'term-6', 'term-7', 'term-8'];
    const store = fakeStore({ ...TERMINAL_STATE, terminals: ids.slice(0, 2).map((id) => info(id, id)), groups: [{ id: 'group-1', paneIds: ids.slice(0, 2), activePaneId: 'term-2', sizes: [0.5, 0.5] }], activeId: 'term-2' });
    wrapper = mount(TerminalPane, {
      props: { api, state: STATE, maximized: false, hideShortcut: 'Ctrl+`' },
      global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: store }, stubs: { transition: true, TerminalPanel: true, PaneGrip: true } },
    });
    await wrapper.get('[data-testid="terminal-split"]').trigger('click');
    expect(api.terminal.split).toHaveBeenCalledWith('term-2');
    store.state.value = { ...TERMINAL_STATE, terminals: ids.map((id) => info(id, id)), groups: [{ id: 'group-1', paneIds: ids, activePaneId: 'term-2', sizes: ids.map(() => 1 / 8) }], activeId: 'term-2' };
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="terminal-split"]').attributes('disabled')).toBeDefined();
  });
});

describe('the panel\'s end target', () => {
  const one = (id: string) => ({ id: `group-${id}`, paneIds: [id], activePaneId: id, sizes: [1] });
  afterEach(() => endTerminalDrag());

  function dragging(id: string): void {
    const start = new Event('dragstart') as DragEvent;
    Object.defineProperty(start, 'dataTransfer', { value: { setData: () => undefined, effectAllowed: 'none' } });
    startTerminalDrag(start, id);
  }

  const drag = (type: string, payload = '', relatedTarget: Node | null = null): DragEvent => {
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperties(event, {
      dataTransfer: { value: { types: [TERMINAL_DRAG_MIME], getData: () => (type === 'drop' ? payload : ''), dropEffect: 'none' } },
      relatedTarget: { value: relatedTarget },
    });
    return event;
  };

  function mountPane(state: TerminalState): TerminalStore {
    const store = fakeStore(state);
    wrapper = mount(TerminalPane, {
      props: { api: fakeShellApi(), state: STATE, maximized: false, hideShortcut: 'Ctrl+`' },
      global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: store }, stubs: { transition: true, TerminalPanes: true, TerminalList: true, PaneGrip: true } },
    });
    return store;
  }

  // VS Code's container drop: the header strip, beside the one panel terminal's tab, takes an editor terminal back as its own tab.
  it('takes an editor terminal dropped on the header strip into the panel as a group of its own at the end, lit while it hovers', async () => {
    const store = mountPane({ ...TERMINAL_STATE, terminals: [info('term-1', 'PowerShell'), { ...info('term-2', 'logs'), placement: 'editor' }], groups: [one('term-1')], activeId: 'term-1' });
    const header = wrapper!.get('[data-testid="terminal-header"]');
    expect(header.attributes('data-drop')).toBeUndefined();
    dragging('term-2');
    const over = drag('dragover');
    header.element.dispatchEvent(over);
    await nextTick();
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer!.dropEffect).toBe('move');
    expect(header.attributes('data-drop')).toBe('true');
    // moving onto the tab inside the strip keeps it lit
    header.element.dispatchEvent(drag('dragleave', '', wrapper!.get('[data-testid="terminal-tab"]').element));
    await nextTick();
    expect(header.attributes('data-drop')).toBe('true');
    header.element.dispatchEvent(drag('dragleave'));
    await nextTick();
    expect(header.attributes('data-drop')).toBeUndefined();
    header.element.dispatchEvent(drag('dragover'));
    const drop = drag('drop', 'term-2');
    header.element.dispatchEvent(drop);
    await nextTick();
    expect(drop.defaultPrevented).toBe(true);
    expect(store.move).toHaveBeenCalledWith({ kind: 'detach', id: 'term-2' });
    expect(header.attributes('data-drop')).toBeUndefined();
  });

  it('lights the empty panel with the header strip, as one target', async () => {
    mountPane({ ...TERMINAL_STATE, canCreate: true, terminals: [{ ...info('term-2', 'logs'), placement: 'editor' }] });
    dragging('term-2');
    wrapper!.get('[data-testid="terminal-header"]').element.dispatchEvent(drag('dragover'));
    await nextTick();
    expect(wrapper!.get('[data-testid="terminal-empty"]').attributes('data-drop')).toBe('true');
    expect(wrapper!.get('[data-testid="terminal-empty-drop"]').text()).toBe('Drop to move logs into the panel');
  });

  it('takes no panel terminal already alone at the end, and no drag that carries no terminal', async () => {
    mountPane({ ...TERMINAL_STATE, terminals: [info('term-1', 'PowerShell'), info('term-2', 'logs')], groups: [{ id: 'group-1', paneIds: ['term-1', 'term-2'], activePaneId: 'term-1', sizes: [0.5, 0.5] }, one('term-3')], activeId: 'term-1' });
    const header = wrapper!.get('[data-testid="terminal-header"]');
    dragging('term-3');
    const alone = drag('dragover');
    header.element.dispatchEvent(alone);
    await nextTick();
    expect(alone.defaultPrevented).toBe(false);
    expect(header.attributes('data-drop')).toBeUndefined();
    // a pane of a split leaves it for a group of its own
    dragging('term-2');
    const pane = drag('dragover');
    header.element.dispatchEvent(pane);
    await nextTick();
    expect(pane.defaultPrevented).toBe(true);
    endTerminalDrag();
    const files = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(files, 'dataTransfer', { value: { types: ['Files'], getData: () => '', dropEffect: 'none' } });
    header.element.dispatchEvent(files);
    expect(files.defaultPrevented).toBe(false);
  });
});

describe('the move announcement', () => {
  it('announces a move politely once main\'s state shows it, with the pane\'s place in a split, whether or not the list shows', async () => {
    const one = (id: string) => ({ id: `group-${id}`, paneIds: [id], activePaneId: id, sizes: [1] });
    const terminals = [info('term-1', 'dev server'), info('term-4', 'shell')];
    const store = fakeStore({ ...TERMINAL_STATE, terminals, groups: [one('term-1'), one('term-4')], activeId: 'term-1' });
    wrapper = mount(TerminalPanel, {
      props: { api: fakeShellApi(), state: STATE },
      global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: store }, stubs: { transition: true, TerminalPanes: true, TerminalList: true } },
    });
    const announcement = wrapper.get('[data-testid="terminal-move-announcement"]');
    expect(announcement.attributes('aria-live')).toBe('polite');
    store.state.value = { ...TERMINAL_STATE, terminals: [terminals[1]!, terminals[0]!], groups: [one('term-4'), one('term-1')], activeId: 'term-1' };
    store.moved.value = { id: 'term-4', seq: 1 };
    await vi.waitFor(() => expect(announcement.text()).toBe('shell moved to position 1 of 2'));
    store.state.value = { ...TERMINAL_STATE, terminals, groups: [{ id: 'group-1', paneIds: ['term-1', 'term-4'], activePaneId: 'term-1', sizes: [0.5, 0.5] }], activeId: 'term-1' };
    store.moved.value = { id: 'term-4', seq: 2 };
    await vi.waitFor(() => expect(announcement.text()).toBe('shell moved to position 2 of 2, split 2 of 2'));
    // an editor terminal back as the panel's only terminal, with no list beside it
    store.state.value = { ...TERMINAL_STATE, terminals: [info('term-9', 'logs')], groups: [one('term-9')], activeId: 'term-9' };
    store.moved.value = { id: 'term-9', seq: 3 };
    await vi.waitFor(() => expect(announcement.text()).toBe('logs moved to position 1 of 1'));
  });
});

describe('the terminal empty state', () => {
  function mountPanel(state: TerminalState): VueWrapper {
    wrapper = mount(TerminalPanel, {
      props: { api: fakeShellApi(), state: STATE },
      global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: fakeStore(state) }, stubs: { transition: true, TerminalPanes: true, TerminalList: true } },
    });
    return wrapper;
  }

  it('says quietly that shells are being detected, as a status, and holds back that none was found', () => {
    const panel = mountPanel({ ...TERMINAL_STATE, canCreate: false, profilesReady: false });
    const detecting = panel.get('[data-testid="terminal-detecting"]');
    expect(detecting.text()).toBe('Detecting shells…');
    expect(detecting.attributes('role')).toBe('status');
    expect(panel.find('[data-testid="terminal-no-shell"]').exists()).toBe(false);
    expect(panel.find('[data-testid="terminal-empty-new"]').exists()).toBe(false);
  });

  it('says no shell was found once detection settled with none, and offers New Terminal once one was', () => {
    const none = mountPanel({ ...TERMINAL_STATE, canCreate: false, profilesReady: true });
    expect(none.get('[data-testid="terminal-no-shell"]').text()).toBe('No shell was found on this computer');
    expect(none.find('[data-testid="terminal-detecting"]').exists()).toBe(false);
    none.unmount();
    const found = mountPanel({ ...TERMINAL_STATE, canCreate: true, profilesReady: true });
    expect(found.find('[data-testid="terminal-empty-new"]').exists()).toBe(true);
    expect(found.find('[data-testid="terminal-detecting"]').exists()).toBe(false);
  });

  it('shows itself with New Terminal, and no list, while every terminal is in the editor', () => {
    const editor = (id: string, title: string): TerminalInfo => ({ ...info(id, title), placement: 'editor' });
    const panel = mountPanel({ ...TERMINAL_STATE, canCreate: true, terminals: [editor('e1', 'one'), editor('e2', 'two')] });
    expect(panel.find('[data-testid="terminal-empty"]').exists()).toBe(true);
    expect(panel.find('[data-testid="terminal-empty-new"]').exists()).toBe(true);
    expect(panel.findComponent({ name: 'TerminalList' }).exists()).toBe(false);
  });

  it('takes an editor terminal\'s tab dropped on it back into the panel, saying so while it hovers', async () => {
    const state = { ...TERMINAL_STATE, canCreate: true, terminals: [{ ...info('e1', 'dev server'), placement: 'editor' as const }] };
    const store = fakeStore(state);
    wrapper = mount(TerminalPanel, {
      props: { api: fakeShellApi(), state: STATE },
      global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: store }, stubs: { transition: true, TerminalPanes: true, TerminalList: true } },
    });
    const start = new Event('dragstart') as DragEvent;
    Object.defineProperty(start, 'dataTransfer', { value: { setData: () => undefined, effectAllowed: 'none' } });
    startTerminalDrag(start, 'e1');
    const drag = (type: string, payload: string): DragEvent => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(event, 'dataTransfer', { value: { types: [TERMINAL_DRAG_MIME], getData: () => (type === 'drop' ? payload : ''), dropEffect: 'none' } });
      return event;
    };
    const empty = wrapper.get('[data-testid="terminal-empty"]');
    const over = drag('dragover', '');
    empty.element.dispatchEvent(over);
    await nextTick();
    expect(over.defaultPrevented).toBe(true);
    expect(empty.attributes('data-drop')).toBe('true');
    expect(wrapper.get('[data-testid="terminal-empty-drop"]').text()).toBe('Drop to move dev server into the panel');
    empty.element.dispatchEvent(drag('drop', 'e1'));
    await nextTick();
    expect(store.move).toHaveBeenCalledWith({ kind: 'detach', id: 'e1' });
    expect(empty.attributes('data-drop')).toBeUndefined();
    endTerminalDrag();
  });

  it('opens the project-first pick from the empty state\'s New Terminal button', async () => {
    const api = fakeShellApi();
    wrapper = mount(TerminalPanel, {
      props: { api, state: STATE },
      global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: fakeStore({ ...TERMINAL_STATE, canCreate: true }) }, stubs: { transition: true, TerminalPanes: true, TerminalList: true } },
    });
    await wrapper.get('[data-testid="terminal-empty-new"]').trigger('click');
    expect(api.terminal.openNew).toHaveBeenCalledTimes(1);
    expect(api.terminal.create).not.toHaveBeenCalled();
  });
});
