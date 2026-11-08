// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, shallowRef } from 'vue';
import type { TerminalGroupInfo, TerminalInfo, TerminalState } from '../../preload/terminal-channels';
import TerminalList from '../terminal/TerminalList.vue';
import { endTerminalDrag, panelEndDrop, startTerminalDrag, TERMINAL_DRAG_MIME } from '../terminal/terminal-drag';
import { TERMINAL_STORE, type TerminalStore } from '../terminal/terminal-store';
import { shellI18n } from '../i18n';
import { TERMINAL_STATE, fakeShellApi, type FakeShellApi } from './fakes';

const info = (id: string, title = id): TerminalInfo => ({
  id, title, name: null, profileId: 'cmd', icon: 'cmd', customIcon: null, color: null, projectKey: 'alpha', projectName: 'alpha', status: 'running', exitCode: null, description: null, running: null, integrated: false, restoring: false, windowsBuild: null, pathFlavor: 'posix', placement: 'panel',
});
const group = (id: string, paneIds: string[]): TerminalGroupInfo => ({ id, paneIds, activePaneId: paneIds[0]!, sizes: paneIds.map(() => 1 / paneIds.length) });

const terminals = [info('term-1', 'dev server'), info('term-2', 'tests'), info('term-3', 'logs'), info('term-4', 'shell'), info('term-5', 'build')];
const groups = [group('group-1', ['term-1', 'term-2', 'term-3']), group('group-2', ['term-4']), group('group-3', ['term-5'])];

let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  endTerminalDrag();
  vi.useRealTimers();
});

const listState = (activeId: string): TerminalState => ({ ...TERMINAL_STATE, terminals, groups, activeId });

function mountList(activeId = 'term-2', attachTo?: HTMLElement): { api: FakeShellApi; wrapper: VueWrapper; store: TerminalStore } {
  const api = fakeShellApi();
  const store = { renaming: shallowRef(null), startRename: vi.fn(), state: shallowRef(listState(activeId)), moved: shallowRef(null), move: vi.fn() } as unknown as TerminalStore;
  wrapper = mount(TerminalList, {
    props: { api, platform: 'win32', terminals, groups, activeId, splitShortcut: 'Ctrl+Shift+5', widthRem: 12, panelWidth: 1200 },
    global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: store }, stubs: { transition: true, 'transition-group': false } },
    ...(attachTo ? { attachTo } : {}),
  });
  return { api, wrapper, store };
}

const row = (w: VueWrapper, id: string) => w.get(`[data-testid="terminal-row"][data-terminal-id="${id}"]`);

// happy-dom lays nothing out: rows stand 26px tall from the top, after the list's 4px padding.
const ROW_PX = 26;
function layOut(w: VueWrapper): void {
  w.findAll('[data-testid="terminal-row"]').forEach((found, index) => {
    const element = found.element as HTMLElement;
    element.getBoundingClientRect = () => ({ top: 4 + index * ROW_PX, bottom: 4 + (index + 1) * ROW_PX, height: ROW_PX, left: 0, right: 200, width: 200, x: 0, y: 4 + index * ROW_PX, toJSON: () => ({}) });
    Object.defineProperty(element, 'offsetTop', { configurable: true, value: 4 + index * ROW_PX });
    Object.defineProperty(element, 'offsetHeight', { configurable: true, value: ROW_PX });
  });
}

// A drag event whose transfer holds `data`; a dragover may read only its types, as in Chromium.
function dragEvent(type: string, data: Record<string, string>, point: { clientX?: number; clientY?: number } = {}): DragEvent {
  const entries = new Map(Object.entries(data));
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  const transfer = {
    get types() { return [...entries.keys()]; },
    getData: (format: string) => (type === 'drop' ? entries.get(format) ?? '' : ''),
    setData: (format: string, value: string) => void entries.set(format, value),
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
  };
  Object.defineProperties(event, { dataTransfer: { value: transfer }, clientX: { value: point.clientX ?? 0 }, clientY: { value: point.clientY ?? 0 } });
  return event;
}

const list = (w: VueWrapper) => w.get('[role="tablist"]');
const dropLine = (w: VueWrapper) => w.find('[data-testid="terminal-list-drop-line"]');

/** Starts dragging `id`'s row and returns the payload its dragstart set. */
async function startDrag(w: VueWrapper, id: string): Promise<Record<string, string>> {
  const payload: Record<string, string> = {};
  const event = dragEvent('dragstart', {});
  (event.dataTransfer as unknown as { setData: (format: string, value: string) => void }).setData = (format, value) => void (payload[format] = value);
  row(w, id).element.dispatchEvent(event);
  await nextTick();
  return payload;
}

