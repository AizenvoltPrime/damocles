// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import ChatHeader from '../chat-header/ChatHeader.vue';
import WorktreeComposerStatus from '../composer/WorktreeComposerStatus.vue';
import WorktreePendingChip from '../composer/WorktreePendingChip.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import { i18n } from '@/i18n';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';

// A ref name may carry a right-to-left override (git's check-ref-format allows it), which would make it read as another.
const BIDI = 'main\u202Eevil';
const SHOWN = 'main\\u{202E}evil';
const RAW = '\u202E';
const DESKTOP = { ...VSCODE_HOST_CAPABILITIES, historyInPanel: false, folderPickerInPanel: false, settingsInPanel: false, worktrees: true };

class FakeResizeObserver {
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(): void {
    this.callback([{ borderBoxSize: [{ inlineSize: 820, blockSize: 46 }], contentRect: { width: 820, height: 46 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  disconnect(): void {}
  unobserve(): void {}
}

const mounted: VueWrapper[] = [];
beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
// What a reader sees or hears: text, tooltips and accessible names.
function shownText(element: Element): string {
  const nodes = [element, ...element.querySelectorAll('*')];
  return [element.textContent ?? '', ...nodes.flatMap((node) => ['title', 'aria-label'].map((name) => node.getAttribute(name) ?? ''))].join('\n');
}

async function mountHeader(): Promise<void> {
  mounted.push(mount(ChatHeader, { attachTo: document.body, global: { plugins: [i18n] } }));
  await nextTick();
}

async function openMenu(testId: string): Promise<HTMLElement> {
  const trigger = byTestId(testId)!;
  trigger.focus();
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();
  return trigger;
}

describe('git branch names in the chat page show their hidden characters', () => {
  it('in the header\'s branch chip and Hand off\'s project folder line', async () => {
    useSettingsStore().setHostCapabilities(DESKTOP);
    useSettingsStore().setWorkspaceFolders([{ key: 'c:\\work\\app', name: 'app', label: 'app', path: 'C:\\work\\app', branch: BIDI }], 'c:\\work\\app', 'c:\\work\\app');
    useUIStore().worktree = { phase: 'none', place: 'project', canHandOff: true };
    await mountHeader();
    const branch = byTestId('chat-header-branch')!;
    expect(branch.textContent?.trim()).toBe(SHOWN);
    expect(shownText(branch)).not.toContain(RAW);
    await openMenu('chat-header-hand-off');
    const current = byTestId('hand-off-current')!;
    expect(current.textContent).toContain(SHOWN);
    expect(shownText(current)).not.toContain(RAW);
  });

  it('in the worktree chip, its menu, its behind note and Hand off\'s worktree line', async () => {
    useSettingsStore().setHostCapabilities(DESKTOP);
    useUIStore().worktree = { phase: 'ready', place: 'worktree', canHandOff: true, branch: `ax/${BIDI}`, baseBranch: BIDI, behind: 2, projectName: 'app' };
    await mountHeader();
    const chip = byTestId('chat-header-worktree')!;
    expect(byTestId('chat-header-worktree-label')?.textContent).toBe(SHOWN);
    expect(chip.getAttribute('title')).toContain(`ax/${SHOWN}`);
    expect(shownText(byTestId('chat-header')!)).not.toContain(RAW);
    expect(byTestId('chat-header')!.textContent).toContain(`2 behind ${SHOWN}`);
    await openMenu('chat-header-worktree');
    const menu = byTestId('chat-header-worktree-menu')!;
    expect(menu.textContent).toContain(`ax/${SHOWN}`);
    expect(shownText(menu)).not.toContain(RAW);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    await openMenu('chat-header-hand-off');
    expect(byTestId('hand-off-current')?.textContent).toContain(`ax/${SHOWN}`);
    expect(shownText(byTestId('hand-off-menu')!)).not.toContain(RAW);
  });

  it('in the header\'s rewritten note', async () => {
    useSettingsStore().setHostCapabilities(DESKTOP);
    useUIStore().worktree = { phase: 'ready', place: 'worktree', canHandOff: true, branch: 'ax/fix', baseBranch: BIDI, targetRewritten: true, projectName: 'app' };
    await mountHeader();
    expect(byTestId('chat-header')!.textContent).toContain(`${SHOWN} was rewritten`);
    expect(shownText(byTestId('chat-header')!)).not.toContain(RAW);
  });

  it('in the composer\'s opt-in chip and its tooltip', () => {
    const wrapper = mount(WorktreePendingChip, { props: { branch: BIDI }, global: { plugins: [i18n] } });
    mounted.push(wrapper);
    expect(wrapper.get('[data-testid="worktree-chip"]').text()).toContain(SHOWN);
    expect(wrapper.get('[data-testid="worktree-chip"]').attributes('title')).toContain(SHOWN);
    expect(shownText(wrapper.element)).not.toContain(RAW);
  });

  it('in the failed creation card\'s error, keeping its lines', () => {
    const error = `fatal: '${BIDI}' is not a valid branch\u0007\nsecond line`;
    const wrapper = mount(WorktreeComposerStatus, { props: { state: { phase: 'createFailed', place: 'project', canHandOff: false, error, projectName: 'app' } }, global: { plugins: [i18n] } });
    mounted.push(wrapper);
    expect(wrapper.get('[data-testid="worktree-status-error"]').element.textContent?.trim()).toBe(`fatal: '${SHOWN}' is not a valid branch\\u{7}\nsecond line`);
    expect(shownText(wrapper.element)).not.toContain(RAW);
  });

  it('in the header\'s project name of a worktree chat', async () => {
    useSettingsStore().setHostCapabilities(DESKTOP);
    useUIStore().worktree = { phase: 'ready', place: 'worktree', canHandOff: true, branch: 'ax/fix', projectName: BIDI };
    await mountHeader();
    const folder = byTestId('chat-header-folder')!;
    expect(folder.textContent?.trim()).toBe(SHOWN);
    expect(shownText(folder)).not.toContain(RAW);
  });

  it('in the composer\'s setup card', () => {
    const wrapper = mount(WorktreeComposerStatus, { props: { state: { phase: 'settingUp', place: 'worktree', canHandOff: false, branch: `ax/${BIDI}`, projectName: 'app' } }, global: { plugins: [i18n] } });
    mounted.push(wrapper);
    expect(wrapper.text()).toContain(`ax/${SHOWN}`);
    expect(shownText(wrapper.element)).not.toContain(RAW);
  });
});
