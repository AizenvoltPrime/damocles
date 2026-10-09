// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { DEFAULT_GRID_LAYOUT, type ShellGridLayout, type ShellState } from '../../preload/shell-channels';
import type { OverlayAnswer } from '../../preload/overlay-channels';
import { LAYOUT_SETTLED_EVENT } from '../content-bounds';
import LayoutGrid from '../layout/LayoutGrid.vue';
import Sash from '../layout/Sash.vue';
import { shellI18n } from '../i18n';
import { STATE, fakeShellApi } from './fakes';

// The editor beside the chat and the terminal below: both sashes show.
const WITH_TERMINAL: ShellState = { ...STATE, layout: { ...STATE.layout, grid: { ...DEFAULT_GRID_LAYOUT, visible: { editor: true, terminal: true } } } };

let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-reduced-motion');
});

function mountGrid(state: ShellState = WITH_TERMINAL) {
  const api = fakeShellApi();
  wrapper = mount(LayoutGrid, {
    props: { api, state, focusOverlay: false },
    global: { plugins: [shellI18n], stubs: { transition: true, TerminalPane: true, PaneGrip: true } },
  });
  const sash = wrapper.findAllComponents(Sash).find((candidate) => candidate.props('orientation') === 'horizontal')!;
  const style = (): CSSStyleDeclaration => (wrapper!.get('[data-testid="layout-grid"]').element as HTMLElement).style;
  return { api, sash, style };
}

describe('layout grid sashes', () => {
  it('keeps the size a pointer drag released at, and reports only the grid sizes', async () => {
    const { api, sash, style } = mountGrid();
    sash.vm.$emit('start');
    sash.vm.$emit('resize', 400);
    await wrapper!.vm.$nextTick();
    expect(style().gridTemplateRows).toContain('400px');
    expect(style().transition).toBe('none');

    sash.vm.$emit('commit');
    await wrapper!.vm.$nextTick();
    expect(style().gridTemplateRows).toContain('400px');
    expect(api.reportGridSizes).toHaveBeenCalledWith({ sideWidth: DEFAULT_GRID_LAYOUT.sideWidth, bottomHeight: 400 });
    expect(api.reportSidebarLayout).not.toHaveBeenCalled();
  });

  it('glides a keyboard step and keeps it', async () => {
    const { api, sash, style } = mountGrid();
    sash.vm.$emit('resize', 300);
    sash.vm.$emit('commit');
    await wrapper!.vm.$nextTick();
    expect(style().gridTemplateRows).toContain('300px');
    expect(style().transition).toContain('grid-template-rows');
    expect(api.reportGridSizes).toHaveBeenLastCalledWith({ sideWidth: DEFAULT_GRID_LAYOUT.sideWidth, bottomHeight: 300 });
  });

  // A push main made for another reason carries the sizes it stored earlier; only a layout main replaced itself resets them.
  it('ignores older sizes in a state push and takes main\'s sizes when main replaced the layout', async () => {
    const { sash, style } = mountGrid();
    sash.vm.$emit('start');
    sash.vm.$emit('resize', 400);
    sash.vm.$emit('commit');
    await wrapper!.vm.$nextTick();

    await wrapper!.setProps({ state: { ...WITH_TERMINAL, layout: { ...WITH_TERMINAL.layout, grid: { ...WITH_TERMINAL.layout.grid } } } });
    expect(style().gridTemplateRows).toContain('400px');

    const reset = { ...WITH_TERMINAL.layout.grid, bottomHeight: 250 };
    await wrapper!.setProps({ state: { ...WITH_TERMINAL, layout: { ...WITH_TERMINAL.layout, grid: reset }, layoutRevision: 1 } });
    expect(style().gridTemplateRows).toContain('250px');
  });
});

