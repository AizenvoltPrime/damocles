import type { Rectangle } from 'electron';
import { isNavigableUrl } from '../../core/browser/net-guard';
import { MAX_BROWSER_URL_LENGTH, typedAddress } from '../../shared/typed-address';
import type { BrowserAction, ShellEditorTab } from '../preload/shell-channels';
import type { PersistedPages } from './panel-state-store';
import { isHttpUrl } from './security';
import type { DesktopPanel, PagesHost } from './views';

/**
 * Whether the address bar's text is one core will open: bounded, and a navigable URL as Chrome reads a typed address
 * (`typedAddress`). Core reads the text again with the same rule.
 */
export function isTypedAddress(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const address = typedAddress(raw);
  return address !== undefined && isNavigableUrl(address.url);
}

// The editor pane as the browser tabs drive it; every call leaves keyboard focus where it is, except focusTab.
export interface BrowserTabsEditor {
  activeTabId(): string | null;
  // activates a page tab and shows the editor pane when it is hidden
  activateBrowserTab(tabId: string): void;
  // the active tab was a page tab that is gone or hidden now: a file tab takes its place
  leaveBrowserTab(): void;
  // the tab list changed; republished to the shell
  browserTabsChanged(): void;
  // a user's action opened tabId: the shell focuses it
  focusTab(tabId: string): void;
}

export interface BrowserTabsDeps {
  readonly editor: BrowserTabsEditor;
  readonly window: { isDestroyed(): boolean; getContentBounds(): Rectangle };
  readonly setPages: (chatPanelId: string, pages: PersistedPages) => void;
  // a host teardown closes every page and leaves the saved pages as they were
  readonly retainingStates: () => boolean;
  readonly browserEnabled: () => boolean;
  // a blank page in the chat's human scope (core refuses it while the browser is off)
  readonly newPage: (chat: DesktopPanel) => Promise<void>;
  // ShellService.openExternal, which opens only canonical http and https
  readonly openExternal: (url: string) => Promise<boolean>;
  // Open in system browser was refused or failed: one toast tells the user
  readonly openExternalFailed: () => void;
  readonly copy: (text: string) => Promise<void>;
  // a page view that held keyboard focus closed or hid; a hidden view keeps focus, so the owner moves it
  readonly focusAway: () => void;
}

// One chat's pages in tab order.
interface ChatPages {
  readonly pages: DesktopPanel[];
  // the page its tabs show first, and the one panels.json marks
  activePage: DesktopPanel | undefined;
  // a page tab was the active editor tab when the chat was last left, or core revealed one since: selecting the chat activates it
  shown: boolean;
  // restored pages arrive while this is set and leave the active editor tab alone
  restoring: boolean;
  // JSON of the pages last handed to setPages; a change that leaves them as they are writes nothing
  persisted: string | undefined;
}

/**
 * The selected chat's browser pages as editor tabs (D14): main's page views, placed on the page area the shell reports while
 * a page tab is the active editor tab. Switching chats swaps the pages, and each chat returns to the page it showed. No page
 * view takes keyboard focus from here.
 */
export class BrowserTabs implements PagesHost {
  private readonly deps: BrowserTabsDeps;
  private readonly chats = new Map<DesktopPanel, ChatPages>();
  private selected: DesktopPanel | undefined;
  // DIP rectangle of the active browser tab's page area; undefined while the shell shows none
  private bounds: Rectangle | undefined;
  // DIP corner radius of the card the page area sits in
  private radius = 0;

  constructor(deps: BrowserTabsDeps) {
    this.deps = deps;
  }

  /** The selected chat's pages as tabs, in order; none while the browser is off. */
  tabs(): ShellEditorTab[] {
    const entry = this.selected && this.deps.browserEnabled() ? this.chats.get(this.selected) : undefined;
    return (entry?.pages ?? []).map((page) => {
      const observed = page.page!;
      const url = observed.url.slice(0, MAX_BROWSER_URL_LENGTH);
      return {
        id: page.panelId,
        kind: 'browser',
        title: page.title,
        displayPath: url,
        dirty: false,
        readOnly: false,
        conflict: false,
        browser: {
          url,
          loading: observed.loading,
          canGoBack: observed.canGoBack,
          canGoForward: observed.canGoForward,
          picking: observed.picking,
          ...(page.iconDataUrl !== undefined ? { iconDataUrl: page.iconDataUrl } : {}),
        },
      };
    });
  }

  /** The active editor tab's page, while it is one of the selected chat's and the browser is on. */
  activePage(): DesktopPanel | undefined {
    return this.visiblePage(this.deps.editor.activeTabId());
  }

