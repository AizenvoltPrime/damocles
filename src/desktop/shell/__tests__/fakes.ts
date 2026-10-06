import { vi } from 'vitest';
import type { DamoclesShellApi, ShellChat, ShellChatList, ShellFocusPart, ShellState } from '../../preload/shell-channels';
import type { DamoclesOverlayApi, OverlayAnswer, OverlayPrefs, OverlayRasterRequest, OverlayRequest, OverlayState, OverlayToast } from '../../preload/overlay-channels';
import type { ChimeTone, NotificationCenterState } from '../../preload/notifications';
import type { SettingsTarget } from '../../../shared/settings-sections';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';

export const STATE: ShellState = {
  locale: 'en',
  platform: 'win32',
  projects: [
    { key: 'p1', name: 'alpha', fsPath: '/w/alpha', trusted: true, running: 1, waiting: 0 },
    { key: 'p2', name: 'beta', fsPath: '/w/beta', trusted: false, running: 2, waiting: 1, branch: 'main' },
  ],
  selected: { projectKey: 'p1', chatId: 'c1' },
  selectedChat: { id: 'c1', title: 'Fix login' },
  effectiveTheme: 'dark',
  layout: {
    sidebarVisible: true,
    sidebarWidth: 300,
    sections: { projects: { collapsed: false, size: 150 }, chats: { collapsed: false } },
  },
  paneShortcutLabel: 'Ctrl+Shift+B',
  shortcuts: { newChat: 'Ctrl+N', toggleSidebar: 'Ctrl+B', settings: 'Ctrl+,' },
  notifications: { unseen: 0, doNotDisturb: false, popupsOff: false, attention: 0 },
};

export function chat(overrides: Partial<ShellChat> & { id: string }): ShellChat {
  return { title: overrides.id, timestamp: Date.now(), status: 'idle', loaded: false, ...overrides };
}

export type FakeShellApi = DamoclesShellApi & {
  push: (state: ShellState) => void;
  chatsChanged: (projectKey: string) => void;
  focusPart: (part: ShellFocusPart) => void;
  // answers the next requestOverlay call; unanswered requests resolve dismissed
  answerNext: (answer: OverlayAnswer) => void;
  overlayRequests: OverlayRequest[];
};

export function fakeShellApi(chats: readonly ShellChat[] = [], overrides: Partial<DamoclesShellApi> = {}): FakeShellApi {
  const stateListeners = new Set<(s: ShellState) => void>();
  const changedListeners = new Set<(key: string) => void>();
  const focusListeners = new Set<(part: ShellFocusPart) => void>();
  const answers: OverlayAnswer[] = [];
  const overlayRequests: OverlayRequest[] = [];
  const list = (projectKey: string): ShellChatList => ({
    projectKey,
    chats,
    tags: [...new Set(chats.flatMap((c) => (c.tag ? [c.tag] : [])))].sort(),
  });
  return {
    getState: vi.fn(async () => STATE),
    onState: vi.fn((listener) => { stateListeners.add(listener); return () => stateListeners.delete(listener); }),
    addProject: vi.fn(async () => {}),
    removeProject: vi.fn(async () => ({ ok: true as const })),
    selectProject: vi.fn(async () => {}),
    grantTrust: vi.fn(async () => {}),
    togglePane: vi.fn(async () => {}),
    listChats: vi.fn(async (projectKey: string) => list(projectKey)),
    searchChats: vi.fn(async (projectKey: string, query: string) => ({ ...list(projectKey), chats: chats.filter((c) => c.title.includes(query)) })),
    onChatsChanged: vi.fn((listener) => { changedListeners.add(listener); return () => changedListeners.delete(listener); }),
    selectChat: vi.fn(async () => ({ ok: true as const })),
    newChat: vi.fn(async () => {}),
    renameChat: vi.fn(async () => ({ ok: true as const })),
    tagChat: vi.fn(async () => ({ ok: true as const })),
    deleteChat: vi.fn(async () => ({ ok: true as const })),
    requestOverlay: vi.fn(async (request: OverlayRequest) => {
      overlayRequests.push(request);
      return answers.shift() ?? { kind: 'dismissed' as const };
    }),
    openAppMenu: vi.fn(async () => {}),
    toggleTheme: vi.fn(async () => {}),
    openSettings: vi.fn(async () => {}),
    toggleSidebar: vi.fn(async () => {}),
    reportContentBounds: vi.fn(),
    reportLayout: vi.fn(),
    reportFocusedPart: vi.fn(),
    onFocusPart: vi.fn((listener) => { focusListeners.add(listener); return () => focusListeners.delete(listener); }),
    push: (state) => { for (const l of stateListeners) l(state); },
    chatsChanged: (key) => { for (const l of changedListeners) l(key); },
    focusPart: (part) => { for (const l of focusListeners) l(part); },
    answerNext: (answer) => { answers.push(answer); },
    overlayRequests,
    ...overrides,
  };
}

export type FakeOverlayApi = DamoclesOverlayApi & {
  request: (id: string, request: OverlayRequest) => void;
  cancel: (id: string) => void;
  toast: (toast: OverlayToast) => void;
  dismissToast: (id: string) => void;
  // main's F6 toast stop
  focusToasts: () => void;
  pushState: (state: OverlayState) => void;
  // main's side of the settings attachment
  settingsMessage: (message: ExtensionToWebviewMessage) => void;
  settingsAttached: (generation: number) => void;
  settingsTarget: (target: SettingsTarget) => void;
  prefsChanged: (prefs: OverlayPrefs) => void;
  // main's center: what getNotifications answers, and a push while the center is open
  center: { state: NotificationCenterState };
  pushNotifications: (state: NotificationCenterState) => void;
  // main's rasterize request
  rasterizeRequest: (request: OverlayRasterRequest) => void;
  // main's chime for a popup
  chime: (tone: ChimeTone) => void;
};

