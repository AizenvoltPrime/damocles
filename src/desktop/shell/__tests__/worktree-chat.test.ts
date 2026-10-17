// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { isProxy } from 'vue';
import { createPinia } from 'pinia';
import type { ChatsWorktreeOptions, DamoclesShellApi, ShownFolder } from '../../preload/shell-channels';
import type { OverlayAnswer, OverlayRequest, WorktreeDialogRequest } from '../../preload/overlay-channels';
import OverlayApp from '../overlay/OverlayApp.vue';
import ChatsSection from '../components/ChatsSection.vue';
import FilesBranchChip from '../components/FilesBranchChip.vue';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { finishActionOf, finishMenuItems } from '../worktree-menu';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, chat, fakeOverlayApi, fakeShellApi, opened, type FakeOverlayApi } from './fakes';

const mounted: VueWrapper[] = [];
const track = <T extends VueWrapper>(wrapper: T): T => {
  mounted.push(wrapper);
  return wrapper;
};

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const OPTIONS: ChatsWorktreeOptions = {
  available: true,
  currentBranch: 'main',
  branches: [
    { ref: 'refs/heads/main', name: 'main', current: true, remote: false },
    { ref: 'refs/heads/feat/a', name: 'feat/a', current: false, remote: false },
    { ref: 'refs/remotes/origin/main', name: 'origin/main', current: false, remote: true, newer: 2 },
  ],
  uncommittedCount: 3,
  projectName: 'alpha',
  branchPrefix: 'ax/',
};

const MENU_REQUEST: OverlayRequest = { kind: 'newChatMenu', anchor: { x: 200, y: 40, width: 60, height: 22 }, projectKey: 'p1', projectName: 'alpha', shortcut: 'Ctrl+N' };

function mountOverlay(api: FakeOverlayApi): VueWrapper {
  return track(mount(OverlayApp, {
    props: { api, settingsBridge: createOverlaySettingsBridge(api) },
    global: { plugins: [shellI18n, createPinia()], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  }));
}

// happy-dom computes no transition durations, so Vue ends an enter or leave on the second animation frame after it starts.
async function frames(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await flushPromises();
  }
}

async function open(wrapper: VueWrapper, api: FakeOverlayApi, id: string, request: OverlayRequest): Promise<void> {
  api.request(id, request);
  await flushPromises();
  await wrapper.vm.$nextTick();
  await frames();
}

const q = <T extends Element = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector);
const get = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const element = q<T>(selector);
  if (!element) throw new Error(`no element matches ${selector}`);
  return element;
};
const all = (selector: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(selector)];
const click = async (selector: string): Promise<void> => {
  get(selector).click();
  await frames();
};
// The answer main receives once the popup's exit played.
const lastAnswer = (api: FakeOverlayApi): OverlayAnswer | undefined => (vi.mocked(api.answer).mock.calls.at(-1)?.[1] as OverlayAnswer | undefined);
// Waits out the popup's exit, after which the overlay answers main.
async function settle(wrapper: VueWrapper): Promise<void> {
  await flushPromises();
  await wrapper.vm.$nextTick();
  await frames();
}

