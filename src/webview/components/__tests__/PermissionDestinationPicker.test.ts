// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { nextTick } from 'vue';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import PermissionDestinationPicker from '../PermissionDestinationPicker.vue';
import { i18n } from '@/i18n';

/** Where an always-allow or always-deny rule is saved: a confirmation on the restyled alert dialog. */

enableAutoUnmount(afterEach);
beforeEach(() => {
  document.body.innerHTML = '';
});

async function settle(): Promise<void> {
  await nextTick();
  await nextTick();
}

const picker = (): HTMLElement | null => document.body.querySelector('[data-testid="permission-destination-picker"]');

async function openFrom(opener: HTMLElement) {
  opener.focus();
  const wrapper = mount(PermissionDestinationPicker, {
    props: { open: false, pattern: 'Bash(ls:*)' },
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
  await wrapper.setProps({ open: true });
  await settle();
  return wrapper;
}

describe('the rule destination picker', () => {
  it('is an alert dialog that cancels once on Escape and hands focus back to what opened it', async () => {
    const opener = document.body.appendChild(document.createElement('button'));
    const wrapper = await openFrom(opener);
    expect(picker()?.getAttribute('role')).toBe('alertdialog');

    picker()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settle();
    expect(wrapper.emitted('cancel')).toEqual([[]]);

    await wrapper.setProps({ open: false });
    await settle();
    expect(picker()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('saves to the destination picked', async () => {
    const wrapper = await openFrom(document.body.appendChild(document.createElement('button')));

    picker()!.querySelector<HTMLButtonElement>('[data-testid="permission-destination-projectSettings"]')!.click();

    expect(wrapper.emitted('select')).toEqual([['projectSettings']]);
    expect(wrapper.emitted('cancel')).toBeUndefined();
  });
});