// Each slot's rectangle at the default layout, so a pane that changes slot has somewhere to glide from.
const SLOT_RECTS: Record<string, { left: number; top: number; width: number; height: number }> = {
  main: { left: 0, top: 0, width: 600, height: 500 },
  side: { left: 605, top: 0, width: 395, height: 500 },
  bottom: { left: 0, top: 505, width: 1000, height: 230 },
};

function stubSlotRects(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const rect = SLOT_RECTS[this.dataset.slot ?? ''] ?? { left: 0, top: 0, width: 0, height: 0 };
    return { ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => rect } as DOMRect;
  });
}

function countSettled(): { count: () => number } {
  let count = 0;
  const listener = (): void => { count++; };
  beforeEach(() => window.addEventListener(LAYOUT_SETTLED_EVENT, listener));
  afterEach(() => window.removeEventListener(LAYOUT_SETTLED_EVENT, listener));
  return { count: () => count };
}

const SWAPPED: ShellGridLayout = { ...WITH_TERMINAL.layout.grid, slots: { main: 'chat', side: 'terminal', bottom: 'editor' } };
const swapped = (): ShellState => ({ ...WITH_TERMINAL, layout: { ...WITH_TERMINAL.layout, grid: SWAPPED } });

describe('layout grid pane moves', () => {
  const settled = countSettled();

  it('announces the layout settled once every pane that changed slot has finished gliding', async () => {
    stubSlotRects();
    const finishes: Array<() => void> = [];
    const animate = vi.fn(() => ({ finished: new Promise<void>((resolve) => finishes.push(resolve)) }) as unknown as Animation);
    Object.defineProperty(HTMLElement.prototype, 'animate', { value: animate, configurable: true, writable: true });
    mountGrid();
    const before = settled.count();

    await wrapper!.setProps({ state: swapped() });
    await flushPromises();
    expect(animate).toHaveBeenCalledTimes(2);
    expect(settled.count()).toBe(before);
    finishes[0]!();
    await flushPromises();
    expect(settled.count()).toBe(before);
    finishes[1]!();
    await flushPromises();
    expect(settled.count()).toBe(before + 1);
  });

  it('announces it right after the move when motion is reduced', async () => {
    document.documentElement.setAttribute('data-reduced-motion', '');
    stubSlotRects();
    const animate = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'animate', { value: animate, configurable: true, writable: true });
    mountGrid();
    const before = settled.count();
    await wrapper!.setProps({ state: swapped() });
    await flushPromises();
    expect(animate).not.toHaveBeenCalled();
    expect(settled.count()).toBe(before + 1);
  });
});