describe('New chat split menu (D30, D63)', () => {
  it('opens with the toggle off, New chat first, and answers plain', async () => {
    const api = fakeOverlayApi();
    api.worktree.options = opened(OPTIONS);
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'm1', MENU_REQUEST);

    expect(q('[data-testid="new-chat-menu"]')).not.toBeNull();
    const toggle = q('[data-testid="new-chat-menu-worktree"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.textContent).toContain('Run in a new worktree');
    expect(toggle.textContent).toContain('Its own copy of the project, on its own branch');
    expect(q('[data-testid="new-chat-menu-plain"]')?.textContent).toContain('Ctrl+N');
    expect(document.activeElement).toBe(q('[data-testid="new-chat-menu-plain"]'));
    expect(q('[data-testid="new-chat-menu-options"]')).toBeNull();

    await click('[data-testid="new-chat-menu-plain"]');
    await settle(wrapper);
    expect(lastAnswer(api)).toEqual({ kind: 'newChatMenu', choice: 'plain' });
  });

  it.each([
    ['notGit', "This folder isn't in a git repository"],
    ['noCommits', 'This repository has no commits yet'],
    ['untrusted', 'Trust this folder to use worktrees'],
  ] as const)('disables the toggle with its reason when the folder is %s', async (reason, text) => {
    const api = fakeOverlayApi();
    api.worktree.options = opened({ available: false, reason });
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'm1', MENU_REQUEST);

    const toggle = q('[data-testid="new-chat-menu-worktree"]')!;
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(toggle.getAttribute('title')).toBe(text);
    expect(toggle.textContent).toContain(text);
    await click('[data-testid="new-chat-menu-worktree"]');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(q('[data-testid="new-chat-menu-options"]')).toBeNull();
  });

  it('expands the options with Start from on the current branch and brings changes by default', async () => {
    const api = fakeOverlayApi();
    api.worktree.options = opened(OPTIONS);
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'm1', MENU_REQUEST);
    await click('[data-testid="new-chat-menu-worktree"]');

    expect(q('[data-testid="new-chat-menu-worktree"]')?.getAttribute('aria-checked')).toBe('true');
    expect(q('[data-testid="new-chat-menu-start"]')?.textContent).toMatch(/main\s*current/);
    const bring = q('[data-testid="new-chat-menu-bring"]')!;
    expect(bring.getAttribute('aria-checked')).toBe('true');
    expect(bring.textContent).toContain('Bring my uncommitted changes');
    expect(bring.textContent).toContain('3 files in alpha. They are copied, so your folder keeps them too.');
    expect(q('[data-testid="new-chat-menu-note"]')?.textContent).toBe('Creates branch ax/... from main. Setup from .damocles/worktree.json runs before the first message.');

    await click('[data-testid="new-chat-menu-create"]');
    await settle(wrapper);
    expect(lastAnswer(api)).toEqual({ kind: 'newChatMenu', choice: 'worktree', startRef: 'refs/heads/main', bringChanges: true });
  });

  it('lists local and remote branches with their marks, and another branch hides the changes checkbox', async () => {
    const api = fakeOverlayApi();
    api.worktree.options = opened(OPTIONS);
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'm1', MENU_REQUEST);
    await click('[data-testid="new-chat-menu-worktree"]');
    await click('[data-testid="new-chat-menu-start"]');

    const picker = q('[data-testid="new-chat-menu-picker"]')!;
    expect(picker.textContent).toMatch(/Branches[\s\S]*main[\s\S]*current[\s\S]*feat\/a[\s\S]*Remote branches[\s\S]*origin\/main[\s\S]*2 newer/);
    expect(document.activeElement).toBe(q('[data-testid="new-chat-menu-picker-filter"]'));

    q<HTMLElement>('[data-ref="refs/heads/feat/a"]')!.click();
    await frames();
    expect(q('[data-testid="new-chat-menu-picker"]')).toBeNull();
    expect(q('[data-testid="new-chat-menu-bring"]')).toBeNull();
    expect(q('[data-testid="new-chat-menu-note"]')?.textContent).toContain('from feat/a.');

    await click('[data-testid="new-chat-menu-create"]');
    await settle(wrapper);
    expect(lastAnswer(api)).toEqual({ kind: 'newChatMenu', choice: 'worktree', startRef: 'refs/heads/feat/a', bringChanges: false });
  });

  it('filters the picker and picks with the keyboard; unticking the checkbox stops the copy', async () => {
    const api = fakeOverlayApi();
    api.worktree.options = opened(OPTIONS);
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'm1', MENU_REQUEST);
    await click('[data-testid="new-chat-menu-worktree"]');
    await click('[data-testid="new-chat-menu-bring"]');
    expect(q('[data-testid="new-chat-menu-bring"]')?.getAttribute('aria-checked')).toBe('false');

    await click('[data-testid="new-chat-menu-start"]');
    const filter = q<HTMLInputElement>('[data-testid="new-chat-menu-picker-filter"]')!;
    filter.value = 'zzz';
    filter.dispatchEvent(new Event('input'));
    await flushPromises();
    expect(q('[data-testid="new-chat-menu-picker"]')?.textContent).toContain('No branches match');
    filter.value = 'origin';
    filter.dispatchEvent(new Event('input'));
    await flushPromises();
    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushPromises();
    expect(q('[data-testid="new-chat-menu-start"]')?.textContent).toMatch(/origin\/main\s*2 newer/);
  });

  it('lists the current local branch first', async () => {
    const api = fakeOverlayApi();
    api.worktree.options = opened({ ...OPTIONS, branches: [OPTIONS.branches[1]!, OPTIONS.branches[0]!, OPTIONS.branches[2]!] });
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'm1', MENU_REQUEST);
    await click('[data-testid="new-chat-menu-worktree"]');
    await click('[data-testid="new-chat-menu-start"]');
    expect(all('[data-testid="new-chat-menu-branch"]').map((row) => row.dataset['ref'])).toEqual(['refs/heads/main', 'refs/heads/feat/a', 'refs/remotes/origin/main']);
  });

  it('bounds the list to the window and opens the picker outside it, so the list\'s scroll never clips the picker', async () => {
    const api = fakeOverlayApi();
    api.worktree.options = opened(OPTIONS);
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'm1', MENU_REQUEST);
    const list = get('[data-testid="new-chat-menu-list"]');
    expect(list.style.maxHeight).toMatch(/px$/);
    expect(get('[data-testid="new-chat-menu"]').style.maxHeight).toBe('');
    await click('[data-testid="new-chat-menu-worktree"]');
    await click('[data-testid="new-chat-menu-start"]');
    const picker = get('[data-testid="new-chat-menu-picker"]');
    expect(list.contains(picker)).toBe(false);
    expect(picker.dataset['placement']).toMatch(/^(above|below)$/);
    // the trigger names the list it opened
    expect(get('[data-testid="new-chat-menu-start"]').getAttribute('aria-controls')).toBe(picker.querySelector('[role="listbox"]')?.id);
  });

  it('with the toggle on, Enter creates from the toggle and checkbox rows; Space still toggles', async () => {
    const api = fakeOverlayApi();
    api.worktree.options = opened(OPTIONS);
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'm1', MENU_REQUEST);
    const key = async (selector: string, name: string): Promise<void> => {
      q(selector)!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
      await frames();
    };
    await key('[data-testid="new-chat-menu-worktree"]', 'Enter');
    expect(q('[data-testid="new-chat-menu-worktree"]')?.getAttribute('aria-checked')).toBe('true');
    await key('[data-testid="new-chat-menu-bring"]', ' ');
    expect(q('[data-testid="new-chat-menu-bring"]')?.getAttribute('aria-checked')).toBe('false');
    await key('[data-testid="new-chat-menu-bring"]', 'Enter');
    await settle(wrapper);
    expect(lastAnswer(api)).toEqual({ kind: 'newChatMenu', choice: 'worktree', startRef: 'refs/heads/main', bringChanges: false });
  });

  it('Enter on the plain row still starts a plain chat with the toggle on', async () => {
    const api = fakeOverlayApi();
    api.worktree.options = opened(OPTIONS);
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'm1', MENU_REQUEST);
    await click('[data-testid="new-chat-menu-worktree"]');
    q('[data-testid="new-chat-menu-plain"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle(wrapper);
    expect(lastAnswer(api)).toEqual({ kind: 'newChatMenu', choice: 'plain' });
  });

  const worktree = (index: number) => ({ worktreeId: `w000000${index}`, branch: `damocles/task-${index}`, chatCount: index === 0 ? 2 : 1, added: 12, removed: 3, behind: index === 0 ? 2 : 0, baseBranch: 'main', lastActivity: 1000 - index });

  it('lists the five most recent chat worktrees with their figures and continues in one', async () => {
    const api = fakeOverlayApi();
    api.worktree.options = opened(OPTIONS);
    api.worktree.continue = opened([0, 1, 2, 3, 4, 5, 6].map(worktree));
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'm1', MENU_REQUEST);
    const rows = all('[data-testid="new-chat-menu-continue-row"]');
    expect(rows.map((row) => row.dataset['worktreeId'])).toEqual(['w0000000', 'w0000001', 'w0000002', 'w0000003', 'w0000004']);
    expect(rows[0]?.getAttribute('title')).toBe('damocles/task-0');
    expect(rows[0]?.getAttribute('aria-label')).toBe('damocles/task-0, 2 chats, 12 lines added, 3 removed, 2 behind main');
    expect(rows[0]?.textContent).toMatch(/task-0[\s\S]*2 chats[\s\S]*\+12[\s\S]*−3[\s\S]*2↓ main/);
    expect(rows[1]?.textContent).not.toContain('↓');
    expect(rows.map((row) => row.style.getPropertyValue('--reveal-index'))).toEqual(['0', '1', '2', '3', '4']);
    expect(q('[data-testid="new-chat-menu-all-worktrees"]')?.textContent).toContain('All worktrees…');
    rows[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle(wrapper);
    expect(lastAnswer(api)).toEqual({ kind: 'newChatMenu', choice: 'continueInWorktree', worktreeId: 'w0000001' });
  });

  it('opens a searchable list of every worktree from All worktrees…', async () => {
    const api = fakeOverlayApi();
    api.worktree.options = opened(OPTIONS);
    api.worktree.continue = opened([0, 1, 2, 3, 4, 5, 6].map(worktree));
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'm1', MENU_REQUEST);
    await click('[data-testid="new-chat-menu-all-worktrees"]');
    expect(all('[data-testid="new-chat-menu-worktree-option"]')).toHaveLength(7);
    expect(document.activeElement).toBe(q('[data-testid="new-chat-menu-worktree-filter"]'));
    q('[data-worktree-id="w0000006"][data-testid="new-chat-menu-worktree-option"]')!.click();
    await settle(wrapper);
    expect(lastAnswer(api)).toEqual({ kind: 'newChatMenu', choice: 'continueInWorktree', worktreeId: 'w0000006' });
  });

  it('has no Continue group without worktrees, with five or fewer no All worktrees…, and type-ahead reaches a row', async () => {
    const api = fakeOverlayApi();
    api.worktree.options = opened(OPTIONS);
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'm1', MENU_REQUEST);
    expect(q('[data-testid="new-chat-menu-continue"]')).toBeNull();
    wrapper.unmount();
    mounted.splice(mounted.indexOf(wrapper), 1);
    document.body.innerHTML = '';

    const second = fakeOverlayApi();
    second.worktree.options = opened(OPTIONS);
    second.worktree.continue = opened([0, 1].map(worktree));
    const again = mountOverlay(second);
    await open(again, second, 'm2', MENU_REQUEST);
    expect(all('[data-testid="new-chat-menu-continue-row"]')).toHaveLength(2);
    expect(q('[data-testid="new-chat-menu-all-worktrees"]')).toBeNull();
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true }));
    await frames();
    expect((document.activeElement as HTMLElement | null)?.dataset['worktreeId']).toBe('w0000000');
  });

  it('says why the options did not load instead of offering the toggle', async () => {
    const api = fakeOverlayApi();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.worktreeOptions).mockRejectedValueOnce(new Error('git failed'));
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'm1', MENU_REQUEST);
    expect(q('[data-testid="new-chat-menu-worktree-sub"]')?.textContent).toBe('Damocles could not read the branches.');
    expect(q('[data-testid="new-chat-menu-worktree"]')?.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('worktree dialogs (D41)', () => {
  const ask = async (dialog: WorktreeDialogRequest): Promise<{ wrapper: VueWrapper; api: FakeOverlayApi }> => {
    const api = fakeOverlayApi();
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'd1', dialog);
    return { wrapper, api };
  };

  it('reviews the setup commands with Skip focused first; Run answers run', async () => {
    const { wrapper, api } = await ask({ kind: 'worktreeDialog', dialog: 'setupReview', projectName: 'alpha', commands: ['npm ci', 'npm run build:types'] });
    const dialog = q('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Run this project's worktree setup?");
    expect(q('[data-testid="worktree-dialog-commands"]')?.textContent).toMatch(/npm ci[\s\S]*npm run build:types/);
    // the commands read verbatim, one line each, never broken mid-identifier
    for (const line of all('[data-testid="worktree-dialog-commands"] li')) {
      expect(line.classList.contains('whitespace-pre')).toBe(true);
      expect(line.classList.contains('break-all')).toBe(false);
    }
    expect(document.activeElement?.textContent?.trim()).toBe('Skip');
    await click('[data-testid="worktree-dialog-run"]');
    await settle(wrapper);
    expect(lastAnswer(api)).toEqual({ kind: 'worktreeDialog', dialog: 'setupReview', choice: 'run' });
  });

  it('Escape answers a dialog with its cancel choice', async () => {
    const { wrapper, api } = await ask({ kind: 'worktreeDialog', dialog: 'rewritten', branch: 'main' });
    expect(q('[role="alertdialog"]')?.textContent).toContain('main was rewritten after this worktree started');
    expect(q('[role="alertdialog"]')?.textContent).toContain('Merging now would bring back the commit it replaced.');
    expect(document.activeElement?.textContent?.trim()).toBe('Rebase onto main');
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(wrapper);
    expect(lastAnswer(api)).toEqual({ kind: 'worktreeDialog', dialog: 'rewritten', choice: 'cancel' });
  });

  it('asks before a delete with Cancel focused, the lists and Also delete branch', async () => {
    const { wrapper, api } = await ask({
      kind: 'worktreeDialog',
      dialog: 'delete',
      path: '/w/.damocles/worktrees/alpha/a1b2c3d4',
      branch: 'damocles/fix-login',
      uncommitted: [{ path: 'src/a.ts', letter: 'M' }, { path: 'README.md', letter: 'D' }],
      submoduleChanges: [{ path: 'vendor/lib', letter: 'S' }],
      unmergedCommits: [{ hash: '0123456789abcdef', subject: 'Fix the redirect' }],
      deleteBranchDefault: false,
      deleteBranchLocked: false,
    });
    const dialog = q('[role="alertdialog"]')!;
    expect(dialog.getAttribute('data-severity')).toBe('danger');
    expect(document.activeElement?.textContent?.trim()).toBe('Cancel');
    expect(dialog.textContent).toContain('It has 2 uncommitted changes, which will be lost:');
    expect(all('[data-testid="worktree-dialog-file"]').map((row) => row.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('a.ts'), expect.stringContaining('README.md')]));
    expect(q('[data-testid="worktree-dialog-submodules"]')?.textContent).toContain('lib');
    expect(q('[data-testid="worktree-dialog-commits"]')?.textContent).toMatch(/0123456[\s\S]*Fix the redirect/);
    // each file ends with its git letter in source control's colour
    const letters = all('[data-testid="worktree-dialog-file-letter"]');
    expect(letters.map((letter) => letter.textContent)).toEqual(['M', 'D', 'S']);
    expect(letters[0]?.style.color).toBe('var(--d-warning-text)');
    expect(letters[1]?.style.color).toBe('var(--d-danger-text)');
    expect(all('[data-testid="worktree-dialog-file"]')[0]?.textContent).toContain('Modified');
    // the three lists stagger as one sequence
    const indexes = [...all('[data-testid="worktree-dialog-file"]'), ...all('[data-testid="worktree-dialog-commits"] li')].map((row) => row.style.getPropertyValue('--reveal-index'));
    expect(indexes).toEqual(['0', '1', '2', '3']);
    expect(dialog.textContent).toContain('Also delete branch damocles/fix-login');
    await click('[data-testid="worktree-dialog-delete-branch"]');
    await click('[data-testid="worktree-dialog-delete"]');
    await settle(wrapper);
    expect(lastAnswer(api)).toEqual({ kind: 'worktreeDialog', dialog: 'delete', choice: 'delete', deleteBranch: true });
  });

  it('takes a commit message for a merge, generated on request', async () => {
    const { wrapper, api } = await ask({ kind: 'worktreeDialog', dialog: 'mergeMessage', branch: 'damocles/fix-login', target: 'main', files: [{ path: 'src/a.ts', letter: 'M' }] });
    api.worktree.message = opened({ message: 'Fix the login redirect' });
    expect(q('[role="alertdialog"]')?.textContent).toContain('Merge damocles/fix-login into main?');
    const commit = q<HTMLButtonElement>('[data-testid="worktree-dialog-commit"]')!;
    expect(commit.disabled).toBe(true);
    expect(document.activeElement).toBe(q('[data-testid="worktree-dialog-message"]'));
    await click('[data-testid="worktree-dialog-generate"]');
    expect(q<HTMLTextAreaElement>('[data-testid="worktree-dialog-message"]')?.value).toBe('Fix the login redirect');
    expect(q<HTMLButtonElement>('[data-testid="worktree-dialog-commit"]')?.disabled).toBe(false);
    await click('[data-testid="worktree-dialog-commit"]');
    await settle(wrapper);
    expect(lastAnswer(api)).toEqual({ kind: 'worktreeDialog', dialog: 'mergeMessage', choice: 'commit', message: 'Fix the login redirect' });
  });

  it('confirms a hand-off listing the files that move, marking the user\'s own edits', async () => {
    const { wrapper, api } = await ask({ kind: 'worktreeDialog', dialog: 'handOffConfirm', direction: 'toWorktree', files: [{ path: 'src/a.ts', letter: 'M', alsoUserEdits: false }, { path: 'src/b.ts', letter: 'A', alsoUserEdits: true }] });
    expect(q('[role="alertdialog"]')?.textContent).toContain('Move this chat to a worktree?');
    // a hand-off is no warning; its badge is accent with the folder tree icon
    expect(q('[role="alertdialog"]')?.getAttribute('data-severity')).toBe('accent');
    expect(q('[data-testid="overlay-dialog-icon"]')?.classList.contains('lucide-folder-tree')).toBe(true);
    const rows = all('[data-testid="worktree-dialog-file"]');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.querySelector('[data-testid="worktree-dialog-file-mark"]')?.textContent).toBe('also has your edits');
    expect(rows[0]?.querySelector('[data-testid="worktree-dialog-file-mark"]')).toBeNull();
    expect(document.activeElement?.textContent?.trim()).toBe('Move to worktree');
    await click('[data-testid="worktree-dialog-move"]');
    await settle(wrapper);
    expect(lastAnswer(api)).toEqual({ kind: 'worktreeDialog', dialog: 'handOffConfirm', choice: 'move' });
  });

  it.each([
    ['apply', "Can't apply the worktree's changes"],
    ['handOff', "Can't move this chat to the project folder"],
  ] as const)('refuses an %s naming the files', async (action, title) => {
    const { wrapper, api } = await ask({ kind: 'worktreeDialog', dialog: 'refusal', action, files: [{ path: 'src/clash.ts', letter: 'M' }] });
    expect(q('[role="alertdialog"]')?.textContent).toContain(title);
    expect(q('[data-testid="worktree-dialog-files"]')?.textContent).toContain('clash.ts');
    await click('[data-testid="worktree-dialog-ok"]');
    await settle(wrapper);
    expect(lastAnswer(api)).toEqual({ kind: 'worktreeDialog', dialog: 'refusal', choice: 'ok' });
  });

  it('reviews leftovers: Reveal only on a folder still there, Prune only for a git record', async () => {
    const { wrapper, api } = await ask({
      kind: 'worktreeDialog',
      dialog: 'leftovers',
      items: [{ path: '/w/stray', reason: 'unregistered' }, { path: '/w/gone', reason: 'gitRecordOnly', repository: '/w/alpha' }, { path: '/w/idle', reason: 'noChat' }],
    });
    const rows = all('[data-testid="worktree-dialog-leftover"]');
    expect(rows[2]?.querySelector('[data-testid="worktree-dialog-delete-leftover"]')).not.toBeNull();
    expect(rows[2]?.querySelector('[data-testid="worktree-dialog-keep-leftover"]')).not.toBeNull();
    expect(rows[2]?.querySelector('[data-testid="worktree-dialog-reveal"]')).toBeNull();
    expect(rows[0]?.querySelector('[data-testid="worktree-dialog-delete-leftover"]')).toBeNull();
    expect(rows[0]?.textContent).toContain('Not registered by Damocles');
    // the folder's name in mono, its parent under it
    expect(rows[0]?.querySelector('[data-testid="worktree-dialog-leftover-name"]')?.textContent).toBe('stray');
    expect(rows[0]?.textContent).toContain('/w/');
    expect(rows[0]?.querySelector('[data-testid="worktree-dialog-reveal"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[data-testid="worktree-dialog-reveal"]')).toBeNull();
    expect(rows[0]?.querySelector('[data-testid="worktree-dialog-prune"]')).toBeNull();
    expect(rows[1]?.querySelector('[data-testid="worktree-dialog-prune"]')).not.toBeNull();
    rows[1]!.querySelector<HTMLElement>('[data-testid="worktree-dialog-prune"]')!.click();
    await settle(wrapper);
    expect(lastAnswer(api)).toEqual({ kind: 'worktreeDialog', dialog: 'leftovers', choice: 'prune', path: '/w/gone' });
  });
});

