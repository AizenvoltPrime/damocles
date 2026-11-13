// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import ForgeProtectedBranchDialog from '../overlay/components/ForgeProtectedBranchDialog.vue';
import { applyShellLocale, shellI18n } from '../i18n';
import type { OverlayRequest, PopupAnswer } from '../../preload/overlay-channels';
import type { FlowStep } from '../../../shared/forge/publish';
import type { BranchNameCheck, ProtectedBranchDialog, ProtectedPushStepId } from '../../../shared/forge/protected-push';
import { fakeOverlayApi, type FakeOverlayApi } from './fakes';

const mounted: VueWrapper[] = [];

beforeEach(async () => {
  await applyShellLocale('en');
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

const DIALOG: ProtectedBranchDialog = {
  requestId: 'protected-1',
  branch: 'main',
  serverName: 'gitlab.indigital.gr',
  kind: 'gitlab',
  login: 'astefanopoulos',
  remote: 'origin',
  localBranch: 'main',
  unpushedCount: 2,
  suggestedName: 'astefanopoulos/main',
};

const steps = (...states: Array<FlowStep<ProtectedPushStepId>['state']>): FlowStep<ProtectedPushStepId>[] => (['branch', 'push'] as const).map((step, index) => ({ step, state: states[index] ?? 'pending' }));

// OverlayApp adds a dialog inside a render flush, after the dialog layer's focus trap listens, as this host does.
async function open(fields: Partial<ProtectedBranchDialog> = {}): Promise<{ wrapper: VueWrapper; api: FakeOverlayApi }> {
  const api = fakeOverlayApi();
  const request: Extract<OverlayRequest, { kind: 'forgeProtectedBranch' }> = { kind: 'forgeProtectedBranch', dialog: { ...DIALOG, ...fields } };
  const shown = ref(false);
  const Host = defineComponent({ setup: () => () => (shown.value ? h(ForgeProtectedBranchDialog, { api, request }) : null) });
  const host = mount(Host, { global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(host);
  shown.value = true;
  await flushPromises();
  return { wrapper: host.findComponent(ForgeProtectedBranchDialog), api };
}

const $ = <T extends HTMLElement = HTMLElement>(testId: string): T | null => document.querySelector<T>(`[data-testid="${testId}"]`);
const dialog = (): HTMLElement => $('forge-protected')!;
const nameOf = (element: HTMLElement): string => element.getAttribute('aria-labelledby')!.split(' ').map((id) => document.getElementById(id)!.textContent!.trim()).join(' ');
const text = (element: Element): string => element.textContent!.replace(/\s+/g, ' ').trim();
const description = (): string => text(document.getElementById(dialog().getAttribute('aria-describedby')!)!);
const field = (): HTMLInputElement => $<HTMLInputElement>('forge-protected-name')!;
const message = (): HTMLElement => $('forge-protected-name-message')!;
// the label's own text, without the screen reader's state after it
const stepLabels = (): string[] => [...document.querySelectorAll('[data-testid="flow-step"]')].map((row) => [...row.querySelector('span.font-medium')!.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim());
const press = async (key: string): Promise<void> => {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await flushPromises();
};

async function toName(api: FakeOverlayApi): Promise<void> {
  $('forge-protected-new-branch')!.click();
  await flushPromises();
  expect(api.forgeProtectedCheckName).toHaveBeenCalledWith('protected-1', 'astefanopoulos/main');
}

async function type(value: string): Promise<void> {
  field().value = value;
  field().dispatchEvent(new Event('input'));
  await vi.advanceTimersByTimeAsync(150);
  await flushPromises();
}

describe('ForgeProtectedBranchDialog: the question', () => {
  it('names the branch, the server and the account, says only a merge request reaches the branch, and focuses Push to a New Branch', async () => {
    const { wrapper } = await open();
    expect(dialog().getAttribute('role')).toBe('alertdialog');
    expect(dialog().getAttribute('data-severity')).toBe('warning');
    expect(nameOf(dialog())).toBe('Warning main is protected on gitlab.indigital.gr');
    const paragraphs = [...document.getElementById(dialog().getAttribute('aria-describedby')!)!.querySelectorAll('p')].map(text);
    expect(paragraphs).toEqual([
      'gitlab.indigital.gr accepts changes to main only through a merge request, so astefanopoulos cannot push to it. Push your commits to a new branch, then open a merge request.',
      'main has 2 commits that origin does not have. They go on the new branch too, and main stays as it is.',
    ]);
    expect(document.activeElement).toBe($('forge-protected-new-branch'));
    expect(text($('forge-protected-new-branch')!)).toBe('Push to a New Branch');
    $('forge-protected-cancel')!.click();
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
  });

  it('names a pull request on GitHub, and says nothing of commits when the local branch has none to push', async () => {
    await open({ kind: 'github', serverName: 'github.com', unpushedCount: 0 });
    expect(description()).toBe('github.com accepts changes to main only through a pull request, so astefanopoulos cannot push to it. Push your commits to a new branch, then open a pull request.');
    expect($('forge-protected-unpushed')).toBeNull();
  });

  it('says one commit in the singular', async () => {
    await open({ unpushedCount: 1 });
    expect(text($('forge-protected-unpushed')!)).toBe('main has 1 commit that origin does not have. It goes on the new branch too, and main stays as it is.');
  });
});

describe('ForgeProtectedBranchDialog: the branch name', () => {
  it('asks for the name in the same dialog, prefilled and focused, with the hint tied to the field', async () => {
    const { api } = await open();
    await toName(api);
    expect(dialog().getAttribute('role')).toBe('dialog');
    expect(nameOf(dialog())).toBe('Push to a new branch');
    expect(document.querySelector(`label[for="${field().id}"]`)!.textContent!.trim()).toBe('Branch name');
    expect(field().value).toBe('astefanopoulos/main');
    expect(document.activeElement).toBe(field());
    expect(field().getAttribute('aria-describedby')).toBe(message().id);
    expect(message().getAttribute('aria-live')).toBe('polite');
    expect(text(message())).toBe("Git's branch name rules apply, and the name must be new here and on origin.");
    expect(field().getAttribute('aria-invalid')).toBeNull();
  });

  it.each([
    ['invalid', 'bad..name', 'Git does not accept this as a branch name. Leave out spaces and ~ ^ : ? * [, and do not start with - or end with . or /.'],
    ['existsLocally', 'feature', 'A local branch named feature exists already.'],
    ['existsOnRemote', 'release', 'origin has a branch named release already.'],
    ['conflicts', 'main/x', 'main/x clashes with an existing branch: one branch name cannot be a folder of another.'],
  ] as const)('checks the typed name with main after a pause and shows %s under the field, refusing the push', async (problem, typed, words) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { api } = await open();
    await toName(api);
    vi.mocked(api.forgeProtectedCheckName).mockImplementation(async (_requestId, name) => ({ ok: true, value: { name, problem } }));
    await type(typed);
    expect(api.forgeProtectedCheckName).toHaveBeenLastCalledWith('protected-1', typed);
    expect(text(message())).toBe(words);
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect($<HTMLButtonElement>('forge-protected-push')!.disabled).toBe(true);
    await press('Enter');
    expect(api.forgeProtectedPush).not.toHaveBeenCalled();
  });

  it('asks once per pause in typing and drops an answer for a name the field no longer shows', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { api } = await open();
    await toName(api);
    let late: ((answer: PopupAnswer<BranchNameCheck>) => void) | undefined;
    vi.mocked(api.forgeProtectedCheckName).mockClear();
    vi.mocked(api.forgeProtectedCheckName).mockImplementationOnce(() => new Promise((resolve) => (late = resolve)));
    field().value = 'a';
    field().dispatchEvent(new Event('input'));
    field().value = 'ab';
    field().dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(150);
    expect(vi.mocked(api.forgeProtectedCheckName).mock.calls).toEqual([['protected-1', 'ab']]);
    await type('abc');
    late!({ ok: true, value: { name: 'ab', problem: 'existsLocally' } });
    await flushPromises();
    expect(field().getAttribute('aria-invalid')).toBeNull();
    expect($<HTMLButtonElement>('forge-protected-push')!.disabled).toBe(false);
  });

  it('refuses an empty name without asking main', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { api } = await open();
    await toName(api);
    vi.mocked(api.forgeProtectedCheckName).mockClear();
    await type('');
    expect(api.forgeProtectedCheckName).not.toHaveBeenCalled();
    expect(text(message())).toBe('Type a name for the new branch.');
  });

  it('says so when main could not check the name, and leaves the push to main\'s own check', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { api } = await open();
    await toName(api);
    vi.mocked(api.forgeProtectedCheckName).mockRejectedValueOnce(new Error('no handler'));
    await type('astef/fix');
    expect(text(message())).toBe('Damocles could not check this name. It checks it again when you push.');
    expect(errors).toHaveBeenCalled();
    $('forge-protected-push')!.click();
    await flushPromises();
    expect(api.forgeProtectedPush).toHaveBeenCalledWith('protected-1', 'astef/fix');
    errors.mockRestore();
  });

  it('submits the name, and main\'s refusal brings the field back shaken with its problem', async () => {
    const { api } = await open();
    await toName(api);
    await press('Enter');
    expect(api.forgeProtectedPush).toHaveBeenCalledWith('protected-1', 'astefanopoulos/main');
    expect($<HTMLButtonElement>('forge-protected-push')!.disabled).toBe(true);
    api.forgeProtectedState({ requestId: 'protected-1', phase: 'refused', name: 'astefanopoulos/main', problem: 'existsOnRemote' });
    await flushPromises();
    expect(dialog().closest('.overlay-dialog')!.getAttribute('data-phase')).toBe('name');
    expect(text(message())).toBe('origin has a branch named astefanopoulos/main already.');
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect($('forge-protected-name-box')!.classList.contains('d-shake')).toBe(true);
    expect(document.activeElement).toBe(field());
  });

  it('Cancel on the name step answers dismissed', async () => {
    const { wrapper, api } = await open();
    await toName(api);
    $('forge-protected-cancel')!.click();
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
  });
});

describe('ForgeProtectedBranchDialog: the steps', () => {
  it('runs the branch and push steps with nothing to press, then offers Open Merge Request, which answers main', async () => {
    const { wrapper, api } = await open();
    await toName(api);
    await press('Enter');
    api.forgeProtectedState({ requestId: 'protected-1', phase: 'running', name: 'astefanopoulos/main', steps: steps('done', 'active') });
    await flushPromises();
    expect(nameOf(dialog())).toBe('Pushing astefanopoulos/main');
    expect(stepLabels()).toEqual(['Create astefanopoulos/main and switch to it', 'Push astefanopoulos/main to origin']);
    expect(document.querySelectorAll('button[data-testid^="forge-protected-"]')).toHaveLength(0);
    expect(document.activeElement).toBe(dialog());
    await press('Escape');
    expect(wrapper.emitted('answer')).toBeUndefined();

    api.forgeProtectedState({ requestId: 'protected-1', phase: 'done', name: 'astefanopoulos/main', steps: steps('done', 'done') });
    await flushPromises();
    expect(dialog().getAttribute('data-severity')).toBe('success');
    expect(nameOf(dialog())).toBe('Pushed astefanopoulos/main');
    expect(text($('forge-protected-status')!)).toBe('Pushed astefanopoulos/main to origin. main is unchanged.');
    expect(document.activeElement).toBe($('forge-protected-open'));
    expect(text($('forge-protected-open')!)).toBe('Open Merge Request');
    $('forge-protected-open')!.click();
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'forgeProtectedBranch', openMergeRequest: true }]]);
  });

  it('a failed push says the user is on the new branch and the old one is as it was, with Close focused', async () => {
    const { wrapper, api } = await open({ kind: 'github', serverName: 'github.com' });
    api.forgeProtectedState({ requestId: 'protected-1', phase: 'failed', name: 'astefanopoulos/main', steps: [{ step: 'branch', state: 'done' }, { step: 'push', state: 'failed', failure: 'github.com refused the push.' }] });
    await flushPromises();
    expect($('flow-failure')!.textContent!.trim()).toBe('github.com refused the push.');
    expect(text($('forge-protected-status')!)).toBe('You are on astefanopoulos/main now. main is as it was.');
    expect(document.activeElement).toBe($('forge-protected-close'));
    $('forge-protected-close')!.click();
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
  });

  it("a failed branch step says nothing was created or pushed, leaving where the repository is to main's failure text", async () => {
    const { api } = await open();
    const failure = 'The repository is no longer on main, so no branch was created. Switch back to main and push again.';
    api.forgeProtectedState({ requestId: 'protected-1', phase: 'failed', name: 'x', steps: [{ step: 'branch', state: 'failed', failure }, { step: 'push', state: 'pending' }] });
    await flushPromises();
    expect($('flow-failure')!.textContent!.trim()).toBe(failure);
    expect(text($('forge-protected-status')!)).toBe('No branch was created and nothing was pushed.');
  });

  it('shows when main could not start the push', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { api } = await open();
    await toName(api);
    vi.mocked(api.forgeProtectedPush).mockRejectedValueOnce(new Error('no handler'));
    await press('Enter');
    expect($('forge-protected-start-failed')!.getAttribute('role')).toBe('alert');
    expect($<HTMLButtonElement>('forge-protected-push')!.disabled).toBe(false);
    errors.mockRestore();
  });

  it('takes Push again when main ignored it', async () => {
    const { api } = await open();
    await toName(api);
    vi.mocked(api.forgeProtectedPush).mockResolvedValueOnce({ ok: true, value: 'ignored' });
    await press('Enter');
    expect(api.forgeProtectedPush).toHaveBeenCalled();
    expect($<HTMLButtonElement>('forge-protected-push')!.disabled).toBe(false);
    expect($('forge-protected-start-failed')).toBeNull();
  });

  it('ignores another request\'s state', async () => {
    const { api } = await open();
    api.forgeProtectedState({ requestId: 'protected-2', phase: 'done', name: 'x', steps: steps('done', 'done') });
    await flushPromises();
    expect(nameOf(dialog())).toBe('Warning main is protected on gitlab.indigital.gr');
  });
});
