// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import type { ChatsContinueWorktree, ChatsWorktreeOptions, ShellEditorTab, ShownFolder } from '../../preload/shell-channels';
import type { OverlayAnswer } from '../../preload/overlay-channels';
import OverlayApp from '../overlay/OverlayApp.vue';
import ChatsSection from '../components/ChatsSection.vue';
import FilesBranchChip from '../components/FilesBranchChip.vue';
import ProjectsSection from '../components/ProjectsSection.vue';
import TabPlaceChip from '../editor/TabPlaceChip.vue';
import Breadcrumbs from '../editor/Breadcrumbs.vue';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, STATE, chat, fakeOverlayApi, fakeShellApi, opened, type FakeOverlayApi } from './fakes';

// A ref name may carry a right-to-left override (git's check-ref-format allows it), which would make it read as another.
const BIDI = 'main\u202Eevil';
const SHOWN = 'main\\u{202E}evil';
const RAW = '\u202E';

const mounted: VueWrapper[] = [];
const track = <T extends VueWrapper>(wrapper: T): T => {
  mounted.push(wrapper);
  return wrapper;
};

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// The frames Vue's transitions wait for before they finish.
async function frames(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await flushPromises();
  }
}

// What a reader sees or hears: text, tooltips and accessible names; data attributes keep the raw ref, the value a choice sends.
function shownText(element: Element): string {
  const nodes = [element, ...element.querySelectorAll('*')];
  return [element.textContent ?? '', ...nodes.flatMap((node) => ['title', 'aria-label'].map((name) => node.getAttribute(name) ?? ''))].join('\n');
}

function get<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`no element matches ${selector}`);
  return element;
}