describe('finish actions (D33)', () => {
  const t = (key: string, values?: Record<string, unknown>): string => shellI18n.global.t(key, values ?? {});

  it('disables Apply, Merge, Update and Delete while a chat works, Push without a remote, Merge on a detached HEAD', () => {
    const busy = finishMenuItems(t, { busy: true, hasRemote: false, detachedTarget: false }, 'main');
    const state = (id: string) => busy.find((item) => item.kind === 'item' && item.id === `worktree:${id}`);
    expect(state('apply')).toMatchObject({ disabled: true, disabledReason: 'While a chat works' });
    expect(state('merge')).toMatchObject({ label: 'Merge into main', disabled: true });
    expect(state('update')).toMatchObject({ label: 'Update from main', disabled: true });
    expect(state('push')).toMatchObject({ disabled: true, disabledReason: 'No remote' });
    expect(state('delete')).toMatchObject({ danger: true, disabled: true });
    const idle = finishMenuItems(t, { busy: false, hasRemote: true, detachedTarget: true }, undefined);
    expect(idle.find((item) => item.kind === 'item' && item.id === 'worktree:merge')).toMatchObject({ disabled: true, disabledReason: 'Detached HEAD' });
    expect(idle.find((item) => item.kind === 'item' && item.id === 'worktree:apply')).not.toHaveProperty('disabled');
    expect(finishActionOf('worktree:push')).toBe('push');
    expect(finishActionOf('rename')).toBeUndefined();
  });
});

