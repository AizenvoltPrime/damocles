// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { OverlayRequest } from '../../preload/overlay-channels';
import type { ShellPlatform } from '../../preload/shell-channels';
import { shellI18n } from '../i18n';
import QuickInput from '../overlay/components/QuickInput.vue';

type InputRequest = Extract<OverlayRequest, { kind: 'input' }>;

const BRANCH: InputRequest = { kind: 'input', title: 'Commit to a New Branch', prompt: 'Please provide a new branch name', placeholder: 'Branch name', value: 'me/', valueSelection: [3, 3], validation: 'branchName' };

describe('QuickInput', () => {
  const mounted: VueWrapper[] = [];
  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount();
  });

  async function open(request: InputRequest, platform: ShellPlatform = 'linux') {
    const wrapper = mount(QuickInput, { props: { request, platform }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    const field = wrapper.get('[data-testid="quick-input-field"]');
    return { wrapper, field, element: field.element as HTMLInputElement };
  }

  it('opens focused with the prefill, the caret where valueSelection puts it, and the prompt under the box', async () => {
    const { wrapper, element } = await open(BRANCH);
    expect(document.activeElement).toBe(element);
    expect(element.value).toBe('me/');
    expect([element.selectionStart, element.selectionEnd]).toEqual([3, 3]);
    expect(wrapper.get('[data-testid="quick-input-title"]').text()).toBe('Commit to a New Branch');
    expect(wrapper.get('[data-testid="quick-input-prompt"]').text()).toBe('Please provide a new branch name');
    expect(wrapper.get('[role="dialog"]').attributes('aria-modal')).toBe('true');
    const plain = await open({ kind: 'input', prompt: 'Name', value: 'all of it' });
    expect([plain.element.selectionStart, plain.element.selectionEnd]).toEqual([0, 9]);
  });

  it('does not open red on a prefill that is not valid yet, and flags a broken name as it is typed', async () => {
    const { wrapper, field } = await open(BRANCH);
    expect(field.attributes('aria-invalid')).toBe('false');
    expect(wrapper.find('[data-testid="quick-input-problem"]').exists()).toBe(false);
    await field.setValue('me/fix..it');
    expect(field.attributes('aria-invalid')).toBe('true');
    const message = wrapper.get(`#${field.attributes('aria-describedby')!}`);
    expect(message.text()).toContain('A name can\'t contain “..”');
    await field.setValue('me/fix it');
    expect(wrapper.get('[data-testid="quick-input-problem"]').attributes('data-code')).toBe('space');
    await field.setValue('a[b');
    expect(wrapper.get('[data-testid="quick-input-problem"]').text()).toContain('A name can\'t contain “[”');
    await field.setValue('me/fix');
    expect(field.attributes('aria-invalid')).toBe('false');
  });

  it('refuses Enter while the value is invalid, saying why, and answers a valid one', async () => {
    const { wrapper, field } = await open(BRANCH);
    await field.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('answer')).toBeUndefined();
    expect(wrapper.get('[data-testid="quick-input-problem"]').attributes('data-code')).toBe('slashEdge');
    await field.setValue('me/fix');
    await field.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'input', value: 'me/fix' }]]);
  });

  it('dismisses on Escape, keeps Tab in the box and checks nothing without a validation kind', async () => {
    const { wrapper, field } = await open({ kind: 'input', prompt: 'Anything' });
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true });
    field.element.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    await field.setValue('');
    await field.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'input', value: '' }]]);
    await field.trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('answer')?.[1]).toEqual([{ kind: 'dismissed' }]);
  });

  it('keeps focus in the field when the title or prompt is pressed, so Enter and Escape still answer', async () => {
    const { wrapper, field } = await open({ kind: 'input', title: 'Rename', prompt: 'Press Enter' });
    for (const part of ['quick-input-title', 'quick-input-prompt']) {
      const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      wrapper.get(`[data-testid="${part}"]`).element.dispatchEvent(press);
      expect(press.defaultPrevented, part).toBe(true);
    }
    const inField = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    field.element.dispatchEvent(inField);
    expect(inField.defaultPrevented).toBe(false);
  });

  it('flags a name Windows cannot use while it runs on Windows only', async () => {
    const request: InputRequest = { kind: 'input', prompt: 'Rename', value: 'src/a.ts', validation: 'path' };
    const windows = await open(request, 'win32');
    await windows.field.setValue('src/con.ts');
    expect(windows.wrapper.get('[data-testid="quick-input-problem"]').attributes('data-code')).toBe('windowsName');
    await windows.field.trigger('keydown', { key: 'Enter' });
    expect(windows.wrapper.emitted('answer')).toBeUndefined();
    const linux = await open(request, 'linux');
    await linux.field.setValue('src/con.ts');
    expect(linux.wrapper.find('[data-testid="quick-input-problem"]').exists()).toBe(false);
  });

  it('checks a path for Rename', async () => {
    const { wrapper, field } = await open({ kind: 'input', prompt: 'Rename', value: 'src/a.ts', valueSelection: [4, 8], validation: 'path' });
    expect([(field.element as HTMLInputElement).selectionStart, (field.element as HTMLInputElement).selectionEnd]).toEqual([4, 8]);
    await field.setValue('../a.ts');
    expect(wrapper.get('[data-testid="quick-input-problem"]').attributes('data-code')).toBe('outside');
  });
});
