// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, onMounted, ref, shallowRef } from 'vue';
import { MAX_TERMINAL_GROUP_PANES, type TerminalGroupInfo, type TerminalInfo, type TerminalState } from '../../preload/terminal-channels';
import TerminalPanes from '../terminal/TerminalPanes.vue';
import { endTerminalDrag, startTerminalDrag, TERMINAL_DRAG_MIME } from '../terminal/terminal-drag';
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
  id, title, name: null, profileId: 'cmd', icon: 'cmd', customIcon: null, color: null, projectKey: 'alpha', projectName: 'alpha', status: 'running', exitCode: null, description: null, running: null, integrated: false, restoring: false, windowsBuild: null, pathFlavor: 'posix', placement: 'panel',
});

const group = (id: string, paneIds: string[], sizes: number[], activePaneId = paneIds[0]!): TerminalGroupInfo => ({ id, paneIds, sizes, activePaneId });

// Stands in for the xterm; it reports the Resize Pane action the way TerminalView does, and counts its mounts.
let viewMounts = 0;
const ViewStub = defineComponent({
  name: 'TerminalView',
  props: { terminal: { type: Object, required: true }, shown: Boolean },
  emits: ['resizePane'],
  setup: (props) => {
    onMounted(() => viewMounts++);
    return () => h('div', { 'data-testid': 'terminal-view', 'data-terminal-id': (props.terminal as TerminalInfo).id, 'data-shown': String(props.shown) });
  },
});

function storeFor(state: TerminalState): TerminalStore {
  return { state: shallowRef(state), focusRequest: shallowRef(null), requestFocus: vi.fn(), actionRequest: shallowRef(null), move: vi.fn(), editorHosts: shallowRef(new Map()), editorShown: shallowRef(null) } as unknown as TerminalStore;
}

let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  endTerminalDrag();
  document.body.replaceChildren();
  viewMounts = 0;
});

function mountPanes(state: TerminalState): { api: FakeShellApi; wrapper: VueWrapper; store: TerminalStore } {
  const api = fakeShellApi();
  const store = storeFor(state);
  wrapper = mount(TerminalPanes, {
    props: { api, terminal: state, platform: 'win32', splitShortcut: 'Ctrl+Shift+5', hosts: [] },
    global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: store }, stubs: { TerminalView: ViewStub } },
  });
  return { api, wrapper, store };
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