describe('chats section with worktree chats', () => {
  function mountChats(api: DamoclesShellApi) {
    return track(mount(ChatsSection, {
      props: { api, projectKey: 'p1', stateRevision: 1, projectName: 'alpha', selectedChatId: 'w1', newChatShortcut: 'Ctrl+N', newChatInWorktreeShortcut: 'Shift+Alt+N', collapsed: false },
      global: { plugins: [shellI18n] },
      attachTo: document.body,
    }));
  }
  const WORKTREE_CHATS = [
    chat({ id: 'w1', title: 'Fix login', worktree: { worktreeId: 'a1b2c3d4', branch: 'damocles/fix-login', status: 'live', baseBranch: 'main', finish: { busy: false, hasRemote: true, detachedTarget: false }, newChatIn: { projectKey: 'p1', worktreeId: 'a1b2c3d4' } } }),
    chat({ id: 'w2', title: 'Pending', worktree: { branch: 'main', status: 'pending' } }),
    chat({ id: 'w3', title: 'Gone', readOnly: true, worktree: { worktreeId: 'b1b2c3d4', branch: 'damocles/gone', status: 'deleted' } }),
    chat({ id: 'w4', title: 'From worktree project', readOnly: true, worktree: { worktreeId: 'c1b2c3d4', branch: 'hotfix', status: 'deleted', fromProject: 'alpha-hotfix' } }),
    chat({ id: 'n1', title: 'Normal' }),
  ];

  it('keeps Ctrl+N\'s plain New Chat on the main part and opens the worktree menu from the chevron', async () => {
    const api = fakeShellApi([]);
    const wrapper = mountChats(api);
    await flushPromises();
    await wrapper.get('[data-testid="new-chat"]').trigger('click');
    expect(api.newChat).toHaveBeenCalledWith();
    expect(api.overlayRequests).toHaveLength(0);

    api.answerNext({ kind: 'newChatMenu', choice: 'worktree', startRef: 'refs/heads/main', bringChanges: true });
    await wrapper.get('[data-testid="new-chat-options"]').trigger('click');
    await flushPromises();
    expect(api.overlayRequests[0]).toMatchObject({ kind: 'newChatMenu', projectKey: 'p1', projectName: 'alpha', shortcut: 'Ctrl+N' });
    expect(api.newChat).toHaveBeenLastCalledWith('p1', { startRef: 'refs/heads/main', bringChanges: true });

    api.answerNext({ kind: 'newChatMenu', choice: 'plain' });
    await wrapper.get('[data-testid="new-chat-options"]').trigger('click');
    await flushPromises();
    expect(api.newChat).toHaveBeenLastCalledWith('p1');
  });

  it('shows the branch, the pending start, and Worktree deleted on the rows; read-only rows say so', async () => {
    const api = fakeShellApi(WORKTREE_CHATS);
    const wrapper = mountChats(api);
    await flushPromises();
    const line = (id: string) => wrapper.get(`[data-chat-id="${id}"]`).find('[data-testid="chat-worktree-line"]');
    // the slug tells worktrees apart; the full branch is the line's title
    expect(line('w1').text()).toBe('fix-login');
    expect(line('w1').attributes('title')).toBe('damocles/fix-login');
    expect(line('w2').text()).toBe('New worktree from main');
    expect(line('w3').text()).toBe('Worktree deleted');
    expect(line('w4').text()).toBe('Worktree deleted · alpha-hotfix');
    expect(line('n1').exists()).toBe(false);
    expect(wrapper.get('[data-chat-id="w1"] [data-testid="chat-worktree-icon"]').classes()).toContain('text-(--d-accent)');
    expect(wrapper.get('[data-chat-id="w3"] [data-testid="chat-worktree-icon"]').classes()).toContain('text-(--d-faint)');
    expect(wrapper.get('[data-chat-id="w3"]').attributes('data-read-only')).toBe('true');
    expect(wrapper.get('[data-chat-id="w3"]').text()).toContain('read-only');
  });

  it('offers the finish actions in a worktree chat\'s row menu and runs them on its worktree', async () => {
    const api = fakeShellApi(WORKTREE_CHATS);
    const wrapper = mountChats(api);
    await flushPromises();
    api.answerNext({ kind: 'menu', itemId: 'worktree:merge' });
    await wrapper.get('[data-chat-id="w1"]').trigger('contextmenu');
    await flushPromises();
    const menu = api.overlayRequests[0];
    // one Worktree submenu holds New chat in this worktree first, then the finish actions
    const submenu = menu?.kind === 'menu' ? menu.items.find((item) => item.kind === 'submenu') : undefined;
    expect(submenu?.kind === 'submenu' && submenu.label).toBe('Worktree');
    expect(submenu?.kind === 'submenu' && submenu.items.map((item) => (item.kind === 'item' ? item.label : item.kind))).toEqual(['New chat in this worktree', 'separator', 'Apply to project folder', 'Merge into main', 'Update from main', 'Push branch', 'separator', 'Delete worktree']);
    expect(submenu?.kind === 'submenu' && submenu.items[0]).toMatchObject({ id: 'newChatInWorktree', shortcut: 'Shift+Alt+N' });
    expect(menu?.kind === 'menu' && menu.items.filter((item) => item.kind === 'item' && item.danger)).toHaveLength(1);
    expect(api.worktreeFinish).toHaveBeenCalledWith({ projectKey: 'p1', worktreeId: 'a1b2c3d4', action: 'merge' });

    api.answerNext({ kind: 'menu', itemId: 'newChatInWorktree' });
    await wrapper.get('[data-chat-id="w1"]').trigger('contextmenu');
    await flushPromises();
    expect(api.newChatInWorktree).toHaveBeenCalledWith({ projectKey: 'p1', worktreeId: 'a1b2c3d4' });

    await wrapper.get('[data-chat-id="n1"]').trigger('contextmenu');
    await flushPromises();
    const plain = api.overlayRequests.at(-1);
    expect(plain?.kind === 'menu' && plain.items.some((item) => item.kind === 'submenu' || (item.kind === 'item' && item.id.startsWith('worktree:')))).toBe(false);
  });

  it('offers + on a live worktree chat\'s row only, as a mouse shortcut kept out of the option\'s name, and starts a chat there', async () => {
    const api = fakeShellApi(WORKTREE_CHATS);
    const wrapper = mountChats(api);
    await flushPromises();
    const plus = wrapper.get('[data-chat-id="w1"] [data-testid="chat-action-new-in-worktree"]');
    expect(plus.attributes('title')).toBe('New chat in this worktree');
    expect(plus.attributes()).toMatchObject({ 'aria-hidden': 'true', tabindex: '-1' });
    for (const id of ['w2', 'w3', 'w4', 'n1']) expect(wrapper.find(`[data-chat-id="${id}"] [data-testid="chat-action-new-in-worktree"]`).exists()).toBe(false);
    await plus.trigger('click');
    expect(api.newChatInWorktree).toHaveBeenCalledWith({ projectKey: 'p1', worktreeId: 'a1b2c3d4' });
    expect(api.selectChat).not.toHaveBeenCalled();
    // the context bridge clones the request, which fails on a reactive proxy
    expect(isProxy(vi.mocked(api.newChatInWorktree).mock.calls[0]![0])).toBe(false);
  });

  it('keeps a running worktree chat\'s worktree icon and pulses it', async () => {
    const api = fakeShellApi([{ ...WORKTREE_CHATS[0]!, status: 'running' }]);
    const wrapper = mountChats(api);
    await flushPromises();
    const icon = wrapper.get('[data-chat-id="w1"] [data-testid="chat-worktree-icon"]');
    expect(icon.classes()).toEqual(expect.arrayContaining(['d-pulsing', 'text-(--d-accent)']));
    expect(wrapper.find('[data-chat-id="w1"] .d-spinning').exists()).toBe(false);
  });

  it('keeps main\'s order, so a new chat in a worktree stays first and is never moved next to its siblings', async () => {
    const fresh = chat({ id: 'w5', title: 'Another', timestamp: Date.now(), worktree: { worktreeId: 'a1b2c3d4', branch: 'damocles/fix-login', status: 'live', baseBranch: 'main' } });
    const api = fakeShellApi([fresh, ...WORKTREE_CHATS.map((entry) => ({ ...entry, timestamp: Date.now() - 1000 }))]);
    const wrapper = mountChats(api);
    await flushPromises();
    expect(wrapper.findAll('[data-chat-id]').map((row) => row.attributes('data-chat-id'))[0]).toBe('w5');
  });
});

