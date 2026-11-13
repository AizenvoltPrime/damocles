// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import ForgeForkDialog from '../overlay/components/ForgeForkDialog.vue';
import { applyShellLocale, shellI18n } from '../i18n';
import type { OverlayRequest } from '../../preload/overlay-channels';
import type { FlowStep, ForkDialog, ForkStepId } from '../../../shared/forge/publish';
import { fakeOverlayApi, type FakeOverlayApi } from './fakes';

const mounted: VueWrapper[] = [];

beforeEach(async () => {
  await applyShellLocale('en');
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
});

// sample data
const DIALOG: ForkDialog = {
  requestId: 'fork-1',
  serverName: 'gitlab.indigital.gr',
  kind: 'gitlab',
  path: 'grp/damocles',
  login: 'astefanopoulos',
  branch: 'fix/token-refresh',
  remote: 'origin',
  upstreamName: 'upstream',
  upstreamExists: false,
};

const steps = (...states: Array<FlowStep<ForkStepId>['state']>): FlowStep<ForkStepId>[] => (['fork', 'rename', 'origin', 'push'] as const).map((step, index) => ({ step, state: states[index] ?? 'pending' }));

// OverlayApp adds a dialog inside a render flush, after the dialog layer's focus trap listens, as this host does.
async function open(fields: Partial<ForkDialog> = {}): Promise<{ wrapper: VueWrapper; api: FakeOverlayApi }> {
  const api = fakeOverlayApi();
  const request: Extract<OverlayRequest, { kind: 'forgeFork' }> = { kind: 'forgeFork', dialog: { ...DIALOG, ...fields } };
  const shown = ref(false);
  const Host = defineComponent({ setup: () => () => (shown.value ? h(ForgeForkDialog, { api, request }) : null) });
  const host = mount(Host, { global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(host);
  shown.value = true;
  await flushPromises();
  return { wrapper: host.findComponent(ForgeForkDialog), api };
}

const $ = <T extends HTMLElement = HTMLElement>(testId: string): T | null => document.querySelector<T>(`[data-testid="${testId}"]`);
const dialog = (): HTMLElement => $('forge-fork')!;
const nameOf = (element: HTMLElement): string => element.getAttribute('aria-labelledby')!.split(' ').map((id) => document.getElementById(id)!.textContent!.trim()).join(' ');
const text = (element: Element): string => element.textContent!.replace(/\s+/g, ' ').trim();
// the label's own text, without the screen reader's state after it
const stepLabels = (): string[] => [...document.querySelectorAll('[data-testid="flow-step"]')].map((row) => [...row.querySelector('span.font-medium')!.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim());
const press = async (key: string): Promise<void> => {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await flushPromises();
};

async function forkAndPush(api: FakeOverlayApi): Promise<void> {
  $('forge-fork-go')!.click();
  await flushPromises();
  expect(api.forgeForkStart).toHaveBeenCalledWith('fork-1');
}

describe('ForgeForkDialog', () => {
  it('asks as a warning alertdialog naming the repository, the account and the branch, with Cancel focused', async () => {
    const { wrapper } = await open();
    expect(dialog().getAttribute('role')).toBe('alertdialog');
    expect(dialog().getAttribute('data-severity')).toBe('warning');
    expect(nameOf(dialog())).toBe("Warning You can't push to grp/damocles");
    const description = document.getElementById(dialog().getAttribute('aria-describedby')!)!;
    expect(text(description)).toBe('astefanopoulos can read grp/damocles on gitlab.indigital.gr but not push to it. Fork it to astefanopoulos, push fix/token-refresh there, then open a merge request.');
    expect($('forge-fork-upstream-exists')).toBeNull();
    expect(document.activeElement).toBe($('forge-fork-cancel'));
    expect(text($('forge-fork-go')!)).toBe('Fork and Push');
    $('forge-fork-cancel')!.click();
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
  });

  it('names a pull request on GitHub', async () => {
    await open({ kind: 'github', serverName: 'github.com', path: 'damocles-app/damocles' });
    expect(text(document.getElementById(dialog().getAttribute('aria-describedby')!)!)).toContain('then open a pull request.');
  });

  it('Fork and Push runs the timeline: the fork waits for the server to copy, Cancel focused and answering dismissed', async () => {
    const { wrapper, api } = await open();
    await forkAndPush(api);
    api.forgeForkState({ requestId: 'fork-1', phase: 'running', steps: steps('active'), cancellable: true });
    await flushPromises();
    expect(dialog().getAttribute('role')).toBe('dialog');
    expect(nameOf(dialog())).toBe('Forking grp/damocles');
    expect(stepLabels()).toEqual(['Fork grp/damocles to astefanopoulos', 'Rename origin to upstream', 'Add your fork as origin', 'Push fix/token-refresh']);
    expect(text($('flow-step-sub')!)).toBe('Waiting for gitlab.indigital.gr to copy the repository');
    expect(document.activeElement).toBe($('forge-fork-cancel'));
    $('forge-fork-cancel')!.click();
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
  });

  it('upstream-exists: the note says the original becomes upstream-2, and the rename step names it', async () => {
    const { api } = await open({ upstreamName: 'upstream-2', upstreamExists: true });
    expect(text($('forge-fork-upstream-exists')!)).toBe('This repository already has a remote named upstream. Damocles names the original upstream-2 and leaves yours as it is.');
    await forkAndPush(api);
    api.forgeForkState({ requestId: 'fork-1', phase: 'running', steps: steps('done', 'active'), cancellable: true });
    await flushPromises();
    expect(stepLabels()[1]).toBe('Rename origin to upstream-2');
  });

  it('once the push starts Cancel is gone, focus stays in the dialog and Escape does nothing', async () => {
    const { wrapper, api } = await open();
    await forkAndPush(api);
    api.forgeForkState({ requestId: 'fork-1', phase: 'running', steps: steps('done', 'done', 'done', 'active'), cancellable: false });
    await flushPromises();
    expect($('forge-fork-cancel')).toBeNull();
    expect(document.activeElement).toBe(dialog());
    await press('Escape');
    expect(wrapper.emitted('answer')).toBeUndefined();
  });

  it('a failed step shows the failure box; before the push the remotes are as they were', async () => {
    const { api } = await open();
    await forkAndPush(api);
    api.forgeForkState({ requestId: 'fork-1', phase: 'failed', steps: [{ step: 'fork', state: 'failed', failure: 'The fork is taking longer than 2 minutes on gitlab.indigital.gr.' }, ...steps().slice(1)], restored: true });
    await flushPromises();
    const failure = $('flow-failure')!;
    expect(failure.getAttribute('role')).toBe('alert');
    expect(failure.closest('[data-testid="flow-step"]')!.getAttribute('data-step')).toBe('fork');
    expect(text(failure)).toBe('The fork is taking longer than 2 minutes on gitlab.indigital.gr.');
    expect(text($('forge-fork-status')!)).toBe('Nothing changed on your remotes.');
    expect(document.activeElement).toBe($('forge-fork-close'));
  });

  it('a failed push keeps the new layout and says so', async () => {
    const { api } = await open();
    await forkAndPush(api);
    api.forgeForkState({ requestId: 'fork-1', phase: 'failed', steps: [...steps('done', 'done', 'done').slice(0, 3), { step: 'push', state: 'failed', failure: 'pre-receive hook declined' }], restored: false });
    await flushPromises();
    expect(text($('forge-fork-status')!)).toBe('origin is now your fork, and upstream is gitlab.indigital.gr/grp/damocles.');
  });

  it('a failed restore says nothing about the layout beyond the failure box', async () => {
    const { api } = await open();
    await forkAndPush(api);
    api.forgeForkState({ requestId: 'fork-1', phase: 'failed', steps: [{ step: 'fork', state: 'done' }, { step: 'rename', state: 'done' }, { step: 'origin', state: 'failed', failure: 'git remote add failed. Damocles could not put the remotes back as they were: error: could not lock config file' }, { step: 'push', state: 'pending' }], restored: false, restoreFailed: true });
    await flushPromises();
    expect(text($('flow-failure')!)).toContain('Damocles could not put the remotes back as they were');
    expect($('forge-fork-status')!.textContent).toBe('');
  });

  it('success: the success badge, the remotes table and Open Merge Request focused, which answers openMergeRequest', async () => {
    const { wrapper, api } = await open();
    await forkAndPush(api);
    api.forgeForkState({ requestId: 'fork-1', phase: 'done', steps: steps('done', 'done', 'done', 'done'), remotes: [{ name: 'origin', display: 'gitlab.indigital.gr/astefanopoulos/damocles' }, { name: 'upstream', display: 'gitlab.indigital.gr/grp/damocles' }] });
    await flushPromises();
    expect(dialog().getAttribute('data-severity')).toBe('success');
    expect(nameOf(dialog())).toBe('Pushed to your fork');
    const remotes = $('forge-fork-remotes')!;
    expect(remotes.getAttribute('aria-label')).toBe('Remotes');
    expect([...remotes.querySelectorAll('dt')].map(text)).toEqual(['origin', 'upstream']);
    expect([...remotes.querySelectorAll('dd')].map(text)).toEqual(['gitlab.indigital.gr/astefanopoulos/damocles', 'gitlab.indigital.gr/grp/damocles']);
    expect(text($('forge-fork-status')!)).toBe('Pushed fix/token-refresh to your fork.');
    const openButton = $('forge-fork-open')!;
    expect(text(openButton)).toBe('Open Merge Request');
    expect(document.activeElement).toBe(openButton);
    openButton.click();
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'forgeFork', openMergeRequest: true }]]);
  });

  it('success on GitHub offers Open Pull Request; Close answers dismissed', async () => {
    const { wrapper, api } = await open({ kind: 'github', serverName: 'github.com', path: 'damocles-app/damocles' });
    await forkAndPush(api);
    api.forgeForkState({ requestId: 'fork-1', phase: 'done', steps: steps('done', 'done', 'done', 'done'), remotes: [] });
    await flushPromises();
    expect(text($('forge-fork-open')!)).toBe('Open Pull Request');
    $('forge-fork-close')!.click();
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
  });

  it('says so when main could not start Fork and Push, and Fork and Push can be pressed again', async () => {
    const { api } = await open();
    vi.mocked(api.forgeForkStart).mockRejectedValueOnce(new Error('main is gone'));
    $('forge-fork-go')!.click();
    await flushPromises();
    expect($('forge-fork-start-failed')!.getAttribute('role')).toBe('alert');
    expect($<HTMLButtonElement>('forge-fork-go')!.disabled).toBe(false);
  });

  it('takes Fork and Push again when main ignored the start', async () => {
    const { api } = await open();
    vi.mocked(api.forgeForkStart).mockResolvedValueOnce({ ok: true, value: 'ignored' });
    $('forge-fork-go')!.click();
    await flushPromises();
    expect($<HTMLButtonElement>('forge-fork-go')!.disabled).toBe(false);
    expect($('forge-fork-start-failed')).toBeNull();
  });

  it('a click beside the panel cancels nothing while the steps run', async () => {
    const { wrapper, api } = await open();
    await forkAndPush(api);
    api.forgeForkState({ requestId: 'fork-1', phase: 'running', steps: steps('done', 'active'), cancellable: true });
    await flushPromises();
    document.querySelector<HTMLElement>('.overlay-dialog')!.click();
    expect(wrapper.emitted('answer')).toBeUndefined();
    await press('Escape');
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
  });

  it('names each step to a screen reader as it starts, and the failed one in the progress value', async () => {
    const { api } = await open();
    await forkAndPush(api);
    api.forgeForkState({ requestId: 'fork-1', phase: 'running', steps: steps('active'), cancellable: true });
    await flushPromises();
    const region = $('flow-announcement')!;
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(text(region)).toBe('Step 1 of 4: Fork grp/damocles to astefanopoulos');
    api.forgeForkState({ requestId: 'fork-1', phase: 'running', steps: steps('done', 'active'), cancellable: true });
    await flushPromises();
    expect(text(region)).toBe('Step 2 of 4: Rename origin to upstream');
    api.forgeForkState({ requestId: 'fork-1', phase: 'failed', steps: [{ step: 'fork', state: 'done' }, { step: 'rename', state: 'failed', failure: 'error: could not lock config file' }, ...steps().slice(2)], restored: true });
    await flushPromises();
    expect(text(region)).toBe('');
    expect($('flow-progress')!.getAttribute('aria-valuetext')).toBe('Failed at Rename origin to upstream');
  });
});