describe('dropping a terminal on a pane', () => {
  // A drag event over a pane 1000px wide from x 0; a dragover reads only the transfer's types, as in Chromium.
  function dragEvent(type: string, data: Record<string, string>, clientX: number): DragEvent {
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
    const transfer = { types: Object.keys(data), getData: (format: string) => (type === 'drop' ? data[format] ?? '' : ''), dropEffect: 'none' };
    Object.defineProperties(event, { dataTransfer: { value: transfer }, clientX: { value: clientX }, clientY: { value: 100 } });
    return event;
  }

  function dragging(id: string): void {
    const start = new Event('dragstart') as DragEvent;
    Object.defineProperty(start, 'dataTransfer', { value: { setData: () => undefined, effectAllowed: 'none' } });
    startTerminalDrag(start, id);
  }

  function over(w: VueWrapper, id: string, clientX: number): DragEvent {
    const element = box(w, id).element as HTMLElement;
    element.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 400, right: 1000, bottom: 400, x: 0, y: 0, toJSON: () => ({}) });
    const event = dragEvent('dragover', { [TERMINAL_DRAG_MIME]: '' }, clientX);
    element.dispatchEvent(event);
    return event;
  }

  const overlay = (w: VueWrapper, id: string) => box(w, id).find('[data-testid="terminal-drop-overlay"]');

  it('covers the half under the pointer above the xterm, and joins the pane\'s group on that side', async () => {
    const { wrapper: w, store } = mountPanes(split());
    dragging('term-3');
    const left = over(w, 'term-2', 200);
    await nextTick();
    expect(left.defaultPrevented).toBe(true);
    expect(left.dataTransfer!.dropEffect).toBe('move');
    expect(overlay(w, 'term-2').attributes('data-side')).toBe('before');
    // after the view, so it paints above the xterm by DOM order
    const view = box(w, 'term-2').get('[data-testid="terminal-view"]').element;
    expect(view.compareDocumentPosition(overlay(w, 'term-2').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(overlay(w, 'term-1').exists()).toBe(false);
    over(w, 'term-2', 800);
    await nextTick();
    expect(overlay(w, 'term-2').attributes('data-side')).toBe('after');
    box(w, 'term-2').element.dispatchEvent(dragEvent('drop', { [TERMINAL_DRAG_MIME]: 'term-3' }, 800));
    await nextTick();
    expect(store.move).toHaveBeenCalledWith({ kind: 'join', id: 'term-3', target: 'term-2', side: 'after' });
    expect(overlay(w, 'term-2').exists()).toBe(false);
  });

  it('moves the overlay to the pane the drag enters and drops it when the drag leaves the panes', async () => {
    const { wrapper: w } = mountPanes(split());
    dragging('term-3');
    over(w, 'term-1', 100);
    await nextTick();
    over(w, 'term-2', 100);
    box(w, 'term-1').element.dispatchEvent(Object.defineProperty(dragEvent('dragleave', { [TERMINAL_DRAG_MIME]: '' }, 0), 'relatedTarget', { value: box(w, 'term-2').element }));
    await nextTick();
    expect(overlay(w, 'term-1').exists()).toBe(false);
    expect(overlay(w, 'term-2').exists()).toBe(true);
    box(w, 'term-2').element.dispatchEvent(Object.defineProperty(dragEvent('dragleave', { [TERMINAL_DRAG_MIME]: '' }, 0), 'relatedTarget', { value: null }));
    await nextTick();
    expect(overlay(w, 'term-2').exists()).toBe(false);
    over(w, 'term-2', 100);
    endTerminalDrag();
    await nextTick();
    expect(overlay(w, 'term-2').exists()).toBe(false);
  });

  it('refuses a group already holding the most panes with a not-allowed drop, unless the terminal is in it', async () => {
    const ids = Array.from({ length: MAX_TERMINAL_GROUP_PANES }, (_, index) => `term-${index + 1}`);
    const full: TerminalState = {
      ...TERMINAL_STATE,
      terminals: [...ids, 'term-9'].map((id) => info(id)),
      groups: [group('group-1', ids, ids.map(() => 1 / ids.length)), group('group-2', ['term-9'], [1])],
      activeId: 'term-1',
    };
    const { wrapper: w, store } = mountPanes(full);
    dragging('term-9');
    const refused = over(w, 'term-2', 200);
    await nextTick();
    expect(refused.dataTransfer!.dropEffect).toBe('none');
    expect(overlay(w, 'term-2').attributes('data-refused')).toBe('true');
    expect(overlay(w, 'term-2').attributes('data-side')).toBeUndefined();
    expect(overlay(w, 'term-2').text()).toBe(`This split already has ${MAX_TERMINAL_GROUP_PANES} terminals`);
    box(w, 'term-2').element.dispatchEvent(dragEvent('drop', { [TERMINAL_DRAG_MIME]: 'term-9' }, 200));
    expect(store.move).not.toHaveBeenCalled();
    dragging('term-1');
    over(w, 'term-2', 800);
    await nextTick();
    expect(overlay(w, 'term-2').attributes('data-refused')).toBeUndefined();
    expect(overlay(w, 'term-2').attributes('data-side')).toBe('after');
  });

  it('refuses a join onto or from a worktree Setup task, saying why, and sends nothing', async () => {
    // term-3, alone in its group, runs the task
    const state: TerminalState = { ...split(), terminals: split().terminals.map((terminal) => (terminal.id === 'term-3' ? { ...terminal, task: true as const } : terminal)) };
    const { wrapper: w, store } = mountPanes(state);
    dragging('term-1');
    const onto = over(w, 'term-3', 200);
    await nextTick();
    expect(onto.defaultPrevented).toBe(true);
    expect(onto.dataTransfer!.dropEffect).toBe('none');
    expect(overlay(w, 'term-3').attributes('data-refused')).toBe('true');
    expect(overlay(w, 'term-3').attributes('data-side')).toBeUndefined();
    expect(overlay(w, 'term-3').text()).toBe('A worktree\'s Setup terminal runs in a tab of its own');
    box(w, 'term-3').element.dispatchEvent(dragEvent('drop', { [TERMINAL_DRAG_MIME]: 'term-1' }, 200));
    dragging('term-3');
    const from = over(w, 'term-2', 800);
    await nextTick();
    expect(from.dataTransfer!.dropEffect).toBe('none');
    expect(overlay(w, 'term-2').attributes('data-refused')).toBe('true');
    box(w, 'term-2').element.dispatchEvent(dragEvent('drop', { [TERMINAL_DRAG_MIME]: 'term-3' }, 800));
    expect(store.move).not.toHaveBeenCalled();
  });

  it('takes nothing on the half beside the terminal\'s own place in its group', async () => {
    const { wrapper: w, store } = mountPanes(split());
    dragging('term-1');
    const beside = over(w, 'term-2', 200);
    await nextTick();
    expect(beside.defaultPrevented).toBe(false);
    expect(overlay(w, 'term-2').exists()).toBe(false);
    over(w, 'term-2', 800);
    await nextTick();
    expect(overlay(w, 'term-2').attributes('data-side')).toBe('after');
    over(w, 'term-2', 200);
    await nextTick();
    expect(overlay(w, 'term-2').exists()).toBe(false);
    expect(store.move).not.toHaveBeenCalled();
  });

  it('takes nothing on the dragged terminal\'s own pane, and ignores drags that carry no terminal', async () => {
    const { wrapper: w, store } = mountPanes(split());
    dragging('term-1');
    const own = over(w, 'term-1', 200);
    await nextTick();
    expect(own.defaultPrevented).toBe(false);
    expect(overlay(w, 'term-1').exists()).toBe(false);
    box(w, 'term-1').element.dispatchEvent(dragEvent('drop', { [TERMINAL_DRAG_MIME]: 'term-1' }, 200));
    expect(store.move).not.toHaveBeenCalled();
    const files = dragEvent('dragover', { Files: '' }, 200);
    box(w, 'term-2').element.dispatchEvent(files);
    await nextTick();
    expect(files.defaultPrevented).toBe(false);
    expect(overlay(w, 'term-2').exists()).toBe(false);
  });

  it('joins an editor terminal dragged from its tab onto a pane half to that pane\'s group', async () => {
    const state: TerminalState = { ...split(), terminals: [...split().terminals, { ...info('term-9'), placement: 'editor' }] };
    const { wrapper: w, store } = mountPanes(state);
    dragging('term-9');
    const event = over(w, 'term-2', 200);
    await nextTick();
    expect(event.defaultPrevented).toBe(true);
    expect(overlay(w, 'term-2').attributes('data-side')).toBe('before');
    box(w, 'term-2').element.dispatchEvent(dragEvent('drop', { [TERMINAL_DRAG_MIME]: 'term-9' }, 200));
    expect(store.move).toHaveBeenCalledWith({ kind: 'join', id: 'term-9', target: 'term-2', side: 'before' });
  });
});