describe('grouped terminal list', () => {
  it('lists one row per pane in group order', () => {
    const { wrapper: w } = mountList();
    expect(w.findAll('[data-testid="terminal-row"]').map((r) => r.attributes('data-terminal-id'))).toEqual(['term-1', 'term-2', 'term-3', 'term-4', 'term-5']);
  });

  // VS Code's ┌ ├ └ prefixes, drawn as lines; a single-pane group has none.
  it('draws the tree on the rows of a split group only', () => {
    const { wrapper: w } = mountList();
    expect(row(w, 'term-1').get('[data-testid="terminal-row-tree"]').attributes('data-tree')).toBe('first');
    expect(row(w, 'term-2').get('[data-testid="terminal-row-tree"]').attributes('data-tree')).toBe('middle');
    expect(row(w, 'term-3').get('[data-testid="terminal-row-tree"]').attributes('data-tree')).toBe('last');
    expect(row(w, 'term-4').find('[data-testid="terminal-row-tree"]').exists()).toBe(false);
    expect(row(w, 'term-1').get('[data-testid="terminal-row-tree"]').attributes('aria-hidden')).toBe('true');
  });

  // Accent stays the active row's bar alone; the shown group's tree is a step brighter than the others.
  it('draws the shown group\'s tree in the muted colour and other groups\' in the faint one', () => {
    const { wrapper: w } = mountList('term-2');
    expect(row(w, 'term-1').get('[data-testid="terminal-row-tree"]').classes()).toContain('text-(--d-muted)');
    wrapper!.unmount();
    const { wrapper: other } = mountList('term-4');
    expect(row(other, 'term-1').get('[data-testid="terminal-row-tree"]').classes()).toContain('text-(--d-faint)');
  });

  // VS Code's splitTerminalAriaLabel; aria-posinset on a tab would mean its place in the whole list.
  it('tells a screen reader where a pane sits in its group, and keeps tab semantics', () => {
    const { wrapper: w } = mountList();
    expect(row(w, 'term-2').get('[data-testid="terminal-row-split"]').text()).toBe('split 2 of 3');
    expect(row(w, 'term-4').find('[data-testid="terminal-row-split"]').exists()).toBe(false);
    expect(row(w, 'term-2').attributes('role')).toBe('tab');
    expect(row(w, 'term-2').attributes('aria-selected')).toBe('true');
    expect(row(w, 'term-2').attributes('aria-posinset')).toBeUndefined();
  });

  // role="tab" makes its children presentational, so without its own name a row would read its Split and Kill labels too.
  it('names each tab by its terminal alone and ties it to its panel', () => {
    const { wrapper: w } = mountList();
    expect(row(w, 'term-2').attributes('aria-label')).toBe('tests, split 2 of 3, Running');
    expect(row(w, 'term-4').attributes('aria-label')).toBe('shell, Running');
    expect(row(w, 'term-2').attributes('id')).toBe('terminal-row-term-2');
    expect(row(w, 'term-2').attributes('aria-controls')).toBe('terminal-panel-term-2');
  });

  it('selects the clicked pane and splits from the row\'s Split button', async () => {
    const { wrapper: w } = mountList();
    await row(w, 'term-3').trigger('click');
    expect(w.emitted('select')).toEqual([['term-3']]);
    await row(w, 'term-4').get('[data-testid="terminal-row-split-button"]').trigger('click');
    expect(w.emitted('split')).toEqual([['term-4']]);
    expect(w.emitted('select')).toHaveLength(1);
  });

  it('opens a row\'s menu under the row from Shift+F10 in keydown, which Blink turns into no contextmenu on macOS', async () => {
    const { api, wrapper: w } = mountList();
    api.answerNext({ kind: 'dismissed' });
    const event = new KeyboardEvent('keydown', { key: 'F10', code: 'F10', shiftKey: true, bubbles: true, cancelable: true });
    row(w, 'term-3').element.dispatchEvent(event);
    await vi.waitFor(() => expect(api.overlayRequests).toHaveLength(1));
    expect(event.defaultPrevented).toBe(true);
    expect(api.overlayRequests[0]).toMatchObject({ kind: 'menu' });
  });

  it('offers Unsplit in the row menu of a split pane and sends it for that pane', async () => {
    const { api, wrapper: w } = mountList();
    api.answerNext({ kind: 'menu', itemId: 'unsplit' });
    await row(w, 'term-2').trigger('contextmenu');
    await vi.waitFor(() => expect(api.terminal.unsplit).toHaveBeenCalledWith('term-2'));
    const request = api.overlayRequests.at(-1);
    expect(request?.kind === 'menu' && request.items.map((item) => (item.kind === 'item' ? item.id : '-')).slice(0, 2)).toEqual(['split', 'unsplit']);
  });
});

