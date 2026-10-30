// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import App from '@/App.vue';
import ToolCardFrame from '../ToolCardFrame.vue';
import RewindBrowser from '../RewindBrowser.vue';
import RewindConfirmModal from '../RewindConfirmModal.vue';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import { usePlatformBridge, type PlatformBridge } from '@/composables/usePlatformBridge';
import { VSCODE_HOST_CAPABILITIES, type ExtensionToWebviewMessage, type WorktreeStateData } from '@shared/types/messages';
import { Wrench } from 'lucide-vue-next';

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

let app: VueWrapper | null = null;
let posted: { type: string; [key: string]: unknown }[] = [];
const mounted: VueWrapper[] = [];

const observers = new Set<FakeResizeObserver>();

class FakeResizeObserver {
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.add(this);
  }
  observe(): void {
    this.report(46);
  }
  report(blockSize: number): void {
    this.callback([{ contentRect: { width: 16, height: 16 }, borderBoxSize: [{ inlineSize: 900, blockSize }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  disconnect(): void {
    observers.delete(this);
  }
  unobserve(): void {}
}

function resizeAll(blockSize: number): void {
  for (const observer of observers) observer.report(blockSize);
}

beforeEach(() => {
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
  posted = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as { type: string }));
});

afterEach(() => {
  app?.unmount();
  app = null;
  while (mounted.length) mounted.pop()?.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

// Transitions end on a timer in happy-dom, which runs no animations.
const frames = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const q = (selector: string): HTMLElement | null => document.body.querySelector<HTMLElement>(selector);

async function mountApp(): Promise<VueWrapper> {
  useSettingsStore().hostCapabilities = { ...VSCODE_HOST_CAPABILITIES, worktrees: true, windowLayout: true, historyInPanel: false, folderPickerInPanel: false, settingsInPanel: false };
  app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
  await nextTick();
  return app;
}

async function send(message: ExtensionToWebviewMessage): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
  await nextTick();
  await frames();
}

const state = (patch: Partial<WorktreeStateData>): ExtensionToWebviewMessage => ({ type: 'worktreeState', phase: 'none', place: 'project', canHandOff: true, ...patch });

describe('worktree states in the composer (D30)', () => {
  it('shows nothing worktree until the host sends a state, so VS Code is unchanged', async () => {
    await mountApp();
    expect(useUIStore().worktree).toBeNull();
    expect(q('[data-testid="worktree-chip"]')).toBeNull();
    expect(q('[data-testid="worktree-status"]')).toBeNull();
    expect(q('[data-testid="chat-header-hand-off"]')).toBeNull();
  });

  it('shows the opt-in chip with the uncommitted count, and removing it cancels the opt-in', async () => {
    await mountApp();
    await send(state({ phase: 'pending', branch: 'main', uncommittedCount: 3 }));
    const chip = q('[data-testid="worktree-chip"]')!;
    expect(chip.textContent).toContain('Worktree from main');
    expect(chip.textContent).toContain('· +3 uncommitted');
    q('[data-testid="worktree-chip-remove"]')!.click();
    expect(posted).toContainEqual({ type: 'worktreeAction', action: 'cancelOptIn' });

    await send(state({ phase: 'pending', branch: 'feat/a' }));
    expect(q('[data-testid="worktree-chip"]')?.textContent).not.toContain('uncommitted');
  });

  it('waits for setup with a live clock and Send now, then moves through a failure to Send anyway and Retry', async () => {
    await mountApp();
    const heldPrompt = { text: 'fix the login redirect', imageCount: 0 };
    await send(state({ phase: 'settingUp', place: 'worktree', branch: 'damocles/fix-login', heldPrompt, canHandOff: false }));
    const card = q('[data-testid="worktree-status"]')!;
    expect(card.dataset.phase).toBe('settingUp');
    expect(q('[data-testid="worktree-status-title"]')?.textContent).toContain('Setting up worktree');
    expect(q('[data-testid="worktree-status-elapsed"]')?.textContent).toBe('0:00');
    expect(q('[data-testid="worktree-status-note"]')?.textContent?.trim()).toBe('Your message waits for the setup, which runs in the Setup terminal.');
    expect(card.querySelector('.d-sweep-bar')).not.toBeNull();
    q('[data-testid="worktree-send-now"]')!.click();
    await nextTick();
    expect(posted).toContainEqual({ type: 'worktreeAction', action: 'sendNow' });

    await send(state({ phase: 'setupFailed', place: 'worktree', branch: 'damocles/fix-login', exitCode: 2, heldPrompt, canHandOff: false }));
    await frames();
    expect(q('[data-testid="worktree-status-title"]')?.textContent).toContain('Setup failed (exit 2)');
    q('[data-testid="worktree-send-anyway"]')!.click();
    q('[data-testid="worktree-retry"]')!.click();
    expect(posted).toEqual(expect.arrayContaining([{ type: 'worktreeAction', action: 'sendNow' }, { type: 'worktreeAction', action: 'retry' }]));
  });

  it('leaves Send now to core, changing nothing until core publishes the next state', async () => {
    await mountApp();
    await send(state({ phase: 'settingUp', place: 'worktree', branch: 'damocles/fix-login', heldPrompt: { text: 'add a test', imageCount: 0 }, canHandOff: false }));
    const note = q('[data-testid="worktree-status-note"]')?.textContent;
    q('[data-testid="worktree-send-now"]')!.click();
    await nextTick();
    expect(q('[data-testid="worktree-status-note"]')?.textContent).toBe(note);
    expect(q('[data-testid="worktree-send-now"]')).not.toBeNull();
  });

  it('after a hand-off, sets up with nothing to send now and says a message would wait', async () => {
    await mountApp();
    await send(state({ phase: 'settingUp', place: 'worktree', branch: 'damocles/fix-login', canHandOff: false }));
    expect(q('[data-testid="worktree-send-now"]')).toBeNull();
    expect(q('[data-testid="worktree-held-prompt"]')).toBeNull();
    expect(q('[data-testid="worktree-status-note"]')?.textContent?.trim()).toBe('The chat moved here. A message you send waits for the setup, which runs in the Setup terminal.');
    expect(q('[data-testid="worktree-show-setup-terminal"]')).not.toBeNull();

    await send(state({ phase: 'setupFailed', place: 'worktree', branch: 'damocles/fix-login', exitCode: 1, canHandOff: false }));
    await frames();
    expect(q('[data-testid="worktree-send-anyway"]')).toBeNull();
    expect(q('[data-testid="worktree-status-note"]')?.textContent?.trim()).toBe('The Setup terminal shows what went wrong. A message you send waits until you retry or continue.');
    q('[data-testid="worktree-continue"]')!.click();
    expect(posted).toContainEqual({ type: 'worktreeAction', action: 'sendNow' });

    i18n.global.locale.value = 'el';
    await nextTick();
    expect(q('[data-testid="worktree-continue"]')?.textContent?.trim()).toBe('Συνέχεια χωρίς προετοιμασία');
  });

  it("renders a failed creation's error in the view's language", async () => {
    await mountApp();
    await send(state({ phase: 'createFailed', error: { message: 'Trust this folder to use worktrees' }, canHandOff: false }));
    i18n.global.locale.value = 'el';
    await nextTick();
    expect(q('[data-testid="worktree-status-error"]')?.textContent?.trim()).toBe('Εμπιστευτείτε αυτόν τον φάκελο για να χρησιμοποιήσετε worktrees');
  });

  it('keeps the ticking clock out of what the status region announces', async () => {
    await mountApp();
    await send(state({ phase: 'creating', place: 'project', branch: 'damocles/fix-login', heldPrompt: { text: 'add a test', imageCount: 0 }, canHandOff: false }));
    const clock = q('[data-testid="worktree-status-elapsed"]')!;
    expect(clock.closest('[role="status"]')).not.toBeNull();
    expect(clock.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows a control or bidi character in the setup command as its escape, as the review dialog does', async () => {
    await mountApp();
    await send(state({ phase: 'settingUp', place: 'worktree', branch: 'damocles/fix-login', setupStep: { command: 'npm ci\u202e# safe', index: 1, total: 1 }, canHandOff: false }));
    expect(q('[data-testid="worktree-setup-step"]')?.textContent).toContain('npm ci\\u{202E}# safe');
  });

  it('keeps the prompt on a failed creation, with git\'s error, Retry and Run in project folder', async () => {
    await mountApp();
    const heldPrompt = { text: 'fix the login redirect', imageCount: 0 };
    await send(state({ phase: 'createFailed', error: { message: '{0}', args: ["fatal: 'damocles/..' is not a valid branch name"] }, heldPrompt, canHandOff: false }));
    expect(q('[data-testid="worktree-status-title"]')?.textContent).toContain("Couldn't create the worktree");
    expect(q('[data-testid="worktree-status-error"]')?.textContent).toContain('is not a valid branch name');
    expect(q('[data-testid="worktree-held-prompt"]')?.textContent).toContain('fix the login redirect');
    q('[data-testid="worktree-run-in-project"]')!.click();
    expect(posted).toContainEqual({ type: 'worktreeAction', action: 'runInProjectFolder' });
    // once core sends it, the chat is back in the project folder and the held prompt is gone
    await send(state({ phase: 'none' }));
    expect(q('[data-testid="worktree-held-prompt"]')).toBeNull();
  });

  it.each(['creating', 'settingUp', 'setupFailed', 'createFailed'] as const)('shows core\'s held prompt with its images while %s', async (phase) => {
    await mountApp();
    await send(state({ phase, place: 'worktree', branch: 'damocles/fix-login', heldPrompt: { text: 'add a test', imageCount: 2 }, canHandOff: false }));
    expect(q('[data-testid="worktree-held-prompt"]')?.textContent).toContain('add a test');
    expect(q('[data-testid="worktree-held-prompt-images"]')?.textContent).toContain('2 images');
  });

  it('names the running setup command and its place, and shows the Setup terminal', async () => {
    await mountApp();
    await send(state({ phase: 'settingUp', place: 'worktree', branch: 'damocles/fix-login', setupStep: { command: 'npm ci', index: 1, total: 3 }, canHandOff: false }));
    expect(q('[data-testid="worktree-setup-step"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('npm ci (1 of 3)');
    q('[data-testid="worktree-show-setup-terminal"]')!.click();
    expect(posted).toContainEqual({ type: 'worktreeAction', action: 'showSetupTerminal' });
    await send(state({ phase: 'setupFailed', place: 'worktree', branch: 'damocles/fix-login', exitCode: 1, canHandOff: false }));
    await frames();
    expect(q('[data-testid="worktree-setup-step"]')).toBeNull();
    expect(q('[data-testid="worktree-show-setup-terminal"]')).not.toBeNull();
  });

  it('says how many other chats share the worktree, from core\'s count only', async () => {
    await mountApp();
    await send(state({ phase: 'ready', place: 'worktree', branch: 'damocles/fix-login' }));
    expect(q('[data-testid="composer-worktree-shares"]')).toBeNull();
    await send(state({ phase: 'ready', place: 'worktree', branch: 'damocles/fix-login', sharedWith: 1 }));
    expect(q('[data-testid="composer-worktree-shares"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Shares fix-login with 1 other chat');
    await send(state({ phase: 'ready', place: 'worktree', branch: 'damocles/fix-login', sharedWith: 3 }));
    expect(q('[data-testid="composer-worktree-shares"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Shares fix-login with 3 other chats');
    i18n.global.locale.value = 'el';
    await nextTick();
    expect(q('[data-testid="composer-worktree-shares"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Μοιράζεται το fix-login με 3 άλλες συνομιλίες');
  });

  it('refuses to send while a finish action runs, saying why, and keeps the draft', async () => {
    const wrapper = await mountApp();
    await send(state({ phase: 'ready', place: 'worktree', branch: 'damocles/fix-login', finishing: 'apply' }));
    expect(q('[data-testid="composer-worktree-finishing"]')?.textContent).toContain('Applying this worktree to the project folder');
    await wrapper.get('textarea').setValue('next step');
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' });
    expect(posted.some((message) => message.type === 'sendMessage')).toBe(false);
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('next step');
    expect((q('[data-testid="composer-send"]') as HTMLButtonElement).disabled).toBe(true);
    await send(state({ phase: 'ready', place: 'worktree', branch: 'damocles/fix-login' }));
    await frames();
    expect(q('[data-testid="composer-worktree-finishing"]')).toBeNull();
    expect((q('[data-testid="composer-send"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('replaces the composer with the read-only card when the worktree was deleted', async () => {
    await mountApp();
    expect(q('[data-testid="composer"]')).not.toBeNull();
    await send(state({ phase: 'deleted', canHandOff: false }));
    await frames();
    expect(q('[data-testid="composer"]')).toBeNull();
    const card = q('[data-testid="worktree-deleted"]')!;
    expect(card.textContent).toContain("This chat's worktree was deleted");
    q('[data-testid="worktree-new-chat-in-project"]')!.click();
    expect(posted).toContainEqual({ type: 'worktreeAction', action: 'newChatInProject' });
    expect(q('[data-testid="chat-header-worktree"]')?.dataset.state).toBe('deleted');
    expect(q('[data-testid="chat-header-hand-off"]')).toBeNull();
    // read-only history offers no rewind or fork
    expect(useUIStore().historyReadOnly).toBe(true);
  });
});

// The test bridge is VS Code's; a desktop chat page differs from it only in the host it reports.
function asDesktopPage(): void {
  const bridge = usePlatformBridge() as { host: PlatformBridge['host'] };
  bridge.host = 'desktop';
  onTestFinished(() => {
    bridge.host = 'vscode';
  });
}

describe('a resumed chat\'s composer waits for its place', () => {
  it('never mounts the normal composer for a chat whose worktree was deleted', async () => {
    await mountApp();
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      if (q('[data-testid="composer"]')) seen.push('composer');
    });
    observer.observe(document.body, { childList: true, subtree: true });
    await send({ type: 'resumeAccepted', sessionId: 's1' });
    expect(q('[data-testid="composer-placeholder"]')).not.toBeNull();
    expect(q('[data-testid="composer"]')).toBeNull();
    await send(state({ phase: 'deleted', place: 'worktree', canHandOff: false }));
    await send({ type: 'sessionStarted', sessionId: 's1', stored: true });
    observer.disconnect();
    expect(seen).toEqual([]);
    expect(q('[data-testid="composer-placeholder"]')).toBeNull();
    expect(q('[data-testid="worktree-deleted"]')).not.toBeNull();
  });

  it('holds the composer from the first render of a desktop page restored with a saved session', async () => {
    const api = (globalThis as unknown as { acquireVsCodeApi: () => { getState: () => unknown } }).acquireVsCodeApi();
    vi.spyOn(api, 'getState').mockReturnValue({ sessionId: 's1' });
    asDesktopPage();
    // no host capabilities yet: the first frame must already hold the composer back
    app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
    await nextTick();
    expect(q('[data-testid="composer"]')).toBeNull();
    expect(q('[data-testid="composer-placeholder"]')).not.toBeNull();
    await send({ type: 'hostCapabilities', capabilities: { ...VSCODE_HOST_CAPABILITIES, worktrees: true } });
    expect(q('[data-testid="composer"]')).toBeNull();
    await send(state({ phase: 'deleted', place: 'worktree', canHandOff: false }));
    expect(q('[data-testid="composer"]')).toBeNull();
    expect(q('[data-testid="worktree-deleted"]')).not.toBeNull();
  });

  it('sizes the placeholder to the empty composer it stands in for, so the dock does not jump', async () => {
    await mountApp();
    await wait(0);
    await send({ type: 'resumeAccepted', sessionId: 's1' });
    // FakeResizeObserver reports a 46px block, 2.875rem at the 16px root
    expect(q('[data-testid="composer-placeholder"]')?.style.height).toBe('2.875rem');
  });

  it('sizes a restored page\'s placeholder from the composer height its saved state kept', async () => {
    const api = (globalThis as unknown as { acquireVsCodeApi: () => { getState: () => unknown } }).acquireVsCodeApi();
    vi.spyOn(api, 'getState').mockReturnValue({ sessionId: 's1', composerHeight: 9.5 });
    asDesktopPage();
    app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
    await nextTick();
    expect(q('[data-testid="composer-placeholder"]')?.style.height).toBe('9.5rem');
  });

  it('keeps the empty composer\'s height in the page state for the next restore, and not a draft\'s', async () => {
    const api = (globalThis as unknown as { acquireVsCodeApi: () => { setState: (state: unknown) => void } }).acquireVsCodeApi();
    const saved = vi.spyOn(api, 'setState');
    const wrapper = await mountApp();
    await wait(0);
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ composerHeight: 2.875 }));
    saved.mockClear();
    await wrapper.get('textarea').setValue('a draft\nover lines');
    resizeAll(120);
    expect(saved).not.toHaveBeenCalled();
  });

  it('lets a desktop host without worktrees show the restored composer once it says so', async () => {
    const api = (globalThis as unknown as { acquireVsCodeApi: () => { getState: () => unknown } }).acquireVsCodeApi();
    vi.spyOn(api, 'getState').mockReturnValue({ sessionId: 's1' });
    asDesktopPage();
    app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
    await nextTick();
    expect(q('[data-testid="composer"]')).toBeNull();
    await send({ type: 'hostCapabilities', capabilities: { ...VSCODE_HOST_CAPABILITIES } });
    expect(q('[data-testid="composer"]')).not.toBeNull();
  });

  it('renders a restored VS Code chat\'s composer on its first render', async () => {
    const api = (globalThis as unknown as { acquireVsCodeApi: () => { getState: () => unknown } }).acquireVsCodeApi();
    vi.spyOn(api, 'getState').mockReturnValue({ sessionId: 's1' });
    app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
    await nextTick();
    expect(q('[data-testid="composer"]')).not.toBeNull();
    expect(q('[data-testid="composer-placeholder"]')).toBeNull();
  });

  it('mounts the composer once core says where the chat works, or once its session starts', async () => {
    await mountApp();
    await send({ type: 'resumeAccepted', sessionId: 's1' });
    await send(state({ phase: 'ready', place: 'worktree', branch: 'damocles/fix-login', canHandOff: false }));
    expect(q('[data-testid="composer"]')).not.toBeNull();
    await send({ type: 'resumeAccepted', sessionId: 's2' });
    expect(q('[data-testid="composer"]')).toBeNull();
    await send({ type: 'sessionStarted', sessionId: 's2', stored: true });
    expect(q('[data-testid="composer"]')).not.toBeNull();
  });

  it('mounts the composer and drops a previous chat\'s worktree UI when core says no worktree applies', async () => {
    await mountApp();
    await send(state({ phase: 'ready', place: 'worktree', branch: 'damocles/fix-login' }));
    await send({ type: 'resumeAccepted', sessionId: 's3' });
    expect(q('[data-testid="composer"]')).toBeNull();
    await send({ type: 'noWorktreeState' });
    expect(q('[data-testid="composer"]')).not.toBeNull();
    expect(useUIStore().worktree).toBeNull();
    expect(q('[data-testid="chat-header-worktree"]')).toBeNull();
  });

  it('keeps the composer and its draft through a hand-off, which continues the conversation on screen', async () => {
    const wrapper = await mountApp();
    await wrapper.get('textarea').setValue('half-typed draft');
    await send({ type: 'resumeAccepted', sessionId: 's1', continued: true });
    expect(q('[data-testid="composer-placeholder"]')).toBeNull();
    await send({ type: 'sessionCleared' });
    await send(state({ phase: 'ready', place: 'worktree', branch: 'damocles/fix-login', canHandOff: true }));
    await send({ type: 'sessionStarted', sessionId: 's1', stored: true });
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('half-typed draft');
  });

  it('keeps VS Code\'s composer, where no worktree state ever comes', async () => {
    await mountApp();
    useSettingsStore().hostCapabilities = { ...VSCODE_HOST_CAPABILITIES };
    await send({ type: 'resumeAccepted', sessionId: 's1' });
    expect(q('[data-testid="composer"]')).not.toBeNull();
    expect(q('[data-testid="composer-placeholder"]')).toBeNull();
  });
});

describe('a send core gave back', () => {
  it('lands back in the composer', async () => {
    const wrapper = await mountApp();
    await send({ type: 'promptReturned', content: [{ type: 'text', text: 'second thought' }], reason: 'heldPromptWaiting' });
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('second thought');
  });

  it('waits for a composer that is not mounted yet, then lands in it', async () => {
    const wrapper = await mountApp();
    await send({ type: 'resumeAccepted', sessionId: 's1' });
    await send({ type: 'promptReturned', content: [{ type: 'text', text: 'kept draft' }], reason: 'heldPromptKept' });
    expect(q('[data-testid="composer"]')).toBeNull();
    await send({ type: 'sessionStarted', sessionId: 's1', stored: true });
    await frames();
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('kept draft');
  });
});

describe('Hand off and the header branch chip (D61)', () => {
  it('offers Move to a worktree from the project folder and posts chatMove', async () => {
    await mountApp();
    await send(state({ phase: 'none', place: 'project' }));
    const trigger = q('[data-testid="chat-header-hand-off"]')!;
    expect((trigger as HTMLButtonElement).disabled).toBe(false);
    expect(q('[data-testid="chat-header-hand-off-wrap"]')?.title).toBe('Hand off: move where this chat works');
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await frames();
    const menu = q('[data-testid="hand-off-menu"]')!;
    expect(menu.textContent).toContain('This chat works in');
    expect(q('[data-testid="hand-off-current"]')?.textContent).toContain('Project folder');
    expect(q('[data-testid="hand-off-move"]')?.textContent).toContain('Move to a worktree');
    q('[data-testid="hand-off-move"]')!.click();
    await frames();
    expect(posted).toContainEqual({ type: 'chatMove', to: 'worktree' });
  });

  it('names the worktree and offers the move back; it is disabled with its tooltip while the chat works', async () => {
    await mountApp();
    await send(state({ phase: 'ready', place: 'worktree', branch: 'damocles/fix-login', baseBranch: 'main', behind: 2 }));
    expect(q('[data-testid="chat-header-worktree"]')?.textContent).toContain('damocles/fix-login');
    // the chip shows the slug, which tells worktrees apart; the full branch is its title and accessible text
    expect(q('[data-testid="chat-header-worktree"] span[aria-hidden="true"]')?.textContent).toBe('fix-login');
    expect(q('[data-testid="chat-header-worktree"]')?.getAttribute('title')).toBe('This chat works in its worktree, on damocles/fix-login');
    expect(q('[data-testid="chat-header-worktree-note"]')?.textContent).toBe('2 behind main');
    const trigger = q('[data-testid="chat-header-hand-off"]')!;
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await frames();
    expect(q('[data-testid="hand-off-current"]')?.textContent).toContain('Worktree damocles/fix-login');
    expect(q('[data-testid="hand-off-move"]')?.textContent).toContain('Move to project folder');

    await send(state({ phase: 'ready', place: 'worktree', branch: 'damocles/fix-login', baseBranch: 'main', targetRewritten: true, canHandOff: false }));
    expect(q('[data-testid="chat-header-worktree-note"]')?.textContent).toBe('main was rewritten');
    expect(q('[data-testid="chat-header-hand-off-wrap"]')?.title).toBe('Hand off is available while the chat is idle');
  });

  it('keeps Hand off reachable from the keyboard while the chat works, and its menu says why the move is unavailable', async () => {
    await mountApp();
    await send(state({ phase: 'ready', place: 'worktree', branch: 'damocles/fix-login', canHandOff: false }));
    const trigger = q('[data-testid="chat-header-hand-off"]') as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    expect(trigger.tabIndex).toBe(0);
    expect(trigger.getAttribute('aria-label')).toBe('Hand off, Hand off is available while the chat is idle');
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await frames();
    const move = q('[data-testid="hand-off-move"]')!;
    expect(move.getAttribute('aria-disabled')).toBe('true');
    expect(move.querySelector('[data-testid="hand-off-disabled-reason"]')?.textContent).toBe('Hand off is available while the chat is idle');
    move.click();
    await frames();
    expect(posted.filter((message) => (message as { type?: string }).type === 'chatMove')).toEqual([]);
  });

  it('reads the Hand off strings in Greek', async () => {
    await mountApp();
    i18n.global.locale.value = 'el';
    await send(state({ phase: 'none', canHandOff: false }));
    expect(q('[data-testid="chat-header-hand-off-wrap"]')?.title).toBe('Η μεταφορά είναι διαθέσιμη όσο η συνομιλία είναι αδρανής');
  });
});

describe('the header for a worktree chat', () => {
  it('names the project from the worktree state and offers New chat in this worktree from the chip', async () => {
    await mountApp();
    await send(state({ phase: 'ready', place: 'worktree', branch: 'damocles/fix-login', projectName: 'acme' }));
    expect(q('[data-testid="chat-header-folder"]')?.textContent).toContain('acme');
    const chip = q('[data-testid="chat-header-worktree"]')!;
    chip.focus();
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await frames();
    q('[data-testid="hand-off-new-in-worktree"]')!.click();
    await frames();
    expect(posted).toContainEqual({ type: 'worktreeAction', action: 'newChatInWorktree' });
  });

  it('swaps the live chip for Worktree deleted when the worktree goes', async () => {
    await mountApp();
    await send(state({ phase: 'ready', place: 'worktree', branch: 'damocles/fix-login', projectName: 'acme' }));
    await send(state({ phase: 'deleted', place: 'worktree', canHandOff: false }));
    await frames();
    expect(q('[data-testid="chat-header-worktree"]')?.dataset.state).toBe('deleted');
  });
});

describe('the Blocked card (rule 10)', () => {
  it('shows a Blocked badge in place of the status icon', async () => {
    const wrapper = mount(ToolCardFrame, { props: { icon: Wrench, name: 'Edit', arg: 'C:/w/app/a.ts', status: 'running' }, global: { plugins: [i18n] }, attachTo: document.body });
    mounted.push(wrapper);
    expect(wrapper.find('[data-testid="tool-card-blocked"]').exists()).toBe(false);
    await wrapper.setProps({ status: 'blocked' });
    await frames();
    expect(wrapper.get('[data-testid="tool-card-blocked"]').text()).toBe('Blocked');
    i18n.global.locale.value = 'el';
    await nextTick();
    expect(wrapper.get('[data-testid="tool-card-blocked"]').text()).toBe('Αποκλείστηκε');
  });
});

describe('rewind across a hand-off (D61)', () => {
  it('says a rewind before the hand-off restores the conversation only', async () => {
    const prompts = [
      { messageId: 'u2', content: 'after', timestamp: Date.now(), filesAffected: 1 },
      { messageId: 'u1', content: 'before', timestamp: Date.now(), filesAffected: 1, crossesHandOff: true },
    ];
    const wrapper = mount(RewindBrowser, { props: { prompts }, global: { plugins: [i18n] }, attachTo: document.body });
    mounted.push(wrapper);
    await frames();
    expect(q('[data-testid="rewind-hand-off-note"]')).toBeNull();
    expect(document.body.querySelectorAll('[data-testid="rewind-row-hand-off"]')).toHaveLength(1);
    q('[data-testid="rewind-search"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await frames();
    expect(q('[data-testid="rewind-hand-off-note"]')?.textContent).toContain('Files from before the hand-off are in the other folder. Rewind restores the conversation only.');
    // the turn's own row drops its file count, since no file goes back
    expect(document.body.querySelectorAll('[data-testid="rewind-row-hand-off"]')).toHaveLength(1);
  });

  it('offers only the conversation options when the turn came before a hand-off', async () => {
    const wrapper = mount(RewindConfirmModal, {
      props: { visible: true, canFork: true, kind: 'prompt', messagePreview: 'before', filesAffected: 2, crossesHandOff: true },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await frames();
    const options = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.length).toBeGreaterThan(2);
    expect(options.filter((option) => !option.disabled).length).toBeLessThan(options.length);
    expect(q('[data-testid="rewind-confirm-hand-off-note"]')?.textContent).toContain('Rewind restores the conversation only.');
  });
});
