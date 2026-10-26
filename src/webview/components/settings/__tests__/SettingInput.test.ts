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

  it('keeps Escape after an edit, reverting the draft and leaving the refusal to its owner', async () => {
    const wrapper = mountField();
    await wrapper.find('input').setValue('7');

    expect(await escapeReachesModal(wrapper)).toBe(false);
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('5');
    expect(shownError(wrapper)).toBe(REFUSAL);
    expect(await escapeReachesModal(wrapper)).toBe(true);
  });

  it('shows a parse error over the refusal, and the refusal again once Escape drops the edit', async () => {
    const wrapper = mountField();
    await wrapper.find('input').setValue('x');
    await wrapper.find('input').trigger('keydown', { key: 'Enter' });

    expect(shownError(wrapper)).toBe('Enter a whole number.');
    expect(wrapper.find('input').attributes('aria-invalid')).toBe('true');
    expect(wrapper.emitted('commit')).toBeUndefined();

    expect(await escapeReachesModal(wrapper)).toBe(false);
    expect(shownError(wrapper)).toBe(REFUSAL);
  });
});
