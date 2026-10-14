// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import SidebarSection from '../components/SidebarSection.vue';
import { ALWAYS_SHOW_SECTION_ACTIONS } from '../components/sidebar-section';
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
});
