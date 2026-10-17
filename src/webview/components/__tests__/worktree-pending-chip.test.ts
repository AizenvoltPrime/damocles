// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import WorktreePendingChip from '../composer/WorktreePendingChip.vue';
import { i18n } from '@/i18n';

/** happy-dom lays nothing out, so the target is read from the classes that size it; e2e captures check the pixels. */
describe('the opt-in chip\'s remove button', () => {
  it('keeps its small face and takes a target of at least 24px around it (WCAG 2.5.8)', () => {
    const wrapper = mount(WorktreePendingChip, { props: { branch: 'main' }, global: { plugins: [i18n] } });
    const classes = wrapper.get('[data-testid="worktree-chip-remove"]').classes();

    expect(classes).toContain('size-3.75');
    expect(classes).toEqual(expect.arrayContaining(['relative', 'before:absolute', 'before:-inset-1.25']));
  });
});
