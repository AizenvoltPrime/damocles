// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { MAX_INPUT_VALUE_LENGTH } from '@shared/input-validation';
import type { InputBrowseResult, OverlayRequest } from '../../preload/overlay-channels';
import type { ShellPlatform } from '../../preload/shell-channels';
import { shellI18n } from '../i18n';
import QuickInput from '../overlay/components/QuickInput.vue';

type InputRequest = Extract<OverlayRequest, { kind: 'input' }>;

const BRANCH: InputRequest = { kind: 'input', title: 'Commit to a New Branch', prompt: 'Please provide a new branch name', placeholder: 'Branch name', value: 'me/', valueSelection: [3, 3], validation: 'branchName' };

describe('QuickInput', () => {
  const mounted: VueWrapper[] = [];
  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount();
    vi.restoreAllMocks();
  });

  type Browse = (value: string) => Promise<InputBrowseResult | null | undefined>;
  async function open(request: InputRequest, platform: ShellPlatform = 'linux', browse?: Browse) {
    const wrapper = mount(QuickInput, { props: { request, platform, ...(browse ? { browse } : {}) }, global: { plugins: [shellI18n] }, attachTo: document.body });
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

  it('masks a password, turns off autocomplete, spellcheck and autocorrection, and shows a lock with no reveal toggle', async () => {
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level));
    const { wrapper, field, element } = await open({ kind: 'input', prompt: "Password for 'https://ada@git.example.com': ", password: true });
    expect(field.attributes()).toMatchObject({ type: 'password', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' });
    expect(wrapper.get('[data-testid="quick-input"]').attributes('data-password')).toBe('true');
    expect(wrapper.find('.lucide-lock-keyhole-icon, .lucide-lock-keyhole').exists()).toBe(true);
    expect(wrapper.findAll('button')).toHaveLength(0);
    expect(document.activeElement).toBe(element);
    await field.setValue('correct horse battery staple');
    // the value is the field's property only: no attribute, no text, no live region carries it
    expect(wrapper.html()).not.toContain('correct horse');
    expect(element.getAttribute('value')).toBeNull();
    await field.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'input', value: 'correct horse battery staple' }]]);
    expect(element.value).toBe('');
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
  });

  it("shows git's prompt as escaped plain text, and clears the password when dismissed", async () => {
    const prompt = "Password for 'https://<b>x</b>@evil\u202Emoc.example': ";
    const { wrapper, field, element } = await open({ kind: 'input', prompt, password: true });
    const shown = wrapper.get('[data-testid="quick-input-prompt"]');
    expect(shown.find('b').exists()).toBe(false);
    expect(shown.text()).toBe("Password for 'https://<b>x</b>@evil\\u{202E}moc.example':");
    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toContain('\\u{202E}');
    await field.setValue('hunter2');
    await field.trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
    expect(element.value).toBe('');
  });

  it("shows a plain box's prompt as escaped plain text too, as git's username prompt", async () => {
    const { wrapper } = await open({ kind: 'input', prompt: "Username for 'https://evil\u202Emoc.example': " });
    expect(wrapper.get('[data-testid="quick-input-prompt"]').text()).toBe("Username for 'https://evil\\u{202E}moc.example':");
    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toContain('\\u{202E}');
  });

  it('holds the field to the length main accepts, so a longer paste is cut rather than refused', async () => {
    for (const request of [BRANCH, { kind: 'input', prompt: 'Password', password: true } as const]) {
      const { field } = await open(request);
      expect(field.attributes('maxlength')).toBe(String(MAX_INPUT_VALUE_LENGTH));
    }
  });

  describe('the folder button', () => {
    const PATH: InputRequest = { kind: 'input', prompt: 'Please provide a worktree path', value: '/r.worktrees/wt', valueSelection: [13, 15], browse: { tooltip: 'Select Worktree Destination' } };

    it('sits inside the field, named by its tooltip, and only for a request with browse', async () => {
      const { wrapper } = await open(PATH, 'linux', async () => null);
      const button = wrapper.get('[data-testid="quick-input-browse"]');
      expect(button.element.tagName).toBe('BUTTON');
      expect(button.attributes()).toMatchObject({ type: 'button', 'aria-label': 'Select Worktree Destination', title: 'Select Worktree Destination' });
      expect(button.element.closest('label')).not.toBeNull();
      const plain = await open({ kind: 'input', prompt: 'Name' }, 'linux', async () => null);
      expect(plain.wrapper.find('[data-testid="quick-input-browse"]').exists()).toBe(false);
    });

    it('applies the answered value and selection, and returns focus to the field', async () => {
      const browse = vi.fn<Browse>(async () => ({ value: '/picked/wt', valueSelection: [8, 10] }));
      const { wrapper, field, element } = await open(PATH, 'linux', browse);
      await field.setValue('/r.worktrees/wtx');
      await wrapper.get('[data-testid="quick-input-browse"]').trigger('click');
      await flushPromises();
      expect(browse).toHaveBeenCalledWith('/r.worktrees/wtx');
      expect(element.value).toBe('/picked/wt');
      expect([element.selectionStart, element.selectionEnd]).toEqual([8, 10]);
      expect(document.activeElement).toBe(element);
      await wrapper.get('[data-testid="quick-input-field"]').trigger('keydown', { key: 'Enter' });
      expect(wrapper.emitted('answer')).toEqual([[{ kind: 'input', value: '/picked/wt' }]]);
    });

    it('leaves the box as it is for no answer, and drops an answer that arrives after the box answered', async () => {
      let finish!: (result: InputBrowseResult | null) => void;
      const browse = vi.fn<Browse>(() => new Promise((resolve) => (finish = resolve)));
      const { wrapper, element } = await open(PATH, 'linux', browse);
      const button = wrapper.get('[data-testid="quick-input-browse"]');
      await button.trigger('click');
      expect(button.attributes('aria-busy')).toBe('true');
      // a second click while main's dialog is open asks nothing more
      await button.trigger('click');
      expect(browse).toHaveBeenCalledTimes(1);
      finish(null);
      await flushPromises();
      expect(element.value).toBe('/r.worktrees/wt');
      await button.trigger('click');
      await wrapper.get('[data-testid="quick-input-field"]').trigger('keydown', { key: 'Escape' });
      finish({ value: '/late/wt' });
      await flushPromises();
      expect(element.value).toBe('/r.worktrees/wt');
      expect(wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
    });

    it('says so under the box when the call fails, until the next edit', async () => {
      const { wrapper, field } = await open(PATH, 'linux', async () => Promise.reject(new Error('gone')));
      await wrapper.get('[data-testid="quick-input-browse"]').trigger('click');
      await flushPromises();
      const problem = wrapper.get('[data-testid="quick-input-problem"]');
      expect(problem.attributes('data-code')).toBe('browseFailed');
      expect(problem.text()).toBe('The folder picker could not be opened. Try again.');
      expect(field.attributes('aria-invalid')).toBe('false');
      await field.setValue('/other');
      expect(wrapper.find('[data-testid="quick-input-problem"]').exists()).toBe(false);
    });

    it('takes Tab between the field and the button, and Escape on the button dismisses', async () => {
      const { wrapper, element } = await open(PATH, 'linux', async () => null);
      const button = wrapper.get('[data-testid="quick-input-browse"]');
      await wrapper.get('[data-testid="quick-input-field"]').trigger('keydown', { key: 'Tab' });
      expect(document.activeElement).toBe(button.element);
      await button.trigger('keydown', { key: 'Tab' });
      expect(document.activeElement).toBe(element);
      await wrapper.get('[data-testid="quick-input-field"]').trigger('keydown', { key: 'Tab', shiftKey: true });
      // two stops, so Shift+Tab from the field wraps to the button
      expect(document.activeElement).toBe(button.element);
      await button.trigger('keydown', { key: 'Escape' });
      expect(wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
    });
  });

  it('checks a path for Rename', async () => {
    const { wrapper, field } = await open({ kind: 'input', prompt: 'Rename', value: 'src/a.ts', valueSelection: [4, 8], validation: 'path' });
    expect([(field.element as HTMLInputElement).selectionStart, (field.element as HTMLInputElement).selectionEnd]).toEqual([4, 8]);
    await field.setValue('../a.ts');
    expect(wrapper.get('[data-testid="quick-input-problem"]').attributes('data-code')).toBe('outside');
  });
});
