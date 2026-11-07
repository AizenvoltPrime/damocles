// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { PlanApprovalDesignLink } from '@shared/types/design';
import { nextTick } from 'vue';
import PlanApprovalOverlay from '../PlanApprovalOverlay.vue';
import { i18n, loadLocale } from '@/i18n';
import { useDesignStore } from '@/stores/useDesignStore';

const posted = vi.hoisted(() => [] as unknown[]);
vi.mock('@/composables/usePlatformBridge', () => ({ usePlatformBridge: () => ({ postMessage: (message: unknown) => void posted.push(message) }) }));

const LINK: PlanApprovalDesignLink = {
  designId: 'contacts-1a2b3c4d',
  title: 'Contacts list',
  folder: '/home/u/.damocles/designs/contacts-1a2b3c4d',
  version: 2,
  screens: 1,
  decisions: 3,
  warnings: [
    { rule: 'ds.hidden-required', severity: 'warning', screen: 'S1', element: 'input#email', message: 'A required field is hidden at sm' },
    { rule: 'tokens.spacing', severity: 'warning', screen: 'S1', element: 'main', message: 'Off-scale gap' },
  ],
  journeysPassed: null,
};

const mounted: VueWrapper[] = [];

function mountOverlay(designLink?: PlanApprovalDesignLink): VueWrapper {
  const wrapper = mount(PlanApprovalOverlay, {
    props: { planContent: '# Plan\n\n1. Add the limiter', ...(designLink && { designLink }) },
    global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper as VueWrapper);
  return wrapper as VueWrapper;
}

const button = (wrapper: VueWrapper, label: string) => wrapper.findAll('button').find((b) => b.text() === label)!;
const scrimClick = (wrapper: VueWrapper) => wrapper.get('[data-testid="overlay-scrim"]').trigger('click');

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = '';
  i18n.global.locale.value = 'en';
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

describe('the linked design strip', () => {
  const strip = (wrapper: VueWrapper) => wrapper.find('[data-testid="design-plan-strip"]');

  it('is absent when the approval carries no design link', () => {
    expect(strip(mountOverlay()).exists()).toBe(false);
  });

  it('names the design, its version, its counts and the version the approval records', () => {
    const wrapper = mountOverlay(LINK);

    expect(strip(wrapper).attributes('aria-label')).toBe('Linked design');
    expect(wrapper.get('[data-testid="design-plan-strip-title"]').text()).toBe('Contacts list');
    expect(wrapper.get('[data-testid="design-plan-strip-version"]').text()).toBe('v2');
    expect(wrapper.get('[data-testid="design-plan-strip-counts"]').text()).toBe('1 screen · 3 decisions · 2 warnings');
    expect(wrapper.get('[data-testid="design-plan-strip-records"]').text()).toBe('approval records v2');
  });

  it('lists the warnings that travel with the version, open, and folds them away', async () => {
    const wrapper = mountOverlay(LINK);
    const list = () => wrapper.find('[data-testid="design-plan-strip-warnings"] ul');

    // Each by its rule's label and its element in the view's language; the check's English message is the model's.
    expect(list().text()).toContain('Required field hidden at a width S1 input#email');
    expect(list().text()).toContain('Spacing not from a token S1 main');
    expect(list().text()).not.toContain('Off-scale gap');

    await wrapper.get('[data-testid="design-plan-strip-warnings-toggle"]').trigger('click');
    expect(list().exists()).toBe(false);
  });

  it('shows no warnings section and says 0 warnings for a clean version', () => {
    const wrapper = mountOverlay({ ...LINK, warnings: [] });

    expect(wrapper.find('[data-testid="design-plan-strip-warnings"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="design-plan-strip-counts"]').text()).toBe('1 screen · 3 decisions · 0 warnings');
  });

  it('opens design.md and the design chat with the messages the result card sends', async () => {
    const wrapper = mountOverlay(LINK);

    await wrapper.get('[data-testid="design-plan-strip-open-md"]').trigger('click');
    await wrapper.get('[data-testid="design-plan-strip-open-chat"]').trigger('click');

    expect(posted).toEqual([
      { type: 'openDesignFile', designId: LINK.designId, file: 'design.md' },
      { type: 'openDesignChat', designId: LINK.designId },
    ]);
  });

  it('offers Open preview only where the host has the preview tab (FULL), and opens the screen picked there', async () => {
    const wrapper = mountOverlay(LINK);
    expect(wrapper.find('[data-testid="design-plan-strip-open-preview"]').exists()).toBe(false);

    useDesignStore().setOpenPreview(true);
    await nextTick();
    await wrapper.get('[data-testid="design-plan-strip-open-preview"]').trigger('click');
    expect(posted).toEqual([{ type: 'requestDesignFiles', designId: LINK.designId }]);
    useDesignStore().setFiles(LINK.designId, [{ path: 'design.md', bytes: 10 }, { path: 'screens/S1-contacts.html', bytes: 2048 }], false);
    await nextTick();

    const screen = document.querySelector<HTMLButtonElement>('[data-testid="design-screen"]')!;
    expect(screen.getAttribute('aria-label')).toBe('Open screens/S1-contacts.html in the preview tab');
    screen.click();
    expect(posted.at(-1)).toEqual({ type: 'openDesignPreview', designId: LINK.designId, relPath: 'screens/S1-contacts.html' });
  });

  it('pluralizes the counts in Greek', async () => {
    expect(await loadLocale('el')).toBe(true);
    i18n.global.locale.value = 'el';
    const wrapper = mountOverlay({ ...LINK, screens: 2, decisions: 1, warnings: LINK.warnings.slice(0, 1) });

    expect(wrapper.get('[data-testid="design-plan-strip-counts"]').text()).toBe('2 οθόνες · 1 απόφαση · 1 προειδοποίηση');
    expect(wrapper.get('[data-testid="design-plan-strip-records"]').text()).toBe('η έγκριση καταγράφει την v2');
  });
});