describe('arranging terminals in the list', () => {
  const MIME = { [TERMINAL_DRAG_MIME]: '' };

  it('drags a row with only its id and dims it; dropped on another group\'s row, its group moves past that whole group', async () => {
    const { wrapper: w, store } = mountList();
    layOut(w);
    expect(row(w, 'term-5').attributes('draggable')).toBe('true');
    const payload = await startDrag(w, 'term-5');
    expect(payload).toEqual({ [TERMINAL_DRAG_MIME]: 'term-5' });
    expect(row(w, 'term-5').attributes('data-dragging')).toBe('true');
    const over = dragEvent('dragover', MIME, { clientY: 40 });
    list(w).element.dispatchEvent(over);
    await nextTick();
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer!.dropEffect).toBe('move');
    // term-2's upper half, but the line stands at the top of its group, where term-5's group lands
    expect(dropLine(w).attributes('data-drop')).toBe('reorder');
    expect(dropLine(w).attributes('style')).toContain('translateY(3px)');
    const drop = dragEvent('drop', payload, { clientY: 40 });
    list(w).element.dispatchEvent(drop);
    await nextTick();
    expect(drop.defaultPrevented).toBe(true);
    expect(store.move).toHaveBeenCalledWith({ kind: 'reorder', id: 'term-5', target: 'term-2', side: 'before' });
    expect(dropLine(w).exists()).toBe(false);
    expect(row(w, 'term-5').attributes('data-dragging')).toBeUndefined();
  });

  it('reorders a pane among its own group\'s rows, the line beside the target row', async () => {
    const { wrapper: w, store } = mountList();
    layOut(w);
    const payload = await startDrag(w, 'term-1');
    list(w).element.dispatchEvent(dragEvent('dragover', MIME, { clientY: 70 }));
    await nextTick();
    expect(dropLine(w).attributes('style')).toContain('translateY(81px)');
    list(w).element.dispatchEvent(dragEvent('drop', payload, { clientY: 70 }));
    expect(store.move).toHaveBeenCalledWith({ kind: 'reorder', id: 'term-1', target: 'term-3', side: 'after' });
  });

  it('takes an editor terminal\'s tab back into the panel: beside a row\'s whole group, or below the rows at the end', async () => {
    const { wrapper: w, store } = mountList();
    layOut(w);
    const start = new Event('dragstart') as DragEvent;
    Object.defineProperty(start, 'dataTransfer', { value: { setData: () => undefined, effectAllowed: 'none' } });
    startTerminalDrag(start, 'term-9');
    list(w).element.dispatchEvent(dragEvent('dragover', MIME, { clientY: 40 }));
    await nextTick();
    // term-2's upper half; it lands as a group of its own before term-2's group
    expect(dropLine(w).attributes('style')).toContain('translateY(3px)');
    list(w).element.dispatchEvent(dragEvent('drop', { [TERMINAL_DRAG_MIME]: 'term-9' }, { clientY: 40 }));
    expect(store.move).toHaveBeenLastCalledWith({ kind: 'reorder', id: 'term-9', target: 'term-2', side: 'before' });
    startTerminalDrag(start, 'term-9');
    list(w).element.dispatchEvent(dragEvent('drop', { [TERMINAL_DRAG_MIME]: 'term-9' }, { clientY: 200 }));
    expect(store.move).toHaveBeenLastCalledWith({ kind: 'detach', id: 'term-9' });
  });

  it('detaches a terminal dropped on the empty area below the rows', async () => {
    const { wrapper: w, store } = mountList();
    layOut(w);
    const payload = await startDrag(w, 'term-2');
    list(w).element.dispatchEvent(dragEvent('dragover', MIME, { clientY: 200 }));
    await nextTick();
    expect(dropLine(w).attributes('data-drop')).toBe('detach');
    expect(dropLine(w).attributes('style')).toContain('translateY(133px)');
    list(w).element.dispatchEvent(dragEvent('drop', payload, { clientY: 200 }));
    expect(store.move).toHaveBeenCalledWith({ kind: 'detach', id: 'term-2' });
  });

  it('shows no line over the dragged row itself, sends nothing for it, and leaves other drags alone', async () => {
    const { wrapper: w, store } = mountList();
    layOut(w);
    const payload = await startDrag(w, 'term-4');
    list(w).element.dispatchEvent(dragEvent('dragover', MIME, { clientY: 90 }));
    await nextTick();
    expect(dropLine(w).exists()).toBe(false);
    list(w).element.dispatchEvent(dragEvent('drop', payload, { clientY: 90 }));
    expect(store.move).not.toHaveBeenCalled();
    const files = dragEvent('dragover', { Files: '' }, { clientY: 40 });
    list(w).element.dispatchEvent(files);
    await nextTick();
    expect(files.defaultPrevented).toBe(false);
    expect(dropLine(w).exists()).toBe(false);
  });

  it('takes no drop where the terminal already is: the halves beside its own place, and below the rows for one alone at the end', async () => {
    const { wrapper: w, store } = mountList();
    layOut(w);
    // term-4's group of one stands between term-3's group and term-5's
    const payload = await startDrag(w, 'term-4');
    for (const clientY of [4 + 2 * ROW_PX + 20, 4 + 4 * ROW_PX + 5]) {
      const over = dragEvent('dragover', MIME, { clientY });
      list(w).element.dispatchEvent(over);
      await nextTick();
      expect(over.defaultPrevented).toBe(false);
      expect(dropLine(w).exists()).toBe(false);
      list(w).element.dispatchEvent(dragEvent('drop', payload, { clientY }));
    }
    // within a group: term-1 over term-2's upper half
    endTerminalDrag();
    const first = await startDrag(w, 'term-1');
    const within = dragEvent('dragover', MIME, { clientY: 4 + ROW_PX + 5 });
    list(w).element.dispatchEvent(within);
    await nextTick();
    expect(within.defaultPrevented).toBe(false);
    list(w).element.dispatchEvent(dragEvent('drop', first, { clientY: 4 + ROW_PX + 5 }));
    endTerminalDrag();
    const last = await startDrag(w, 'term-5');
    const below = dragEvent('dragover', MIME, { clientY: 200 });
    list(w).element.dispatchEvent(below);
    await nextTick();
    expect(below.defaultPrevented).toBe(false);
    expect(dropLine(w).exists()).toBe(false);
    expect(list(w).attributes('data-drop')).toBeUndefined();
    list(w).element.dispatchEvent(dragEvent('drop', last, { clientY: 200 }));
    expect(store.move).not.toHaveBeenCalled();
  });

  it('lights the list with the header strip as one end target, the line at the list\'s end', async () => {
    const { wrapper: w } = mountList();
    layOut(w);
    await startDrag(w, 'term-2');
    list(w).element.dispatchEvent(dragEvent('dragover', MIME, { clientY: 200 }));
    await nextTick();
    expect(list(w).attributes('data-drop')).toBe('true');
    expect(panelEndDrop.value).toBe('list');
    list(w).element.dispatchEvent(dragEvent('dragover', MIME, { clientY: 40 }));
    await nextTick();
    expect(list(w).attributes('data-drop')).toBeUndefined();
    // over the header strip: the list lights too and its line marks the end
    panelEndDrop.value = 'header';
    list(w).element.dispatchEvent(Object.defineProperty(dragEvent('dragleave', MIME), 'relatedTarget', { value: null }));
    await nextTick();
    expect(list(w).attributes('data-drop')).toBe('true');
    expect(dropLine(w).attributes('data-drop')).toBe('detach');
    expect(dropLine(w).attributes('style')).toContain('translateY(133px)');
    row(w, 'term-2').element.dispatchEvent(dragEvent('dragend', MIME));
    await nextTick();
    expect(list(w).attributes('data-drop')).toBeUndefined();
    expect(dropLine(w).exists()).toBe(false);
  });

  it('hides the line when the drag leaves the list, and when it ends', async () => {
    const { wrapper: w } = mountList();
    layOut(w);
    await startDrag(w, 'term-5');
    list(w).element.dispatchEvent(dragEvent('dragover', MIME, { clientY: 40 }));
    await nextTick();
    list(w).element.dispatchEvent(dragEvent('dragleave', MIME));
    await nextTick();
    expect(dropLine(w).exists()).toBe(false);
    list(w).element.dispatchEvent(dragEvent('dragover', MIME, { clientY: 40 }));
    row(w, 'term-5').element.dispatchEvent(dragEvent('dragend', MIME));
    await nextTick();
    expect(dropLine(w).exists()).toBe(false);
  });

  // VS Code's list shows a hovered terminal after 500 ms, so a pane of another group can take the drop.
  it('shows the terminal of a row hovered for a moment during a drag', async () => {
    vi.useFakeTimers();
    const { api, wrapper: w } = mountList('term-2');
    layOut(w);
    await startDrag(w, 'term-5');
    list(w).element.dispatchEvent(dragEvent('dragover', MIME, { clientY: 90 }));
    vi.advanceTimersByTime(400);
    list(w).element.dispatchEvent(dragEvent('dragover', MIME, { clientY: 95 }));
    vi.advanceTimersByTime(100);
    expect(api.terminal.select).toHaveBeenCalledWith('term-4');
    vi.mocked(api.terminal.select).mockClear();
    list(w).element.dispatchEvent(dragEvent('dragover', MIME, { clientY: 40 }));
    vi.advanceTimersByTime(600);
    expect(api.terminal.select).not.toHaveBeenCalled();
  });

  it('moves the focused row a place with Alt+Up and Alt+Down, and not past either end', async () => {
    const { wrapper: w, store } = mountList();
    await row(w, 'term-4').trigger('keydown', { key: 'ArrowUp', altKey: true });
    expect(store.move).toHaveBeenLastCalledWith({ kind: 'step', id: 'term-4', delta: -1 });
    await row(w, 'term-4').trigger('keydown', { key: 'ArrowDown', altKey: true });
    expect(store.move).toHaveBeenLastCalledWith({ kind: 'step', id: 'term-4', delta: 1 });
    vi.mocked(store.move).mockClear();
    const top = new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true });
    row(w, 'term-1').element.dispatchEvent(top);
    await row(w, 'term-5').trigger('keydown', { key: 'ArrowDown', altKey: true });
    expect(store.move).not.toHaveBeenCalled();
    expect(top.defaultPrevented).toBe(true);
    expect(row(w, 'term-1').attributes('aria-keyshortcuts')).toContain('Alt+ArrowUp');
  });

  it('keeps a row moved by keyboard in view, scrolling without motion when motion is reduced', async () => {
    const { wrapper: w } = mountList('term-2', document.body);
    // two rows' height of the list shows; each row stands where its element is now in the list
    const scroller = list(w).element as HTMLElement;
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 2 * ROW_PX });
    let scrollTop = 0;
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => scrollTop });
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;
    for (const found of w.findAll('[data-testid="terminal-row"]')) {
      Object.defineProperty(found.element, 'offsetTop', { configurable: true, get(this: HTMLElement) { return 4 + [...scroller.querySelectorAll('[data-terminal-row]')].indexOf(this) * ROW_PX; } });
      Object.defineProperty(found.element, 'offsetHeight', { configurable: true, value: ROW_PX });
    }
    (row(w, 'term-2').element as HTMLElement).focus();
    const moved = [terminals[0]!, terminals[2]!, terminals[1]!, terminals[3]!, terminals[4]!];
    await w.setProps({ terminals: moved });
    await nextTick();
    // term-2's row now ends at 4 + 3 rows, below the 2 rows shown
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 4 + 3 * ROW_PX - 2 * ROW_PX, behavior: 'smooth' });
    expect(document.activeElement).toBe(row(w, 'term-2').element);
    document.documentElement.setAttribute('data-reduced-motion', '');
    try {
      scrollTop = 3 * ROW_PX;
      await w.setProps({ terminals });
      await nextTick();
      // back at 4 + 1 row, above the rows shown
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 4 + ROW_PX, behavior: 'instant' });
    } finally {
      document.documentElement.removeAttribute('data-reduced-motion');
    }
  });

  it('offers Join Terminals..., Move Up and Move Down in the row menu, each enabled where it can act', async () => {
    const { api, wrapper: w, store } = mountList();
    const enabled = () => {
      const request = api.overlayRequests.at(-1);
      return request?.kind === 'menu' ? request.items.flatMap((item) => (item.kind === 'item' && ['joinTerminals', 'moveUp', 'moveDown'].includes(item.id) ? [`${item.id}${item.disabled ? ':off' : ''}`] : [])) : [];
    };
    api.answerNext({ kind: 'menu', itemId: 'moveDown' });
    await row(w, 'term-1').trigger('contextmenu');
    await vi.waitFor(() => expect(store.move).toHaveBeenCalledWith({ kind: 'step', id: 'term-1', delta: 1 }));
    expect(enabled()).toEqual(['joinTerminals', 'moveUp:off', 'moveDown']);
    api.answerNext({ kind: 'menu', itemId: 'joinTerminals' });
    await row(w, 'term-5').trigger('contextmenu');
    await vi.waitFor(() => expect(api.terminal.joinPick).toHaveBeenCalledWith('term-5'));
    expect(enabled()).toEqual(['joinTerminals', 'moveUp', 'moveDown:off']);
  });
});
