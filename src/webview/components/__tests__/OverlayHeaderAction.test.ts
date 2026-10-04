// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { h, markRaw } from 'vue';
import OverlayHeaderAction from '../OverlayHeaderAction.vue';
import OverlayShell from '../OverlayShell.vue';
import { i18n } from '@/i18n';

const StubIcon = markRaw({ render: () => h('svg', { 'data-icon': 'stub' }) });

describe('OverlayHeaderAction', () => {
  it('is a named button that reports clicks', async () => {
    const wrapper = mount(OverlayHeaderAction, { props: { label: 'Reload config', icon: StubIcon, title: 'Re-read every config file' } });
    const button = wrapper.get('button');
    expect(button.attributes('type')).toBe('button');
    expect(button.text()).toBe('Reload config');
    expect(button.attributes('title')).toBe('Re-read every config file');
    await button.trigger('click');
    expect(wrapper.emitted('click')).toHaveLength(1);
  });

  it('names an icon-only action through aria-label', () => {
    const wrapper = mount(OverlayHeaderAction, { props: { label: 'Audit memories', icon: StubIcon, iconOnly: true } });
    const button = wrapper.get('button');
    expect(button.attributes('aria-label')).toBe('Audit memories');
    expect(button.text()).toBe('');
  });

  it('turns a loader in place of its icon while busy, and stays clickable unless disabled', () => {
    const busy = mount(OverlayHeaderAction, { props: { label: 'Reloading…', icon: StubIcon, busy: true } });
    expect(busy.get('button').attributes('aria-busy')).toBe('true');
    expect(busy.find('[data-icon="stub"]').exists()).toBe(false);
    expect(busy.get('svg').classes()).toContain('d-spinning');

    const disabled = mount(OverlayHeaderAction, { props: { label: 'Run now', icon: StubIcon, disabled: true, primary: true } });
    expect(disabled.get('button').attributes('disabled')).toBeDefined();
  });
});

describe('OverlayShell status chip', () => {
  it('pulses its dot only when asked and keeps the label as a tooltip', () => {
    const wrapper = mount(OverlayShell, {
      props: { title: 'Memory consolidation', icon: StubIcon, statusBadge: { label: 'Running', class: 'text-(--d-accent)', pulse: true } },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    const chip = wrapper.get('[data-testid="overlay-status"]');
    expect(chip.attributes('title')).toBe('Running');
    expect(chip.find('.d-pulsing').exists()).toBe(true);
    wrapper.unmount();
  });
});

describe('OverlayShell initial focus', () => {
  it('focuses a body control marked data-overlay-initial-focus before its own close button', () => {
    const wrapper = mount(OverlayShell, {
      props: { title: 'Prompt navigator', icon: StubIcon },
      slots: { default: () => h('input', { 'data-overlay-initial-focus': '', 'data-testid': 'search' }) },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    expect(document.activeElement?.getAttribute('data-testid')).toBe('search');
    wrapper.unmount();
  });
});