describe('Files branch chip (D31)', () => {
  const SHOWN: ShownFolder = {
    projectKey: 'p1',
    root: { projectKey: 'p1', worktreeId: 'a1b2c3d4' },
    rootKey: 'p1\u0000a1b2c3d4',
    fsPath: '/w/.damocles/worktrees/alpha/a1b2c3d4',
    canShowWorktree: true,
    worktree: { worktreeId: 'a1b2c3d4', chatId: 'w1', branch: 'damocles/fix-login', baseBranch: 'main', behind: 2, targetRewritten: false, place: 'worktree', finish: { busy: false, hasRemote: true, detachedTarget: false }, newChatIn: { projectKey: 'p1', worktreeId: 'a1b2c3d4' } },
  };
  const PROJECT_SHOWN: ShownFolder = { ...SHOWN, root: { projectKey: 'p1' }, rootKey: 'p1' };
  const mountChip = (api: DamoclesShellApi, shown: ShownFolder) => track(mount(FilesBranchChip, { props: { api, shown }, global: { plugins: [shellI18n] }, attachTo: document.body }));
  const main = (wrapper: VueWrapper) => wrapper.get('[data-testid="files-branch-chip-main"]');
  const chevron = (wrapper: VueWrapper) => wrapper.get('[data-testid="files-branch-chip-menu"]');
  const menuOf = (api: ReturnType<typeof fakeShellApi>) => {
    const request = api.overlayRequests.at(-1);
    return request?.kind === 'menu' ? request : undefined;
  };

  it('names the worktree branch in accent with its behind count, and a click opens its menu, which switches to the project folder', async () => {
    const api = fakeShellApi([]);
    const wrapper = mountChip(api, SHOWN);
    expect(wrapper.attributes('data-shown')).toBe('worktree');
    expect(wrapper.get('[data-testid="files-branch-chip-label"]').text()).toBe('fix-login');
    expect(main(wrapper).attributes('aria-label')).toBe('Worktree damocles/fix-login, 2 behind main');
    expect(main(wrapper).attributes('title')).toContain('damocles/fix-login');
    // the state the chip may cut is in its tooltip too
    expect(main(wrapper).attributes('title')).toContain('2 behind main');
    expect(wrapper.get('[data-testid="files-branch-chip-state"]').text()).toBe('· 2 behind main');
    expect(main(wrapper).attributes('aria-haspopup')).toBe('menu');
    expect(main(wrapper).attributes('aria-expanded')).toBe('false');
    api.answerNext({ kind: 'menu', itemId: 'showProject' });
    await main(wrapper).trigger('click');
    await flushPromises();
    const menu = menuOf(api);
    expect(menu?.caption).toBe('damocles/fix-login');
    expect(menu?.items.slice(0, 4)).toEqual([
      expect.objectContaining({ id: 'newChatInWorktree', label: 'New chat in this worktree', icon: 'plus' }),
      { kind: 'separator' },
      expect.objectContaining({ id: 'showProject', label: 'Show project folder', checked: false, radio: true }),
      expect.objectContaining({ id: 'showWorktree', label: 'Show worktree', checked: true, radio: true }),
    ]);
    expect(menu?.items[0]).not.toHaveProperty('disabled');
    expect(api.showFolder).toHaveBeenCalledWith({ projectKey: 'p1', show: 'project' });
  });

  it('says it is open while its menu is up', async () => {
    const api = fakeShellApi([]);
    let answer: (value: OverlayAnswer) => void = () => undefined;
    vi.mocked(api.requestOverlay).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const wrapper = mountChip(api, SHOWN);
    await main(wrapper).trigger('click');
    await flushPromises();
    expect(main(wrapper).attributes('aria-expanded')).toBe('true');
    expect(chevron(wrapper).attributes('aria-expanded')).toBe('true');
    answer({ kind: 'dismissed' });
    await flushPromises();
    expect(main(wrapper).attributes('aria-expanded')).toBe('false');
  });

  it('reads "Project folder" after Show project folder, and a click there shows the worktree again with no menu', async () => {
    const api = fakeShellApi([]);
    const wrapper = mountChip(api, PROJECT_SHOWN);
    expect(wrapper.attributes('data-shown')).toBe('project');
    expect(wrapper.get('[data-testid="files-branch-chip-label"]').text()).toBe('Project folder');
    // its name leads with what it shows, then what activating it does
    expect(main(wrapper).attributes('aria-label')).toBe('Project folder, show worktree damocles/fix-login');
    expect(main(wrapper).attributes('title')).toBe('Showing the project folder. Click to show the worktree again. The arrow, a right-click or Shift+F10 opens the menu.');
    expect(main(wrapper).attributes('aria-haspopup')).toBeUndefined();
    await main(wrapper).trigger('click');
    await flushPromises();
    expect(api.showFolder).toHaveBeenCalledWith({ projectKey: 'p1', show: 'worktree' });
    expect(api.overlayRequests).toHaveLength(0);
  });

  it.each([
    ['its chevron', async (wrapper: VueWrapper) => chevron(wrapper).trigger('click')],
    ['a right-click', async (wrapper: VueWrapper) => main(wrapper).trigger('contextmenu')],
    ['Shift+F10', async (wrapper: VueWrapper) => main(wrapper).trigger('keydown', { key: 'F10', shiftKey: true })],
    ['the Menu key', async (wrapper: VueWrapper) => main(wrapper).trigger('keydown', { key: 'ContextMenu' })],
  ] as const)('opens its menu from the project folder through %s', async (_name, open) => {
    const api = fakeShellApi([]);
    const wrapper = mountChip(api, PROJECT_SHOWN);
    expect(chevron(wrapper).attributes('aria-label')).toBe('Worktree menu');
    expect(chevron(wrapper).attributes('tabindex')).toBeUndefined();
    api.answerNext({ kind: 'menu', itemId: 'showWorktree' });
    await open(wrapper);
    await flushPromises();
    expect(menuOf(api)?.items.find((item) => item.kind === 'item' && item.id === 'showProject')).toMatchObject({ checked: true });
    expect(api.showFolder).toHaveBeenCalledWith({ projectKey: 'p1', show: 'worktree' });
  });

  it('leaves the chevron to the mouse while the worktree shows, as the chip itself opens the same menu', () => {
    const wrapper = mountChip(fakeShellApi([]), SHOWN);
    expect(chevron(wrapper).attributes()).toMatchObject({ tabindex: '-1', 'aria-hidden': 'true' });
  });

  it('lets the rewritten state win over behind and runs a finish action on its worktree', async () => {
    const api = fakeShellApi([]);
    const wrapper = mountChip(api, { ...SHOWN, worktree: { ...SHOWN.worktree!, targetRewritten: true } });
    expect(wrapper.get('[data-testid="files-branch-chip-state"]').text()).toBe('· main was rewritten');
    api.answerNext({ kind: 'menu', itemId: 'worktree:update' });
    await main(wrapper).trigger('click');
    await flushPromises();
    expect(api.worktreeFinish).toHaveBeenCalledWith({ projectKey: 'p1', worktreeId: 'a1b2c3d4', action: 'update' });
  });

  it('disables New chat in this worktree with its reason while main offers none, and starts one where main says when it does', async () => {
    const api = fakeShellApi([]);
    const { newChatIn: _gone, ...finishing } = SHOWN.worktree!;
    const wrapper = mountChip(api, { ...SHOWN, worktree: finishing });
    await main(wrapper).trigger('click');
    await flushPromises();
    expect(menuOf(api)?.items[0]).toMatchObject({ id: 'newChatInWorktree', disabled: true, disabledReason: 'While a finish action runs' });

    await wrapper.setProps({ shown: SHOWN });
    api.answerNext({ kind: 'menu', itemId: 'newChatInWorktree' });
    await main(wrapper).trigger('click');
    await flushPromises();
    expect(api.newChatInWorktree).toHaveBeenCalledWith({ projectKey: 'p1', worktreeId: 'a1b2c3d4' });
    expect(isProxy(vi.mocked(api.newChatInWorktree).mock.calls[0]![0])).toBe(false);
  });
});