  focused(): boolean {
    return this.activePage()?.webContents.isFocused() ?? false;
  }

  // A chat holding pages, or with saved pages on their way back, stays loaded.
  holdsPages(chat: DesktopPanel): boolean {
    const entry = this.chats.get(chat);
    return entry !== undefined && (entry.pages.length > 0 || entry.restoring);
  }

  setRestoring(chat: DesktopPanel, restoring: boolean): void {
    const entry = restoring ? this.entryOf(chat) : this.chats.get(chat);
    if (entry) entry.restoring = restoring;
  }

  setBounds(bounds: Rectangle | undefined, radius = 0): void {
    this.bounds = bounds;
    this.radius = radius;
    this.layout();
  }

  // The active tab changed: a page tab becomes its chat's active page and the one page view shown.
  activeChanged(tabId: string | null): void {
    const page = this.visiblePage(tabId);
    if (page) {
      const chat = page.chat!;
      this.chats.get(chat)!.activePage = page;
      this.persist(chat);
    }
    this.layout();
  }

  close(tabId: string): void {
    this.pageOf(tabId).close();
  }

  // The browser feature was turned on or off: every page tab hides or shows with it.
  enabledChanged(): void {
    const active = this.deps.editor.activeTabId();
    const entry = this.selected ? this.chats.get(this.selected) : undefined;
    this.deps.editor.browserTabsChanged();
    if (!this.deps.browserEnabled() && entry?.pages.some((page) => page.panelId === active)) this.deps.editor.leaveBrowserTab();
    this.layout();
  }

  async action(tabId: string, action: BrowserAction): Promise<void> {
    const page = this.pageOf(tabId);
    const url = page.page!.url;
    switch (action) {
      case 'back':
        page.deliver({ type: 'goBack' });
        return;
      case 'forward':
        page.deliver({ type: 'goForward' });
        return;
      case 'reload':
        page.deliver({ type: 'reload' });
        return;
      case 'pickElement':
        page.deliver({ type: 'pickElement' });
        return;
      case 'devTools':
        page.deliver({ type: 'openDevTools' });
        return;
      case 'openExternal':
        if (!isHttpUrl(url) || !(await this.deps.openExternal(url))) this.deps.openExternalFailed();
        return;
      case 'copyUrl':
        if (url !== '') await this.deps.copy(url);
        return;
    }
  }

  /** Navigates the page to the typed address; false, and nothing navigates, when isNavigableUrl refuses it. */
  navigate(tabId: string, raw: unknown): boolean {
    const page = this.pageOf(tabId);
    if (!isTypedAddress(raw)) return false;
    page.deliver({ type: 'navigate', url: raw.trim() });
    return true;
  }

  // New Browser Page, a user's command: the blank page's tab takes focus, so its address field is ready.
  async newPage(): Promise<void> {
    const chat = this.selected;
    if (!chat || !this.deps.browserEnabled()) return;
    await this.deps.newPage(chat);
    const page = this.activePage();
    if (page && this.selected === chat) this.deps.editor.focusTab(page.panelId);
  }

  pageAdded(page: DesktopPanel): void {
    const chat = page.chat!;
    const entry = this.entryOf(chat);
    entry.pages.push(page);
    if (!entry.restoring || entry.activePage === undefined) entry.activePage = page;
    if (!entry.restoring) entry.shown = true;
    this.persist(chat);
    if (chat === this.selected) {
      this.deps.editor.browserTabsChanged();
      if (!entry.restoring && this.deps.browserEnabled()) this.deps.editor.activateBrowserTab(page.panelId);
    }
    this.layout();
  }

  pageRemoved(page: DesktopPanel): void {
    const chat = page.chat!;
    // undefined while the chat itself closes
    const entry = this.chats.get(chat);
    const index = entry ? entry.pages.indexOf(page) : -1;
    if (!entry || index < 0) return;
    const hadFocus = page.webContents.isFocused();
    const wasActive = chat === this.selected && this.deps.editor.activeTabId() === page.panelId;
    entry.pages.splice(index, 1);
    if (entry.activePage === page) entry.activePage = entry.pages[Math.min(index, entry.pages.length - 1)];
    if (entry.pages.length === 0) entry.shown = false;
    this.persist(chat);
    if (chat === this.selected) {
      this.deps.editor.browserTabsChanged();
      if (wasActive && entry.activePage) this.deps.editor.activateBrowserTab(entry.activePage.panelId);
      else if (wasActive) this.deps.editor.leaveBrowserTab();
    }
    this.layout();
    if (hadFocus) this.deps.focusAway();
  }

