// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import PlanApprovalOverlay from '../PlanApprovalOverlay.vue';
import { i18n } from '@/i18n';

const mounted: VueWrapper[] = [];

function mountOverlay(): VueWrapper {
  const wrapper = mount(PlanApprovalOverlay, {
    props: { planContent: '# Plan\n\n1. Add the limiter' },
    global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper as VueWrapper);
  return wrapper as VueWrapper;
}

const button = (wrapper: VueWrapper, label: string) => wrapper.findAll('button').find((b) => b.text() === label)!;
const scrimClick = (wrapper: VueWrapper) => wrapper.get('[data-testid="overlay-scrim"]').trigger('click');

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = '';
});

describe('PlanApprovalOverlay', () => {
  it('approves with each mode its button names', async () => {
    const wrapper = mountOverlay();

    await button(wrapper, 'Yes, manually approve').trigger('click');
    await button(wrapper, 'Yes, auto-accept edits').trigger('click');
    await button(wrapper, 'Clear context & auto-accept').trigger('click');

    expect(wrapper.emitted('approve')).toEqual([
      [{ approvalMode: 'manual' }],
      [{ approvalMode: 'acceptEdits' }],
      [{ approvalMode: 'acceptEdits', clearContext: true }],
    ]);
  });

  it('sends trimmed feedback from the button and from Ctrl+Enter, and never empty feedback', async () => {
    const wrapper = mountOverlay();
    const send = button(wrapper, 'Send Feedback');
    expect(send.attributes('disabled')).toBeDefined();

    await wrapper.get('[data-testid="plan-feedback"]').setValue('  use a sliding window  ');
    await send.trigger('click');
    await wrapper.get('[data-testid="plan-feedback"]').trigger('keydown', { key: 'Enter', ctrlKey: true });

    expect(wrapper.emitted('feedback')).toEqual([['use a sliding window'], ['use a sliding window']]);
  });

  it('dismisses from a scrim click only while no feedback is typed', async () => {
    const wrapper = mountOverlay();

    await wrapper.get('[data-testid="plan-feedback"]').setValue('keep the 429 body');
    await scrimClick(wrapper);
    expect(wrapper.emitted('dismiss')).toBeUndefined();

    await wrapper.get('[data-testid="plan-feedback"]').setValue('   ');
    await scrimClick(wrapper);
    expect(wrapper.emitted('dismiss')).toEqual([[]]);
  });
});
