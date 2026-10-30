// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import SettingInput, { type InputParse } from '../controls/SettingInput.vue';

const parseCount: InputParse<number> = (raw) => (/^\d+$/.test(raw) ? { ok: true, value: Number(raw) } : { ok: false, error: 'Enter a whole number.' });

const REFUSAL = 'The host refused this value.';

const mounted: VueWrapper[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = '';
});

function mountField() {
  const wrapper = mount(SettingInput, { props: { modelValue: '5', parse: parseCount, label: 'Count', refusal: REFUSAL }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

/** Presses Escape in the field; true when it reached the modal around the field. */
async function escapeReachesModal(wrapper: VueWrapper): Promise<boolean> {
  let reached = false;
  const modal = (event: KeyboardEvent) => { if (event.key === 'Escape') reached = true; };
  document.body.addEventListener('keydown', modal);
  await wrapper.find('input').trigger('keydown', { key: 'Escape' });
  document.body.removeEventListener('keydown', modal);
  return reached;
}

const shownError = (wrapper: VueWrapper) => wrapper.find('[data-testid="setting-invalid"]').text();

describe('SettingInput, a refusal from its owner', () => {
  it('lets Escape reach the modal when the field holds only a refusal', async () => {
    const wrapper = mountField();
    expect(shownError(wrapper)).toBe(REFUSAL);

    expect(await escapeReachesModal(wrapper)).toBe(true);
    expect(shownError(wrapper)).toBe(REFUSAL);
  });

  it('keeps Escape after an edit, reverting the draft', async () => {
    const wrapper = mountField();
    await wrapper.find('input').setValue('7');

    expect(await escapeReachesModal(wrapper)).toBe(false);
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('5');
    expect(await escapeReachesModal(wrapper)).toBe(true);
  });

  it('shows a parse error in place of the refusal, which the edit already dismissed', async () => {
    const wrapper = mountField();
    await wrapper.find('input').setValue('x');
    await wrapper.find('input').trigger('keydown', { key: 'Enter' });

    expect(shownError(wrapper)).toBe('Enter a whole number.');
    expect(wrapper.find('input').attributes('aria-invalid')).toBe('true');
    expect(wrapper.emitted('commit')).toBeUndefined();

    expect(await escapeReachesModal(wrapper)).toBe(false);
    expect(wrapper.find('[data-testid="setting-invalid"]').exists()).toBe(false);
  });

  // A refusal judges the value that was sent, as a server-side form error does.
  it('hides the refusal and aria-invalid once the user edits the refused value, even back to it', async () => {
    const wrapper = mountField();
    const input = wrapper.find('input');
    expect(input.attributes('aria-invalid')).toBe('true');

    await input.setValue('7');
    expect(wrapper.find('[data-testid="setting-invalid"]').exists()).toBe(false);
    expect(input.attributes('aria-invalid')).toBeUndefined();
    expect(input.attributes('aria-describedby')).toBeUndefined();

    await input.setValue('5');
    expect(wrapper.find('[data-testid="setting-invalid"]').exists()).toBe(false);
  });

  it('shows the refusal again only when its owner refuses the next value sent', async () => {
    const wrapper = mount(SettingInput, { props: { modelValue: '', parse: parseCount, label: 'Count', commitOnBlur: false, refusal: null }, attachTo: document.body });
    mounted.push(wrapper);
    const input = wrapper.find('input');
    await input.setValue('7');
    await input.trigger('keydown', { key: 'Enter' });
    await wrapper.setProps({ refusal: REFUSAL });
    expect(shownError(wrapper)).toBe(REFUSAL);

    await input.setValue('8');
    expect(wrapper.find('[data-testid="setting-invalid"]').exists()).toBe(false);
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('commit')).toEqual([[7], [8]]);
    // The owner holds no verdict while it judges the value sent.
    await wrapper.setProps({ refusal: null });
    await wrapper.setProps({ refusal: REFUSAL });
    expect(shownError(wrapper)).toBe(REFUSAL);
    expect(input.attributes('aria-invalid')).toBe('true');
  });
});

describe('SettingInput, its layout', () => {
  function mountLaidOut(inline: boolean) {
    const wrapper = mount(SettingInput, { props: { modelValue: '5', parse: parseCount, label: 'Count', refusal: REFUSAL, inline }, attachTo: document.body });
    mounted.push(wrapper);
    return wrapper;
  }

  // An error with no intrinsic width cannot widen the column, so the input keeps its place in its row.
  it("an inline field aligns to its start and binds its error to the input's width", () => {
    const wrapper = mountLaidOut(true);
    expect(wrapper.classes()).toContain('items-start');
    expect(wrapper.classes()).not.toContain('items-end');
    expect(wrapper.find('[data-testid="setting-invalid"]').classes()).toEqual(expect.arrayContaining(['w-0', 'min-w-full']));
  });

  it('a default field keeps items-end and an unbound error', () => {
    const wrapper = mountLaidOut(false);
    expect(wrapper.classes()).toContain('items-end');
    const error = wrapper.find('[data-testid="setting-invalid"]').classes();
    expect(error).not.toContain('w-0');
    expect(error).not.toContain('min-w-full');
  });
});