  pageChanged(page: DesktopPanel): void {
    const chat = page.chat!;
    if (!this.chats.has(chat)) return;
    this.persist(chat);
    if (chat === this.selected) this.deps.editor.browserTabsChanged();
  }

  // Core revealed a page: its tab is the chat's active one, activated now when the chat is selected; a restore leaves it at that.
  pageRevealed(page: DesktopPanel): void {
    const chat = page.chat!;
    const entry = this.chats.get(chat);
    if (!entry?.pages.includes(page)) return;
    entry.activePage = page;
    this.persist(chat);
    if (entry.restoring) return;
    entry.shown = true;
    if (chat === this.selected && this.deps.browserEnabled()) this.deps.editor.activateBrowserTab(page.panelId);
  }

  // The swap (D14): the chat left keeps whether a page tab was active, and the chat selected shows its page again.
  chatSelected(chat: DesktopPanel | undefined): void {
    const previous = this.selected;
    if (previous === chat) return;
    const active = this.deps.editor.activeTabId();
    const left = previous ? this.chats.get(previous) : undefined;
    const leftShowing = left?.pages.some((page) => page.panelId === active) ?? false;
    if (left) left.shown = leftShowing;
    this.selected = chat;
    const entry = chat ? this.chats.get(chat) : undefined;
    this.deps.editor.browserTabsChanged();
    if (entry?.shown && entry.activePage && this.deps.browserEnabled()) this.deps.editor.activateBrowserTab(entry.activePage.panelId);
    else if (leftShowing) this.deps.editor.leaveBrowserTab();
    this.layout();
  }

  // A page never outlives its chat.
  chatClosed(chat: DesktopPanel): void {
    if (chat === this.selected) this.chatSelected(undefined);
    const entry = this.chats.get(chat);
    this.chats.delete(chat);
    if (!entry) return;
    const hadFocus = entry.pages.some((page) => page.webContents.isFocused());
    for (const page of [...entry.pages]) page.close();
    if (hadFocus) this.deps.focusAway();
  }

  private entryOf(chat: DesktopPanel): ChatPages {
    let entry = this.chats.get(chat);
    if (!entry) {
      entry = { pages: [], activePage: undefined, shown: false, restoring: false, persisted: undefined };
      this.chats.set(chat, entry);
    }
    return entry;
  }

  private visiblePage(tabId: string | null): DesktopPanel | undefined {
    if (tabId === null || !this.selected || !this.deps.browserEnabled()) return undefined;
    return this.chats.get(this.selected)?.pages.find((page) => page.panelId === tabId);
  }

  // A tab id from the shell names one of the selected chat's pages, or nothing.
  private pageOf(tabId: string): DesktopPanel {
    const page = this.visiblePage(tabId);
    if (!page) throw new Error('Unknown page');
    return page;
  }

  private persist(chat: DesktopPanel): void {
    const entry = this.chats.get(chat);
    if (!entry || this.deps.retainingStates()) return;
    const active = entry.activePage ? entry.pages.indexOf(entry.activePage) : -1;
    const pages: PersistedPages = { pages: entry.pages.map((page) => page.page!.url), ...(active >= 0 ? { activePage: active } : {}) };
    const persisted = JSON.stringify(pages);
    if (persisted === entry.persisted) return;
    entry.persisted = persisted;
    this.deps.setPages(chat.panelId, pages);
  }

  // The shell's report can lag a resize by a frame, so a page view never extends past the window.
  private area(): Rectangle | undefined {
    const reported = this.bounds;
    if (!reported || this.deps.window.isDestroyed()) return undefined;
    const { width, height } = this.deps.window.getContentBounds();
    const x = Math.min(reported.x, width);
    const y = Math.min(reported.y, height);
    const area = { x, y, width: Math.min(reported.width, width - x), height: Math.min(reported.height, height - y) };
    return area.width > 0 && area.height > 0 ? area : undefined;
  }

  // Only the active page tab's view shows, and only over the page area the shell reports.
  private layout(): void {
    const area = this.area();
    const shown = area ? this.activePage() : undefined;
    let lostFocus = false;
    for (const entry of this.chats.values()) {
      for (const page of entry.pages) {
        const visible = page === shown;
        if (visible) {
          page.view.setBounds(area!);
          page.view.setBorderRadius(this.radius);
        }
        if (page.view.getVisible() === visible) continue;
        lostFocus ||= !visible && page.webContents.isFocused();
        page.view.setVisible(visible);
        page.fireViewState();
      }
    }
    if (lostFocus) this.deps.focusAway();
  }
}