describe('git branch names show their hidden characters', () => {
  it('in the New menu: Start from, its picker, the note and the Continue rows, while the answer keeps the raw ref', async () => {
    const options: ChatsWorktreeOptions = {
      available: true,
      currentBranch: BIDI,
      branches: [
        { ref: `refs/heads/${BIDI}`, name: BIDI, current: true, remote: false },
        { ref: `refs/remotes/origin/${BIDI}`, name: `origin/${BIDI}`, current: false, remote: true, newer: 1 },
      ],
      uncommittedCount: 0,
      projectName: 'alpha',
      branchPrefix: 'ax/',
    };
    const worktree = (index: number): ChatsContinueWorktree => ({ worktreeId: `w000000${index}`, branch: `ax/${BIDI}-${index}`, chatCount: 1, added: 1, removed: 0, behind: 1, baseBranch: BIDI, lastActivity: 100 - index });
    const api: FakeOverlayApi = fakeOverlayApi();
    api.worktree.options = opened(options);
    api.worktree.continue = opened([0, 1, 2, 3, 4, 5].map(worktree));
    track(mount(OverlayApp, {
      props: { api, settingsBridge: createOverlaySettingsBridge(api) },
      global: { plugins: [shellI18n, createPinia()], stubs: { transition: false, 'transition-group': false } },
      attachTo: document.body,
    }));
    api.request('m1', { kind: 'newChatMenu', anchor: { x: 200, y: 40, width: 60, height: 22 }, projectKey: 'p1', projectName: 'alpha', shortcut: 'Ctrl+N' });
    await frames();
    get('[data-testid="new-chat-menu-worktree"]').click();
    await frames();

    const start = get('[data-testid="new-chat-menu-start"]');
    expect(start.textContent).toContain(SHOWN);
    expect(start.getAttribute('title')).toContain(SHOWN);
    expect(get('[data-testid="new-chat-menu-note"]').textContent).toContain(SHOWN);
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="new-chat-menu-continue-row"]')];
    expect(rows[0]?.textContent).toContain(SHOWN);
    expect(rows[0]?.getAttribute('title')).toBe(`ax/${SHOWN}-0`);
    start.click();
    await frames();
    expect(get('[data-testid="new-chat-menu-picker"]').textContent).toContain(`origin/${SHOWN}`);
    expect(shownText(get('[data-testid="new-chat-menu"]'))).not.toContain(RAW);
    get('[data-testid="new-chat-menu-picker-filter"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await frames();
    get('[data-testid="new-chat-menu-all-worktrees"]').click();
    await frames();
    expect(get('[data-testid="new-chat-menu-worktree-picker"]').textContent).toContain(`ax/${SHOWN}-5`);
    expect(shownText(get('[data-testid="new-chat-menu"]'))).not.toContain(RAW);
    get('[data-testid="new-chat-menu-worktree-filter"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await frames();

    get('[data-testid="new-chat-menu-create"]').click();
    await frames();
    const answer = vi.mocked(api.answer).mock.calls.at(-1)?.[1] as OverlayAnswer | undefined;
    expect(answer).toEqual({ kind: 'newChatMenu', choice: 'worktree', startRef: `refs/heads/${BIDI}`, bringChanges: false });
  });

  it('in the chat rows and a worktree chat\'s menu', async () => {
    const api = fakeShellApi([
      chat({ id: 'w1', title: 'Live', worktree: { worktreeId: 'a1b2c3d4', branch: `ax/${BIDI}`, status: 'live', baseBranch: BIDI, finish: { busy: false, hasRemote: true, detachedTarget: false } } }),
      chat({ id: 'w2', title: 'Pending', worktree: { branch: BIDI, status: 'pending' } }),
      chat({ id: 'w3', title: 'Moved', worktree: { worktreeId: 'b1b2c3d4', branch: `ax/${BIDI}`, status: 'inProjectFolder' } }),
    ]);
    const wrapper = track(mount(ChatsSection, {
      props: { api, projectKey: 'p1', stateRevision: 1, projectName: 'alpha', selectedChatId: 'w1', newChatShortcut: 'Ctrl+N', newChatInWorktreeShortcut: 'Shift+Alt+N', collapsed: false },
      global: { plugins: [shellI18n] },
      attachTo: document.body,
    }));
    await flushPromises();
    const line = (id: string) => wrapper.get(`[data-chat-id="${id}"] [data-testid="chat-worktree-line"]`);
    expect(line('w1').text()).toBe(SHOWN);
    expect(line('w1').attributes('title')).toBe(`ax/${SHOWN}`);
    expect(line('w2').text()).toContain(SHOWN);
    expect(line('w3').text()).toContain(SHOWN);
    expect(shownText(wrapper.get('[data-testid="chat-list"]').element)).not.toContain(RAW);

    await wrapper.get('[data-chat-id="w1"]').trigger('contextmenu');
    await flushPromises();
    const menu = api.overlayRequests.at(-1);
    const submenu = menu?.kind === 'menu' ? menu.items.find((item) => item.kind === 'submenu') : undefined;
    expect(submenu?.kind === 'submenu' && submenu.items.map((item) => (item.kind === 'item' ? item.label : ''))).toContain(`Merge into ${SHOWN}`);
    expect(JSON.stringify(api.overlayRequests.at(-1))).not.toContain(RAW);
  });

  it('on the Files chip, in its tooltip, its accessible name and its menu', async () => {
    const shown: ShownFolder = {
      projectKey: 'p1',
      root: { projectKey: 'p1', worktreeId: 'a1b2c3d4' },
      rootKey: 'p1\u0000a1b2c3d4',
      fsPath: '/w/.damocles/worktrees/alpha/a1b2c3d4',
      canShowWorktree: true,
      worktree: { worktreeId: 'a1b2c3d4', chatId: 'w1', branch: `ax/${BIDI}`, baseBranch: BIDI, behind: 1, targetRewritten: false, place: 'worktree', finish: { busy: false, hasRemote: true, detachedTarget: false } },
    };
    const api = fakeShellApi([]);
    const wrapper = track(mount(FilesBranchChip, { props: { api, shown }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    expect(wrapper.text()).toContain(SHOWN);
    expect(shownText(wrapper.element)).not.toContain(RAW);
    const main = wrapper.get('[data-testid="files-branch-chip-main"]');
    await main.trigger('click');
    await flushPromises();
    const menu = api.overlayRequests.at(-1);
    expect(menu?.kind === 'menu' && [menu.caption, menu.label]).toEqual([`ax/${SHOWN}`, `Worktree ax/${SHOWN}`]);
    expect(JSON.stringify(api.overlayRequests.at(-1))).not.toContain(RAW);
  });

  it('on an editor tab\'s place chip and in the breadcrumbs', () => {
    const place = { kind: 'worktree' as const, branch: `ax/${BIDI}`, label: BIDI };
    const chip = track(mount(TabPlaceChip, { props: { place, folded: false }, global: { plugins: [shellI18n] } }));
    expect(chip.text()).toBe(SHOWN);
    expect(chip.attributes('title')).toContain(`ax/${SHOWN}`);
    expect(shownText(chip.element)).not.toContain(RAW);
    const tab = { id: 't', kind: 'code', title: 'a.ts', displayPath: 'src/a.ts', relativePath: 'src/a.ts', projectKey: 'p1\u0000a1b2c3d4', worktreeBranch: `ax/${BIDI}` } as ShellEditorTab;
    const crumbs = track(mount(Breadcrumbs, { props: { tab, projectName: 'acme', place }, global: { plugins: [shellI18n] } }));
    expect(crumbs.get('[data-testid="editor-breadcrumb-place"]').text()).toContain(SHOWN);
    expect(shownText(crumbs.element)).not.toContain(RAW);
  });

  it('on the Projects list', () => {
    const projects = [{ ...STATE.projects[0]!, branch: BIDI }];
    const wrapper = track(mount(ProjectsSection, { props: { api: fakeShellApi(), projects, selectedKey: 'p1', remoteEnabled: false, hosts: [], view: 'flat', groups: STATE.projectGroups, platform: 'win32', collapsed: false, bodySize: 150 }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    expect(wrapper.get('[data-testid="project-branch"]').text()).toBe(SHOWN);
    expect(shownText(wrapper.element)).not.toContain(RAW);
  });
});
