// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref, shallowRef } from 'vue';
import type { TerminalGroupInfo, TerminalInfo, TerminalState } from '../../preload/terminal-channels';
import TerminalPanes from '../terminal/TerminalPanes.vue';
import { TERMINAL_STORE, type TerminalStore } from '../terminal/terminal-store';
import { shellI18n } from '../i18n';
import { TERMINAL_STATE, fakeShellApi, type FakeShellApi } from './fakes';

// happy-dom lays nothing out, so the group is 1000px wide.
vi.mock('@vueuse/core', async (original) => ({
  ...(await original<typeof import('@vueuse/core')>()),
  useElementSize: () => ({ width: ref(1000), height: ref(400) }),
}));

beforeAll(() => {
  HTMLElement.prototype.setPointerCapture ??= () => undefined;
});

const info = (id: string, title = id): TerminalInfo => ({
  id, title, name: null, profileId: 'cmd', icon: 'cmd', customIcon: null, color: null, projectKey: 'alpha', projectName: 'alpha', status: 'running', exitCode: null, description: null, running: null, integrated: false,
});

const group = (id: string, paneIds: string[], sizes: number[], activePaneId = paneIds[0]!): TerminalGroupInfo => ({ id, paneIds, sizes, activePaneId });

// Stands in for the xterm; it reports the Resize Pane action the way TerminalView does.
const ViewStub = defineComponent({
  name: 'TerminalView',
  props: { terminal: { type: Object, required: true }, shown: Boolean },
  emits: ['resizePane'],
  setup: (props) => () => h('div', { 'data-testid': 'terminal-view', 'data-terminal-id': (props.terminal as TerminalInfo).id, 'data-shown': String(props.shown) }),
});

function storeFor(state: TerminalState): TerminalStore {
  return { state: shallowRef(state), focusRequest: shallowRef(null), requestFocus: vi.fn(), actionRequest: shallowRef(null) } as unknown as TerminalStore;
}

let wrapper: VueWrapper | undefined;
afterEach(() => wrapper?.unmount());

function mountPanes(state: TerminalState): { api: FakeShellApi; wrapper: VueWrapper } {
  const api = fakeShellApi();
  wrapper = mount(TerminalPanes, {
    props: { api, terminal: state, platform: 'win32', splitShortcut: 'Ctrl+Shift+5' },
    global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: storeFor(state) }, stubs: { TerminalView: ViewStub } },
  });
  return { api, wrapper };
}

const split = (sizes = [0.5, 0.5]): TerminalState => ({
  ...TERMINAL_STATE,
  terminals: [info('term-1', 'dev server'), info('term-2', 'tests'), info('term-3', 'logs')],
  groups: [group('group-1', ['term-1', 'term-2'], sizes), group('group-2', ['term-3'], [1])],
  activeId: 'term-1',
});

const box = (w: VueWrapper, id: string) => w.get(`[data-testid="terminal-pane-box"][data-terminal-id="${id}"]`);
const sash = (w: VueWrapper, index = 0) => w.findAll('[data-testid="terminal-pane-sash"]')[index]!;