describe('terminals in the editor area', () => {
  // term-1 and term-2 split in the panel, term-3 in the editor
  const withEditor = (): TerminalState => ({
    ...TERMINAL_STATE,
    terminals: [info('term-1'), info('term-2'), { ...info('term-3'), placement: 'editor' }],
    groups: [group('group-1', ['term-1', 'term-2'], [0.5, 0.5])],
    activeId: 'term-1',
  });
  const inPanel = (): TerminalState => ({ ...withEditor(), terminals: [info('term-1'), info('term-2'), info('term-3')], groups: [...withEditor().groups, group('group-2', ['term-3'], [1])] });

  // The editor pane's host of a terminal tab, as EditorPane.vue registers it.
  function editorHost(store: TerminalStore, id: string): HTMLElement {
    const host = document.createElement('div');
    host.id = `terminal-editor-host-${id}`;
    document.body.append(host);
    store.editorHosts.value = new Map([...store.editorHosts.value, [id, host]]);
    return host;
  }

  // in its pane box, or teleported out of the panes into a host
  const viewOf = (w: VueWrapper, id: string): Element => {
    const selector = `[data-testid="terminal-view"][data-terminal-id="${id}"]`;
    return w.element.querySelector(selector) ?? document.body.querySelector(selector)!;
  };

  it('teleports an editor terminal\'s view into its tab\'s host, shown only while its tab shows', async () => {
    const { wrapper: w, store } = mountPanes(withEditor());
    const host = editorHost(store, 'term-3');
    store.editorShown.value = 'term-3';
    await flushPromises();
    const view = viewOf(w, 'term-3');
    expect(host.contains(view)).toBe(true);
    expect(view.getAttribute('data-shown')).toBe('true');
    expect(box(w, 'term-3').element.contains(view)).toBe(false);
    expect(box(w, 'term-3').attributes('style')).toContain('display: none');
    store.editorShown.value = null;
    await nextTick();
    expect(view.getAttribute('data-shown')).toBe('false');
  });

  it('keeps the view in its pane box, teleport disabled, while its tab has no host yet', async () => {
    const { wrapper: w } = mountPanes(withEditor());
    await flushPromises();
    const view = viewOf(w, 'term-3');
    expect(box(w, 'term-3').element.contains(view)).toBe(true);
    expect(view.getAttribute('data-shown')).toBe('false');
  });

  it('moves the same view element between its pane box and its editor host, with no remount', async () => {
    const { wrapper: w, store } = mountPanes(inPanel());
    await flushPromises();
    const view = viewOf(w, 'term-3');
    const mounts = viewMounts;

    await w.setProps({ terminal: withEditor() });
    const host = editorHost(store, 'term-3');
    await flushPromises();
    expect(host.contains(view)).toBe(true);

    // Move Terminal into Panel: the tab and its host go, the view returns to its box.
    await w.setProps({ terminal: inPanel() });
    store.editorHosts.value = new Map();
    host.remove();
    await flushPromises();
    expect(box(w, 'term-3').element.contains(view)).toBe(true);

    // A later move into the editor takes the new tab's new host, never the one that went.
    await w.setProps({ terminal: withEditor() });
    const second = editorHost(store, 'term-3');
    await flushPromises();
    expect(second.contains(view)).toBe(true);
    expect(viewOf(w, 'term-3')).toBe(view);
    expect(viewMounts).toBe(mounts);
  });

  it('leaves the panel\'s panes, sashes and active pane to the panel terminals', async () => {
    const { wrapper: w } = mountPanes(withEditor());
    await flushPromises();
    expect(w.findAll('[data-testid="terminal-pane-sash"]')).toHaveLength(1);
    expect(box(w, 'term-1').attributes('data-active')).toBe('true');
  });
});