describe('worktree rows, the New menu and the worktree dialogs keep what the user reads and types', () => {
  function mountChats(api: DamoclesShellApi, selectedChatId = 'w1') {
    return track(mount(ChatsSection, {
      props: { api, projectKey: 'p1', stateRevision: 1, projectName: 'alpha', selectedChatId, newChatShortcut: 'Ctrl+N', newChatInWorktreeShortcut: 'Shift+Alt+N', collapsed: false },
      global: { plugins: [shellI18n] },
      attachTo: document.body,
    }));
  }
  const live = (id: string, worktreeId: string, extra: Partial<Parameters<typeof chat>[0]> = {}) => chat({
    id,
    title: id,
    worktree: { worktreeId, branch: `damocles/${id}`, status: 'live', baseBranch: 'main', finish: { busy: false, hasRemote: true, detachedTarget: false }, newChatIn: { projectKey: 'p1', worktreeId } },
    ...extra,
  });

  it('keeps a worktree chat\'s tag beside its branch, and the tag still filters the list', async () => {
    const api = fakeShellApi([live('w1', 'a1b2c3d4', { tag: 'review' }), chat({ id: 'n1', title: 'Normal', tag: 'review' }), chat({ id: 'n2', title: 'Other' })]);
    const wrapper = mountChats(api);
    await flushPromises();
    const row = wrapper.get('[data-chat-id="w1"]');
    expect(row.get('[data-testid="chat-worktree-line"]').text()).toBe('w1');
    expect(row.get('[data-testid="chat-tag"]').text()).toBe('review');
    await row.get('[data-testid="chat-tag"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-chat-id]').map((each) => each.attributes('data-chat-id'))).toEqual(['w1', 'n1']);
  });

  it('gives every cut worktree line its whole text as a tooltip, and names a worktree chat as one for assistive technology', async () => {
    const api = fakeShellApi([
      chat({ id: 'p', title: 'Pending', worktree: { branch: 'feature/a-very-long-branch-name', status: 'pending' } }),
      chat({ id: 'd', title: 'Gone', readOnly: true, worktree: { worktreeId: 'b1b2c3d4', branch: 'x', status: 'deleted', fromProject: 'alpha-hotfix-with-a-long-name' } }),
      live('w1', 'a1b2c3d4'),
      chat({ id: 'n1', title: 'Normal' }),
    ]);
    const wrapper = mountChats(api);
    await flushPromises();
    const line = (id: string) => wrapper.get(`[data-chat-id="${id}"] [data-testid="chat-worktree-line"]`);
    expect(line('p').attributes('title')).toBe('New worktree from feature/a-very-long-branch-name');
    expect(line('d').attributes('title')).toBe('Worktree deleted · alpha-hotfix-with-a-long-name');
    expect(wrapper.get('[data-chat-id="w1"]').text()).toContain('Worktree chat');
    expect(wrapper.get('[data-chat-id="n1"]').text()).not.toContain('Worktree chat');
  });

  it('names Shift+Alt+N only on the selected chat\'s row menu, the worktree that key acts on', async () => {
    const api = fakeShellApi([live('w1', 'a1b2c3d4'), live('w2', 'b1b2c3d4')]);
    const wrapper = mountChats(api, 'w1');
    await flushPromises();
    const newHereOf = async (id: string) => {
      await wrapper.get(`[data-chat-id="${id}"]`).trigger('contextmenu');
      await flushPromises();
      const menu = api.overlayRequests.at(-1);
      const submenu = menu?.kind === 'menu' ? menu.items.find((item) => item.kind === 'submenu') : undefined;
      return submenu?.kind === 'submenu' ? submenu.items[0] : undefined;
    };
    expect(await newHereOf('w1')).toMatchObject({ id: 'newChatInWorktree', shortcut: 'Shift+Alt+N' });
    expect(await newHereOf('w2')).not.toHaveProperty('shortcut');
  });

  it('labels the New split button\'s group apart from its New chat button, and says why the chevron waits before a project is known', async () => {
    const api = fakeShellApi([]);
    const wrapper = track(mount(ChatsSection, {
      props: { api, projectKey: undefined, stateRevision: 1, projectName: '', selectedChatId: undefined, newChatShortcut: 'Ctrl+N', newChatInWorktreeShortcut: 'Shift+Alt+N', collapsed: false },
      global: { plugins: [shellI18n] },
      attachTo: document.body,
    }));
    await flushPromises();
    const group = wrapper.get('[role="group"]:has([data-testid="new-chat"])');
    expect(group.attributes('aria-label')).not.toBe(wrapper.get('[data-testid="new-chat"]').attributes('aria-label'));
    const chevron = wrapper.get('[data-testid="new-chat-options"]');
    expect(chevron.attributes('aria-disabled')).toBe('true');
    expect(chevron.attributes('title')).toBe('New chat options are available once Damocles has started');
    await chevron.trigger('click');
    await flushPromises();
    expect(api.overlayRequests).toHaveLength(0);
  });

  it('starts from HEAD on a detached HEAD, the current start core offers, and still offers the uncommitted changes', async () => {
    const api = fakeOverlayApi();
    api.worktree.options = opened({
      available: true,
      currentBranch: null,
      branches: [
        { ref: 'HEAD', name: '9f3c2a1', current: true, remote: false },
        { ref: 'refs/remotes/origin/main', name: 'origin/main', current: false, remote: true },
        { ref: 'refs/heads/main', name: 'main', current: false, remote: false },
      ],
      uncommittedCount: 2,
      projectName: 'alpha',
      branchPrefix: 'ax/',
    });
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'm1', MENU_REQUEST);
    await click('[data-testid="new-chat-menu-worktree"]');
    expect(get('[data-testid="new-chat-menu-start"]').textContent).toMatch(/9f3c2a1\s*current/);
    expect(q('[data-testid="new-chat-menu-bring"]')).not.toBeNull();
    await click('[data-testid="new-chat-menu-create"]');
    await settle(wrapper);
    expect(lastAnswer(api)).toEqual({ kind: 'newChatMenu', choice: 'worktree', startRef: 'HEAD', bringChanges: true });
  });

  it('describes the Create row by the note on what it creates, and keeps the Enter hint out of its name', async () => {
    const api = fakeOverlayApi();
    api.worktree.options = opened(OPTIONS);
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'm1', MENU_REQUEST);
    await click('[data-testid="new-chat-menu-worktree"]');
    const create = get('[data-testid="new-chat-menu-create"]');
    expect(document.getElementById(create.getAttribute('aria-describedby') ?? '')).toBe(get('[data-testid="new-chat-menu-note"]'));
    const hint = create.querySelector('kbd');
    expect(hint?.getAttribute('aria-hidden')).toBe('true');
  });

  const MERGE: WorktreeDialogRequest = { kind: 'worktreeDialog', dialog: 'mergeMessage', branch: 'damocles/fix-login', target: 'main', files: [{ path: 'src/a.ts', letter: 'M' }] };
  const typeMessage = async (text: string): Promise<void> => {
    const box = get<HTMLTextAreaElement>('[data-testid="worktree-dialog-message"]');
    box.value = text;
    box.dispatchEvent(new Event('input'));
    await flushPromises();
  };
  const scrim = (): HTMLElement => get('[data-testid="worktree-dialog"]').parentElement!;

  it('keeps a typed merge message through a click or right-click beside the dialog; Escape and Cancel still close it', async () => {
    const api = fakeOverlayApi();
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'd1', MERGE);
    await typeMessage('Fix the login redirect');
    scrim().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    scrim().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await settle(wrapper);
    expect(q('[data-testid="worktree-dialog"]')).not.toBeNull();
    expect(get<HTMLTextAreaElement>('[data-testid="worktree-dialog-message"]').value).toBe('Fix the login redirect');
    expect(api.answer).not.toHaveBeenCalled();
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(wrapper);
    expect(lastAnswer(api)).toEqual({ kind: 'worktreeDialog', dialog: 'mergeMessage', choice: 'cancel', message: '' });

    await open(wrapper, api, 'd2', MERGE);
    await typeMessage('Another message');
    await click('[data-testid="worktree-dialog-cancel"]');
    await settle(wrapper);
    expect(vi.mocked(api.answer).mock.calls.at(-1)?.[0]).toBe('d2');
  });

  it('lets a click beside the merge dialog close it while its message is blank', async () => {
    const api = fakeOverlayApi();
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'd1', MERGE);
    await typeMessage('   ');
    scrim().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle(wrapper);
    expect(lastAnswer(api)).toEqual({ kind: 'worktreeDialog', dialog: 'mergeMessage', choice: 'cancel', message: '' });
  });

  it('keeps the message read-only while one is generated, so the result never replaces text typed meanwhile', async () => {
    const api = fakeOverlayApi();
    let resolve: (value: { ok: true; value: { message: string } }) => void = () => undefined;
    vi.mocked(api.generateWorktreeMessage).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'd1', MERGE);
    await click('[data-testid="worktree-dialog-generate"]');
    const box = get<HTMLTextAreaElement>('[data-testid="worktree-dialog-message"]');
    expect(box.readOnly).toBe(true);
    resolve({ ok: true, value: { message: 'Generated' } });
    await flushPromises();
    await wrapper.vm.$nextTick();
    expect(box.readOnly).toBe(false);
    expect(box.value).toBe('Generated');
  });

  it('says why Also delete branch cannot change when the branch is checked out elsewhere', async () => {
    const api = fakeOverlayApi();
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'd1', { kind: 'worktreeDialog', dialog: 'delete', path: '/w/a', branch: 'damocles/x', uncommitted: [], submoduleChanges: [], unmergedCommits: [], deleteBranchDefault: false, deleteBranchLocked: true });
    const reason = get('[data-testid="worktree-dialog-branch-locked"]');
    expect(reason.textContent?.trim()).toBe('The branch is checked out in another folder, so Damocles cannot delete it.');
    const box = get('[data-testid="worktree-dialog-delete-branch"]');
    expect(box.getAttribute('aria-describedby')).toBe(reason.id);
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(wrapper);
    await open(wrapper, api, 'd2', { kind: 'worktreeDialog', dialog: 'delete', path: '/w/a', branch: 'damocles/x', uncommitted: [], submoduleChanges: [], unmergedCommits: [], deleteBranchDefault: true, deleteBranchLocked: false });
    expect(q('[data-testid="worktree-dialog-branch-locked"]')).toBeNull();
  });

  it('shows a file\'s and an unmerged commit\'s whole text in their tooltips, with hidden characters as escapes', async () => {
    const api = fakeOverlayApi();
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'd1', { kind: 'worktreeDialog', dialog: 'delete', path: '/w/a', branch: 'damocles/x', uncommitted: [{ path: 'src/notes\u202Etxt.ts', letter: 'M' }], submoduleChanges: [], unmergedCommits: [{ hash: '0123456789abcdef', subject: 'A long subject that the dialog cuts to its width' }], deleteBranchDefault: false, deleteBranchLocked: false });
    expect(get('[data-testid="worktree-dialog-file"]').getAttribute('title')).toBe('src/notes\\u{202E}txt.ts');
    expect(get('[data-testid="worktree-dialog-commits"] li').getAttribute('title')).toBe('A long subject that the dialog cuts to its width');
  });

  it('says Prune clears every stale worktree record of the repository, not only its row', async () => {
    const api = fakeOverlayApi();
    const wrapper = mountOverlay(api);
    await open(wrapper, api, 'd1', { kind: 'worktreeDialog', dialog: 'leftovers', items: [{ path: '/w/gone', reason: 'gitRecordOnly', repository: '/w/alpha' }, { path: '/w/idle', reason: 'noChat' }] });
    expect(get('[data-testid="worktree-dialog-prune"]').getAttribute('title')).toBe("Removes git's record of every worktree of this repository whose folder is gone, not only this one");
  });
});
