// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import SidebarSection from '../components/SidebarSection.vue';
import { ALWAYS_SHOW_SECTION_ACTIONS, DOCKED_SECTION_ORDER, SECTION_ORDER, type SectionOrderController } from '../components/sidebar-section';
import { shellI18n } from '../i18n';

const mounted: VueWrapper[] = [];
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.restoreAllMocks();
});

function mountSection(options: { collapsed?: boolean; always?: boolean } = {}) {
  const always = ref(options.always ?? false);
  const wrapper = mount(SidebarSection, {
    props: { section: 'scm', collapsed: options.collapsed ?? false },
    slots: {
      actions: () => h('button', { type: 'button', 'data-testid': 'action' }, 'Refresh'),
      default: () => h('input', { 'data-testid': 'body-input' }),
    },
    global: { plugins: [shellI18n], provide: { [ALWAYS_SHOW_SECTION_ACTIONS as symbol]: always } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  const actions = () => wrapper.get<HTMLElement>('[data-testid="sidebar-section-actions"]').element;
  const shown = () => actions().style.display !== 'none';
  return { wrapper, always, shown, section: () => wrapper.get('section') };
}

// VS Code's paneview.css rule: hover or focus anywhere in the expanded pane shows the header actions.
describe('SidebarSection title actions', () => {
  it('take no space at rest, so the title reads in full', () => {
    const { shown, wrapper } = mountSection();
    expect(shown()).toBe(false);
    expect(wrapper.get('[data-testid="sidebar-section-title"]').text()).toBe('Source control');
  });

  it('render no bar for a section without actions, so a hover never takes the header\'s gap from the title', async () => {
    const wrapper = mount(SidebarSection, { props: { section: 'repos', collapsed: false }, global: { plugins: [shellI18n], provide: { [ALWAYS_SHOW_SECTION_ACTIONS as symbol]: ref(true) } } });
    mounted.push(wrapper);
    await wrapper.get('section').trigger('pointerenter');
    expect(wrapper.find('[data-testid="sidebar-section-actions"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="sidebar-section-title"]').text()).toBe('Repositories');
  });

  it('show while the section is hovered, body included', async () => {
    const { shown, section } = mountSection();
    await section().trigger('pointerenter');
    expect(shown()).toBe(true);
    await section().trigger('pointerleave');
    expect(shown()).toBe(false);
  });

  it('show while focus is within the section, so the header button leads Tab to them', async () => {
    const { shown, wrapper } = mountSection();
    wrapper.get<HTMLButtonElement>('h2 button').element.focus();
    await nextTick();
    expect(shown()).toBe(true);
    wrapper.get<HTMLButtonElement>('[data-testid="action"]').element.focus();
    await nextTick();
    expect(shown()).toBe(true);
    wrapper.get<HTMLInputElement>('[data-testid="body-input"]').element.focus();
    await nextTick();
    expect(shown()).toBe(true);
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    await nextTick();
    expect(shown()).toBe(false);
    outside.remove();
  });

  it('hide when focus leaves the page, unless a popup a title action opened is still up', async () => {
    const { shown, wrapper } = mountSection();
    const action = wrapper.get<HTMLButtonElement>('[data-testid="action"]').element;
    action.focus();
    await nextTick();
    expect(shown()).toBe(true);
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    await nextTick();
    expect(shown()).toBe(false);

    hasFocus.mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    await nextTick();
    expect(shown()).toBe(true);
    let close!: () => void;
    const held = (wrapper.vm as unknown as { holdActions: (popup: Promise<void>) => Promise<void> }).holdActions(new Promise<void>((resolve) => { close = resolve; }));
    hasFocus.mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    await nextTick();
    expect(shown()).toBe(true);
    close();
    await held;
    await nextTick();
    expect(shown()).toBe(false);
  });

  it('stay hidden while collapsed, whether hovered, focused or set to always show', async () => {
    const { shown, section, wrapper, always } = mountSection({ collapsed: true });
    await section().trigger('pointerenter');
    wrapper.get<HTMLButtonElement>('h2 button').element.focus();
    always.value = true;
    await nextTick();
    expect(shown()).toBe(false);
  });

  it('show whenever expanded with the setting on, and follow it live', async () => {
    const { shown, always } = mountSection({ always: true });
    expect(shown()).toBe(true);
    always.value = false;
    await nextTick();
    expect(shown()).toBe(false);
  });

  it('keep the count badge slot in the title', () => {
    const wrapper = mount(SidebarSection, {
      props: { section: 'scm', collapsed: false },
      slots: { badge: () => h('span', { 'data-testid': 'badge' }, '3') },
      global: { plugins: [shellI18n] },
    });
    mounted.push(wrapper);
    expect(wrapper.get('h2').find('[data-testid="badge"]').exists()).toBe(true);
  });

  // happy-dom lays nothing out, so this pins the structure; scm.spec.ts measures the Source control header in Chromium.
  it('put the title and its badge on one clipped wrapping line, so a badge with no room wraps out of sight before the title shortens', () => {
    const wrapper = mount(SidebarSection, {
      props: { section: 'scm', collapsed: false },
      slots: { badge: () => h('span', { 'data-testid': 'badge' }, '3') },
      global: { plugins: [shellI18n] },
    });
    mounted.push(wrapper);
    const line = wrapper.get('[data-testid="sidebar-section-title"]').element.parentElement!;
    expect(line.getAttribute('data-testid')).toBe('sidebar-section-title-line');
    expect(line.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'content-start', 'overflow-hidden', 'min-w-0', 'flex-1']));
    expect(wrapper.get('[data-testid="badge"]').element.parentElement).toBe(line);
  });
});

describe('the docked Ports section', () => {
  it('sits below every ordered section and sash, sized by its rows, and is never dragged or reordered', async () => {
    const ordering: SectionOrderController = { dragged: ref(null), orderOf: vi.fn(() => 3), drop: vi.fn(), openMenu: vi.fn(async () => {}) };
    const wrapper = mount(SidebarSection, { props: { section: 'ports', collapsed: false }, global: { plugins: [shellI18n], provide: { [SECTION_ORDER as symbol]: ordering } } });
    mounted.push(wrapper);
    const section = wrapper.get<HTMLElement>('section').element;
    expect(Number(section.style.order)).toBe(DOCKED_SECTION_ORDER);
    expect(DOCKED_SECTION_ORDER).toBe(15);
    expect(section.style.flex).toBe('0 0 auto');
    expect(wrapper.get('[data-testid="sidebar-section-title"]').text()).toBe('Ports');
    const header = wrapper.get('[data-testid="sidebar-section-header"]');
    expect(header.attributes('draggable')).toBe('false');
    await header.trigger('contextmenu');
    expect(ordering.openMenu).not.toHaveBeenCalled();
    expect(ordering.orderOf).not.toHaveBeenCalled();
    await wrapper.setProps({ collapsed: true });
    expect(section.style.flex).toBe('0 0 1.875rem');
  });
});

// A wallpapered sidebar is see-through, so neither the chip nor the actions over it may paint a ground.
describe('SidebarSection chip under the title actions', () => {
  type Observed = { callback: ResizeObserverCallback; target: Element };
  function mountChip() {
    const observed: Observed[] = [];
    vi.stubGlobal('ResizeObserver', class {
      private readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) { this.callback = callback; }
      observe(target: Element): void { observed.push({ callback: this.callback, target }); }
      unobserve(): void {}
      disconnect(): void {}
    });
    const wrapper = mount(SidebarSection, {
      props: { section: 'files', collapsed: false, hasChip: true },
      slots: { chip: '<button data-testid="chip">fix-login</button>', actions: '<button data-testid="action">New file</button>' },
      global: { plugins: [shellI18n] },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    const resize = (testid: string, width: number): void => {
      const target = wrapper.get(`[data-testid="${testid}"]`).element;
      const entry = { target, contentRect: { width }, borderBoxSize: [{ inlineSize: width }] } as unknown as ResizeObserverEntry;
      for (const each of observed.filter((one) => one.target === target)) each.callback([entry], {} as ResizeObserver);
    };
    return { wrapper, resize, cell: () => wrapper.get<HTMLElement>('[data-testid="sidebar-section-chip-slot"]'), actions: () => wrapper.get('[data-testid="sidebar-section-actions"]'), chip: () => wrapper.get('[data-testid="sidebar-section-chip"]') };
  }
  afterEach(() => vi.unstubAllGlobals());

  it('masks the chip under the shown actions by their measured width, and paints no surface on either', async () => {
    const { wrapper, resize, cell, actions, chip } = mountChip();
    expect(cell().classes().some((name) => name.startsWith('mask-'))).toBe(false);
    await wrapper.get('section').trigger('pointerenter');
    resize('sidebar-section-actions', 72);
    await nextTick();
    expect(cell().classes().filter((name) => name.startsWith('mask-'))).toEqual(['mask-[linear-gradient(to_left,transparent_calc(var(--actions-w)-1rem),black_var(--actions-w))]']);
    expect(cell().element.style.getPropertyValue('--actions-w')).toBe('72px');
    for (const element of [cell(), actions(), chip()]) {
      expect(element.classes().filter((name) => /--d-(panel|bg|pane-)|(^|:)(bg|from|via|to)-/.test(name))).toEqual([]);
    }
  });

  it('hides the actions over a chip that is pointed at or focused, and shows the chip whole', async () => {
    const { wrapper, resize, cell, actions, chip } = mountChip();
    await wrapper.get('section').trigger('pointerenter');
    resize('sidebar-section-chip-cell', 160);
    resize('sidebar-section-chip', 120);
    resize('sidebar-section-actions', 72);
    await chip().trigger('pointerenter');
    expect(actions().classes()).toContain('opacity-0');
    expect(actions().classes()).not.toContain('*:pointer-events-auto');
    expect(cell().classes().some((name) => name.startsWith('mask-'))).toBe(false);
    await chip().trigger('pointerleave');
    expect(actions().classes()).toContain('*:pointer-events-auto');
    expect(actions().classes()).not.toContain('opacity-0');
  });

  // Focus stays on a chip after its menu closes; hiding the actions for that focus alone left them out of the pointer's reach.
  it('hides the actions for a focused chip only while the pointer is not in the header', async () => {
    const { wrapper, resize, actions, chip } = mountChip();
    const header = wrapper.get('[data-testid="sidebar-section-header"]');
    await nextTick();
    resize('sidebar-section-chip-cell', 160);
    resize('sidebar-section-chip', 120);
    resize('sidebar-section-actions', 72);
    await chip().trigger('focusin');
    expect(actions().classes()).toContain('opacity-0');

    await wrapper.get('section').trigger('pointerenter');
    await header.trigger('pointerenter');
    expect(actions().classes()).not.toContain('opacity-0');
    expect(actions().classes()).toContain('*:pointer-events-auto');

    await chip().trigger('pointerenter');
    expect(actions().classes()).toContain('opacity-0');
    await chip().trigger('pointerleave');
    await header.trigger('pointerleave');
    expect(actions().classes()).toContain('opacity-0');
  });

  // The actions' box starts with 1.375rem of padding, where the chip's fade runs: a chip that ends there is under no button.
  it('keeps the actions shown over a pointed-at chip that reaches only into their leading padding', async () => {
    const { wrapper, resize, cell, actions, chip } = mountChip();
    await wrapper.get('section').trigger('pointerenter');
    resize('sidebar-section-chip-cell', 182);
    resize('sidebar-section-actions', 156);
    resize('sidebar-section-chip', 46);
    await chip().trigger('pointerenter');
    expect(actions().classes()).not.toContain('opacity-0');
    expect(cell().classes().some((name) => name.startsWith('mask-'))).toBe(false);
    resize('sidebar-section-chip', 49);
    await nextTick();
    expect(actions().classes()).toContain('opacity-0');
  });

  it('keeps the actions shown beside a pointed-at chip too short to reach under them', async () => {
    const { wrapper, resize, actions, chip } = mountChip();
    await wrapper.get('section').trigger('pointerenter');
    resize('sidebar-section-chip-cell', 260);
    resize('sidebar-section-chip', 80);
    resize('sidebar-section-actions', 72);
    await chip().trigger('pointerenter');
    expect(actions().classes()).not.toContain('opacity-0');
  });
});
