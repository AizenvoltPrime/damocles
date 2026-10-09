// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { computed, defineComponent, h, inject, nextTick, shallowRef } from 'vue';
import type { TerminalInfo, TerminalState } from '../../preload/terminal-channels';
import TerminalPane from '../layout/TerminalPane.vue';
import { TERMINAL_STORE, type TerminalStore } from '../terminal/terminal-store';
import { shellI18n } from '../i18n';
import { STATE, TERMINAL_STATE, fakeShellApi } from './fakes';

const info = (id: string, title: string): TerminalInfo => ({
  id, title, name: null, profileId: 'pwsh', icon: 'powershell', customIcon: null, color: null, projectKey: 'alpha', projectName: 'alpha', status: 'running', exitCode: null, description: null, running: null, integrated: false,
});

function fakeStore(state: TerminalState): TerminalStore {
  const current = shallowRef<TerminalState | null>(state);
  return {
    state: current,
    active: computed(() => current.value?.terminals.find((t) => t.id === current.value?.activeId) ?? null),
    focusRequest: shallowRef(null),
    renaming: shallowRef(null),
    requestFocus: vi.fn(),
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
  it('lists a user profile in the New Terminal dropdown with its own icon and colour', async () => {
    const api = fakeShellApi();
    const profiles = [
      { id: 'cmd', name: 'Command Prompt', path: 'C:/cmd.exe', args: [], source: 'detected' as const, icon: 'cmd' as const, customIcon: null, color: null, isDefault: true },
      { id: 'user:Dev', name: 'Developer PowerShell', path: 'C:/pwsh.exe', args: ['-NoExit'], source: 'user' as const, icon: 'powershell' as const, customIcon: 'wrench' as const, color: 'magenta' as const, isDefault: false },
    ];
    const terminals = [info('term-1', 'PowerShell')];
    const store = fakeStore({ ...TERMINAL_STATE, terminals, groups: [{ id: 'group-1', paneIds: ['term-1'], activePaneId: 'term-1', sizes: [1] }], activeId: 'term-1', profiles });
    wrapper = mount(TerminalPane, {
      props: { api, state: STATE, maximized: false, hideShortcut: 'Ctrl+`' },
      global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: store }, stubs: { transition: true, TerminalPanel: true, PaneGrip: true } },
    });
    await wrapper.get('[data-testid="terminal-new-menu"]').trigger('click');
    const request = api.overlayRequests.at(-1);
    const items = request?.kind === 'menu' ? request.items : [];
    expect(items.slice(0, 2)).toEqual([
      { kind: 'item', id: 'profile:cmd', label: 'Command Prompt', glyph: 'cmd' },
      { kind: 'item', id: 'profile:user:Dev', label: 'Developer PowerShell', glyph: 'wrench', color: 'magenta' },
    ]);
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