describe('split panes', () => {
  it('lays the active group\'s panes side by side by their sizes and hides every other group', () => {
    const { wrapper: w } = mountPanes(split([0.3, 0.7]));
    expect(box(w, 'term-1').attributes('style')).toContain('left: 0%');
    expect(box(w, 'term-1').attributes('style')).toContain('width: 30%');
    expect(box(w, 'term-2').attributes('style')).toContain('left: 30%');
    expect(box(w, 'term-2').attributes('style')).toContain('width: 70%');
    expect(box(w, 'term-3').attributes('style')).toContain('display: none');
    expect(w.get('[data-terminal-id="term-3"][data-testid="terminal-view"]').attributes('data-shown')).toBe('false');
    expect(w.get('[data-terminal-id="term-2"][data-testid="terminal-view"]').attributes('data-shown')).toBe('true');
  });

  it('marks only the active pane of a multi-pane group, and no pane of a single one', async () => {
    const { wrapper: w } = mountPanes(split());
    expect(box(w, 'term-1').attributes('data-active')).toBe('true');
    expect(box(w, 'term-2').attributes('data-active')).toBeUndefined();
    await w.setProps({ terminal: { ...split(), activeId: 'term-3' } });
    expect(box(w, 'term-3').attributes('data-active')).toBeUndefined();
    expect(w.findAll('[data-testid="terminal-pane-sash"]')).toHaveLength(0);
  });

  it('gives each sash separator semantics naming the panes it sits between', () => {
    const { wrapper: w } = mountPanes(split([0.4, 0.6]));
    const handle = sash(w);
    expect(handle.attributes('role')).toBe('separator');
    expect(handle.attributes('aria-orientation')).toBe('vertical');
    expect(handle.attributes('tabindex')).toBe('0');
    expect(handle.attributes('aria-controls')).toBe(`${box(w, 'term-1').attributes('id')} ${box(w, 'term-2').attributes('id')}`);
    expect(handle.attributes('aria-label')).toContain('dev server');
    expect(handle.attributes('aria-label')).toContain('tests');
    expect(handle.attributes('aria-valuetext')).toContain('40%');
    expect(Number(handle.attributes('aria-valuenow'))).toBe(600);
    expect(Number(handle.attributes('aria-valuemin'))).toBe(80);
    expect(Number(handle.attributes('aria-valuemax'))).toBe(920);
  });

  it('sends each arrow key step, and Home and End stop the panes at the minimum', async () => {
    const { api, wrapper: w } = mountPanes(split());
    await sash(w).trigger('keydown', { key: 'ArrowRight' });
    expect(api.terminal.resizePanes).toHaveBeenLastCalledWith({ groupId: 'group-1', sizes: [0.51, 0.49] });
    await sash(w).trigger('keydown', { key: 'Home' });
    expect(api.terminal.resizePanes).toHaveBeenLastCalledWith({ groupId: 'group-1', sizes: [0.92, 0.08] });
    await sash(w).trigger('keydown', { key: 'End' });
    expect(api.terminal.resizePanes).toHaveBeenLastCalledWith({ groupId: 'group-1', sizes: [0.08, 0.92] });
  });

  it('previews a mouse drag locally and sends the sizes once, when it ends', async () => {
    const { api, wrapper: w } = mountPanes(split());
    const element = sash(w).element;
    element.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: 500 }));
    element.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 550 }));
    element.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 600 }));
    await nextTick();
    expect(box(w, 'term-1').attributes('style')).toContain('width: 60%');
    expect(api.terminal.resizePanes).not.toHaveBeenCalled();
    element.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 600 }));
    expect(api.terminal.resizePanes).toHaveBeenCalledTimes(1);
    expect(api.terminal.resizePanes).toHaveBeenLastCalledWith({ groupId: 'group-1', sizes: [0.6, 0.4] });
  });

  it('holds the dragged sizes until main publishes the ones it stored', async () => {
    const { wrapper: w } = mountPanes(split());
    const element = sash(w).element;
    element.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: 500 }));
    element.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 700 }));
    element.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 700 }));
    await nextTick();
    expect(box(w, 'term-1').attributes('style')).toContain('width: 70%');
    await w.setProps({ terminal: split([0.65, 0.35]) });
    expect(box(w, 'term-1').attributes('style')).toContain('width: 65%');
  });

  it('resets to equal sizes on double-click, as VS Code does', async () => {
    const { api, wrapper: w } = mountPanes(split([0.2, 0.8]));
    await sash(w).trigger('dblclick');
    expect(api.terminal.resizePanes).toHaveBeenLastCalledWith({ groupId: 'group-1', sizes: [0.5, 0.5] });
  });

  it('moves the pane edge four cells for Resize Pane Left and Right, each step from the last', async () => {
    const { api, wrapper: w } = mountPanes(split());
    w.findAllComponents(ViewStub)[0]!.vm.$emit('resizePane', 'right', 8);
    expect(api.terminal.resizePanes).toHaveBeenLastCalledWith({ groupId: 'group-1', sizes: [0.532, 0.468] });
    w.findAllComponents(ViewStub)[1]!.vm.$emit('resizePane', 'left', 8);
    expect(api.terminal.resizePanes).toHaveBeenLastCalledWith({ groupId: 'group-1', sizes: [0.5, 0.5] });
  });

  it('selects a pane the user clicks into, and leaves the active one alone', async () => {
    const { api, wrapper: w } = mountPanes(split());
    await box(w, 'term-2').trigger('pointerdown');
    expect(api.terminal.select).toHaveBeenCalledWith('term-2');
    vi.mocked(api.terminal.select).mockClear();
    await box(w, 'term-1').trigger('pointerdown');
    expect(api.terminal.select).not.toHaveBeenCalled();
  });

  it('plays the entrance only on a pane that joined the shown group', async () => {
    const one: TerminalState = { ...TERMINAL_STATE, terminals: [info('term-1')], groups: [group('group-1', ['term-1'], [1])], activeId: 'term-1' };
    const { wrapper: w } = mountPanes(one);
    expect(box(w, 'term-1').classes()).not.toContain('terminal-pane-enter');
    await w.setProps({ terminal: { ...one, terminals: [info('term-1'), info('term-2')], groups: [group('group-1', ['term-1', 'term-2'], [0.5, 0.5], 'term-2')], activeId: 'term-2' } });
    expect(box(w, 'term-2').classes()).toContain('terminal-pane-enter');
    expect(box(w, 'term-1').classes()).not.toContain('terminal-pane-enter');
  });

  it('fades a pane that left the shown group out where it stood', async () => {
    const { wrapper: w } = mountPanes(split());
    await w.setProps({ terminal: { ...split(), terminals: [info('term-1'), info('term-3')], groups: [group('group-1', ['term-1'], [1]), group('group-2', ['term-3'], [1])] } });
    const ghost = w.get('[data-testid="terminal-pane-ghost"]');
    expect(ghost.attributes('style')).toContain('left: 50%');
    expect(ghost.attributes('style')).toContain('width: 50%');
    await ghost.trigger('animationend');
    expect(w.findAll('[data-testid="terminal-pane-ghost"]')).toHaveLength(0);
  });
});