export function fakeOverlayApi(): FakeOverlayApi {
  const requestListeners = new Set<(id: string, request: OverlayRequest) => void>();
  const cancelListeners = new Set<(id: string) => void>();
  const toastListeners = new Set<(toast: OverlayToast) => void>();
  const dismissListeners = new Set<(id: string) => void>();
  const toastsFocusListeners = new Set<() => void>();
  const stateListeners = new Set<(state: OverlayState) => void>();
  const settingsListeners = new Set<(message: ExtensionToWebviewMessage) => void>();
  const attachedListeners = new Set<(attached: { generation: number }) => void>();
  const targetListeners = new Set<(target: SettingsTarget) => void>();
  const prefsListeners = new Set<(prefs: OverlayPrefs) => void>();
  const notificationListeners = new Set<(state: NotificationCenterState) => void>();
  const rasterizeListeners = new Set<(request: OverlayRasterRequest) => void>();
  const chimeListeners = new Set<(tone: ChimeTone) => void>();
  const center: { state: NotificationCenterState } = { state: { entries: [], doNotDisturb: false, popupsOff: false } };
  return {
    getState: vi.fn(async () => ({ locale: 'en' as const, platform: 'win32' as const })),
    onState: vi.fn((listener) => { stateListeners.add(listener); return () => stateListeners.delete(listener); }),
    onRequest: vi.fn((listener) => { requestListeners.add(listener); return () => requestListeners.delete(listener); }),
    onCancel: vi.fn((listener) => { cancelListeners.add(listener); return () => cancelListeners.delete(listener); }),
    ack: vi.fn(),
    answer: vi.fn(),
    onToast: vi.fn((listener) => { toastListeners.add(listener); return () => toastListeners.delete(listener); }),
    onToastDismiss: vi.fn((listener) => { dismissListeners.add(listener); return () => dismissListeners.delete(listener); }),
    resolveToast: vi.fn(),
    reportToastArea: vi.fn(),
    reportToastPointer: vi.fn(),
    onToastsFocus: vi.fn((listener) => { toastsFocusListeners.add(listener); return () => toastsFocusListeners.delete(listener); }),
    leaveToasts: vi.fn(),
    holdToast: vi.fn(),
    getNotifications: vi.fn(async () => center.state),
    onNotifications: vi.fn((listener) => { notificationListeners.add(listener); return () => notificationListeners.delete(listener); }),
    clearNotifications: vi.fn(async () => {}),
    setDoNotDisturb: vi.fn(async () => {}),
    onRasterize: vi.fn((listener) => { rasterizeListeners.add(listener); return () => rasterizeListeners.delete(listener); }),
    rasterized: vi.fn(),
    onChime: vi.fn((listener) => { chimeListeners.add(listener); return () => chimeListeners.delete(listener); }),
    settingsSend: vi.fn(),
    onSettingsMessage: vi.fn((listener) => { settingsListeners.add(listener); return () => settingsListeners.delete(listener); }),
    onSettingsAttached: vi.fn((listener) => { attachedListeners.add(listener); return () => attachedListeners.delete(listener); }),
    onSettingsTarget: vi.fn((listener) => { targetListeners.add(listener); return () => targetListeners.delete(listener); }),
    getPrefs: vi.fn(async (): Promise<OverlayPrefs> => ({ values: { 'damocles.desktop.theme': 'system', 'damocles.desktop.language': 'system' }, languageAtLaunch: 'system' })),
    onPrefsChanged: vi.fn((listener) => { prefsListeners.add(listener); return () => prefsListeners.delete(listener); }),
    setPref: vi.fn(async () => ({ ok: true as const, file: '/home/u/.damocles/settings.json' })),
    relaunch: vi.fn(async () => {}),
    resetLayout: vi.fn(async () => {}),
    request: (id, request) => { for (const l of requestListeners) l(id, request); },
    cancel: (id) => { for (const l of cancelListeners) l(id); },
    toast: (toast) => { for (const l of toastListeners) l(toast); },
    dismissToast: (id) => { for (const l of dismissListeners) l(id); },
    focusToasts: () => { for (const l of toastsFocusListeners) l(); },
    pushState: (state) => { for (const l of stateListeners) l(state); },
    settingsMessage: (message) => { for (const l of settingsListeners) l(message); },
    settingsAttached: (generation) => { for (const l of attachedListeners) l({ generation }); },
    settingsTarget: (target) => { for (const l of targetListeners) l(target); },
    prefsChanged: (prefs) => { for (const l of prefsListeners) l(prefs); },
    center,
    pushNotifications: (state) => { center.state = state; for (const l of notificationListeners) l(state); },
    rasterizeRequest: (request) => { for (const l of rasterizeListeners) l(request); },
    chime: (tone) => { for (const l of chimeListeners) l(tone); },
  };
}

export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(element: Element): void {
    this.observed.push(element);
  }
  unobserve(): void {}
  disconnect(): void {
    this.observed = [];
  }
}