describe('layout grid pane drag', () => {
  function mountDraggable(requestOverlay: (request: unknown) => Promise<OverlayAnswer>) {
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => {});
    const api = fakeShellApi([], { requestOverlay: vi.fn(requestOverlay) });
    wrapper = mount(LayoutGrid, {
      props: { api, state: WITH_TERMINAL, focusOverlay: false },
      global: { plugins: [shellI18n], stubs: { transition: true, TerminalPane: true } },
      attachTo: document.body,
    });
    const grip = wrapper.get('[data-testid="pane-grip-chat"]');
    const drag = async (pointerId: number): Promise<void> => {
      await grip.trigger('pointerdown', { button: 0, pointerId, clientX: 10, clientY: 10 });
      await grip.trigger('pointermove', { pointerId, clientX: 40, clientY: 40 });
    };
    return { api, grip, drag };
  }

  it('ends a drag whose drop zones request fails, so the next drag starts', async () => {
    const { api, grip, drag } = mountDraggable(vi.fn()
      .mockRejectedValueOnce(new Error('No handler registered'))
      .mockResolvedValue({ kind: 'dropZones', slot: null }));
    await drag(1);
    await grip.trigger('pointerup', { pointerId: 1 });
    await flushPromises();
    expect(grip.classes()).not.toContain('bg-(--d-accent-soft)');
    await drag(1);
    expect(api.requestOverlay).toHaveBeenCalledTimes(2);
  });

  it('stops following a pointer whose capture was lost, and a new press drops the last press\'s listeners', async () => {
    const { api, grip, drag } = mountDraggable(async () => ({ kind: 'dropZones', slot: null }));
    await grip.trigger('pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    await grip.trigger('lostpointercapture', { pointerId: 1 });
    await grip.trigger('pointermove', { pointerId: 1, clientX: 40, clientY: 40 });
    expect(api.requestOverlay).not.toHaveBeenCalled();

    await grip.trigger('pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    await grip.trigger('pointerdown', { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
    await grip.trigger('pointermove', { pointerId: 1, clientX: 40, clientY: 40 });
    expect(api.requestOverlay).not.toHaveBeenCalled();
    await drag(3);
    expect(api.requestOverlay).toHaveBeenCalledOnce();
  });
});

describe('a pane drag whose pointer capture ends', () => {
  // Chromium ends the grip's capture when main shows the overlay above the shell; the window still gets the pressed pointer.
  it('follows the pointer and its release through the window once the drag began', async () => {
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => {});
    const api = fakeShellApi([], { requestOverlay: vi.fn(async () => ({ kind: 'dropZones' as const, slot: null })) });
    wrapper = mount(LayoutGrid, {
      props: { api, state: WITH_TERMINAL, focusOverlay: false },
      global: { plugins: [shellI18n], stubs: { transition: true, TerminalPane: true } },
      attachTo: document.body,
    });
    const grip = wrapper.get('[data-testid="pane-grip-chat"]');
    await grip.trigger('pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    await grip.trigger('pointermove', { pointerId: 1, clientX: 40, clientY: 40 });
    expect(api.requestOverlay).toHaveBeenCalledOnce();
    await grip.trigger('lostpointercapture', { pointerId: 1 });
    const chatSlot = wrapper.get('[data-testid="chat-slot"]').element;
    chatSlot.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 300, clientY: 200, bubbles: true }));
    expect(api.reportDropZonesPointer).toHaveBeenLastCalledWith({ x: 300, y: 200, released: false });
    chatSlot.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 310, clientY: 210, bubbles: true }));
    expect(api.reportDropZonesPointer).toHaveBeenLastCalledWith({ x: 310, y: 210, released: true });
    chatSlot.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 320, clientY: 220, bubbles: true }));
    expect(api.reportDropZonesPointer).toHaveBeenCalledTimes(2);
  });
});

describe('a sash sizing the pane before it', () => {
  function mountSash(pane?: 'before') {
    wrapper = mount(Sash, { props: { orientation: 'horizontal', label: 'Resize', value: 150, min: 60, max: 400, ...(pane ? { pane } : {}) }, global: { plugins: [shellI18n] } });
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => {});
    return wrapper;
  }

  it('grows the section above as the sash moves down, by pointer and by key, and reports that size', async () => {
    const sash = mountSash('before');
    expect(sash.attributes('aria-valuenow')).toBe('150');
    await sash.trigger('pointerdown', { button: 0, pointerId: 1, clientY: 200 });
    await sash.trigger('pointermove', { pointerId: 1, clientY: 250 });
    expect(sash.emitted('resize')!.at(-1)).toEqual([200]);
    await sash.trigger('pointerup', { pointerId: 1 });
    await sash.trigger('keydown', { key: 'ArrowDown' });
    await sash.trigger('keydown', { key: 'ArrowUp' });
    const [down, up] = sash.emitted('resize')!.slice(-2).map(([size]) => size as number);
    expect(down).toBeGreaterThan(150);
    expect(up).toBeLessThan(150);
  });

  it('shrinks the slot below as the sash moves down by default, and leaves its stacking to the caller', async () => {
    const sash = mountSash();
    await sash.trigger('pointerdown', { button: 0, pointerId: 1, clientY: 200 });
    await sash.trigger('pointermove', { pointerId: 1, clientY: 250 });
    expect(sash.emitted('resize')!.at(-1)).toEqual([100]);
    expect(sash.classes()).not.toContain('z-2');
  });
});
