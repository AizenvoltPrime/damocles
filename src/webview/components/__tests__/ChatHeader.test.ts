// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import ChatHeader from '../chat-header/ChatHeader.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import { i18n } from '@/i18n';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';
import type { WorkspaceFolderInfo } from '@shared/types/workspace-folders';
import type { HeaderAction } from '../chat-header/headerActions';

const APP: WorkspaceFolderInfo = { key: 'c:\\work\\app', name: 'app', label: 'app', path: 'C:\\work\\app', branch: 'main' };
const API: WorkspaceFolderInfo = { key: 'c:\\work\\api', name: 'api', label: 'api', path: 'C:\\work\\api' };
const DESKTOP = { ...VSCODE_HOST_CAPABILITIES, historyInPanel: false, folderPickerInPanel: false, settingsInPanel: false };

let resize: ((width: number) => void) | null = null;

class FakeResizeObserver {
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(): void {
    resize = (width) => this.callback([{ borderBoxSize: [{ inlineSize: width, blockSize: 46 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  disconnect(): void {
    resize = null;
  }
  unobserve(): void {}
}

const mounted: VueWrapper[] = [];

async function mountHeader(width: number): Promise<VueWrapper> {
  const wrapper = mount(ChatHeader, {
    attachTo: document.body,
    global: { plugins: [i18n] },
    slots: { history: '<button data-testid="history-slot">history</button>' },
  });
  mounted.push(wrapper);
  await setWidth(width);
  return wrapper;
}

async function setWidth(width: number): Promise<void> {
  if (!resize) throw new Error('the header observes no element');
  resize(width);
  await nextTick();
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** Reka opens a menu on Enter and portals its content to `document.body`. */
async function openMore(): Promise<string[]> {
  const trigger = byTestId('chat-header-more');
  if (!trigger) throw new Error('no More button');
  trigger.focus();
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();
  return [...document.body.querySelectorAll<HTMLElement>('[data-testid="chat-header-more-menu"] [role="menuitem"]')].map((item) => item.dataset.action ?? '');
}

const ALWAYS = ['rewind', 'sideQuestion', 'context', 'usage', 'stats'];
const ROOMY_FOLD = ['viewPlan', 'bindPlan', 'memory', 'browser', 'mcp', 'tools'];

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('ChatHeader width folding', () => {
  it('shows every control in the header at 720px and wider, leaving only the fixed items in More', async () => {
    await mountHeader(820);

    for (const id of ['navigator', 'consolidation', 'plan', 'memory', 'browser', 'mcp', 'tools']) {
      expect(byTestId(`chat-header-${id}`), id).not.toBeNull();
    }
    expect(await openMore()).toEqual(ALWAYS);
  });

  it('folds Memory consolidation into More between 560 and 719px', async () => {
    await mountHeader(640);

    expect(byTestId('chat-header-consolidation')).toBeNull();
    expect(byTestId('chat-header-plan')).not.toBeNull();
    expect(byTestId('chat-header-mcp')).not.toBeNull();
    expect(await openMore()).toEqual(['consolidation', ...ALWAYS]);
  });

  it('folds the plan, memory, browser, MCP and tools controls into More below 560px', async () => {
    await mountHeader(480);

    for (const id of ['consolidation', 'plan', 'memory', 'browser', 'mcp', 'tools']) {
      expect(byTestId(`chat-header-${id}`), id).toBeNull();
    }
    expect(byTestId('chat-header-navigator')).not.toBeNull();
    expect(await openMore()).toEqual(['consolidation', ...ROOMY_FOLD, ...ALWAYS]);
  });

  it('folds the desktop terminal toggle into More below 560px, so a narrow panel never scrolls sideways', async () => {
    useSettingsStore().setHostCapabilities({ ...DESKTOP, windowLayout: true });
    const wrapper = await mountHeader(820);
    expect(byTestId('chat-header-terminal')).not.toBeNull();

    await setWidth(480);
    expect(byTestId('chat-header-terminal')).toBeNull();
    expect(await openMore()).toEqual(['consolidation', ...ROOMY_FOLD, 'terminal', ...ALWAYS]);
    document.body.querySelector<HTMLElement>('[data-action="terminal"]')!.click();
    await flush();
    expect(wrapper.emitted('action')).toEqual([['terminal' satisfies HeaderAction]]);
  });

  it('follows the panel as it is resized', async () => {
    await mountHeader(480);
    expect(byTestId('chat-header-tools')).toBeNull();

    await setWidth(900);

    expect(byTestId('chat-header-tools')).not.toBeNull();
    expect(byTestId('chat-header')?.dataset.width).toBe('wide');
  });

  it('runs the folded item the user picks', async () => {
    const wrapper = await mountHeader(480);
    await openMore();

    document.body.querySelector<HTMLElement>('[data-action="memory"]')!.click();
    await flush();

    expect(wrapper.emitted('action')).toEqual([['memory' satisfies HeaderAction]]);
  });

  it('keeps MCP and Tools closed while a turn runs, in the header and in More', async () => {
    useUIStore().setProcessing(true);
    await mountHeader(820);
    expect((byTestId('chat-header-mcp') as HTMLButtonElement).disabled).toBe(true);
    expect((byTestId('chat-header-tools') as HTMLButtonElement).disabled).toBe(true);

    await setWidth(480);
    await openMore();
    expect(document.body.querySelector('[data-action="mcp"]')?.hasAttribute('data-disabled')).toBe(true);
  });

  it('names every icon button', async () => {
    await mountHeader(820);

    const unnamed = [...document.body.querySelectorAll<HTMLElement>('[data-testid="chat-header"] button')].filter(
      (button) => !button.getAttribute('aria-label') && !button.textContent?.trim(),
    );
    expect(unnamed).toEqual([]);
  });
});

describe('ChatHeader per host', () => {
  it('offers session history and the gear in VS Code', async () => {
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES });
    const wrapper = await mountHeader(820);

    expect(byTestId('history-slot')).not.toBeNull();
    byTestId('chat-settings-button')!.click();
    expect(wrapper.emitted('action')).toEqual([['settings']]);
  });

  it('leaves the gear to the desktop title bar', async () => {
    useSettingsStore().setHostCapabilities(DESKTOP);
    await mountHeader(820);

    expect(byTestId('chat-settings-button')).toBeNull();
  });
});

describe('ChatHeader folder and branch', () => {
  it('shows the panel folder branch in mono, left to right', async () => {
    useSettingsStore().setWorkspaceFolders([APP], APP.key, APP.key);
    await mountHeader(820);

    const branch = byTestId('chat-header-branch');
    expect(branch?.textContent?.trim()).toBe('main');
    expect(branch?.getAttribute('dir')).toBe('ltr');
    expect(branch?.className).toContain('font-mono');
    expect(byTestId('chat-header-folder')?.textContent?.trim()).toBe('app');
  });

  it('hides the branch for a folder outside git', async () => {
    useSettingsStore().setWorkspaceFolders([API], API.key, API.key);
    await mountHeader(820);

    expect(byTestId('chat-header-folder')?.textContent?.trim()).toBe('api');
    expect(byTestId('chat-header-branch')).toBeNull();
  });

  it('follows a checkout without a reload', async () => {
    const settings = useSettingsStore();
    settings.setWorkspaceFolders([APP], APP.key, APP.key);
    await mountHeader(820);

    settings.setWorkspaceFolders([{ ...APP, branch: 'feature/x' }], APP.key, APP.key);
    await nextTick();

    expect(byTestId('chat-header-branch')?.textContent?.trim()).toBe('feature/x');
  });

  it('makes the folder a picker with two folders in VS Code, at every width', async () => {
    useSettingsStore().setWorkspaceFolders([APP, API], APP.key, APP.key);
    await mountHeader(480);

    expect(byTestId('workspace-folder-chip')?.getAttribute('aria-haspopup')).toBe('menu');
    expect(byTestId('chat-header-folder')).toBeNull();
  });

  it('keeps the folder plain text on desktop with two projects open', async () => {
    const settings = useSettingsStore();
    settings.setHostCapabilities(DESKTOP);
    settings.setWorkspaceFolders([APP, API], APP.key, APP.key);
    await mountHeader(820);

    expect(byTestId('workspace-folder-chip')).toBeNull();
    expect(byTestId('chat-header-folder')?.textContent?.trim()).toBe('app');
  });
});
