import type { PlatformBridge } from '@/composables/usePlatformBridge';
import type { ShellPlatform } from '../../preload/shell-channels';
import type { TitleBarApi } from '../components/title-bar-api';

// The theme render page has no preload, no bridge and no input: it draws once and is captured. Its stubs reach nothing.

/**
 * The sample transcript's platform bridge: nothing arrives, the view's own state lives in memory, and sending throws, since only
 * a click sends a message; the running job fails on that throw wherever it surfaces (settle.ts).
 */
export function createRenderBridge(): PlatformBridge {
  let state: unknown;
  return {
    host: 'desktop',
    postMessage(message) {
      throw new Error(`The theme render page sends no messages, and a sample component sent ${message.type}`);
    },
    onMessage: () => () => undefined,
    getState<T>() {
      return state as T | undefined;
    },
    setState<T>(next: T) {
      state = next;
    },
  };
}

const NO_WINDOW = (): Promise<never> => Promise.reject(new Error('The theme render page has no window to act on'));

/**
 * The sample title bar's api on `platform`, the appearance's: no update to show and no subscription to hold; every action,
 * which only a click starts, rejects.
 */
export const inertTitleBarApi = (platform: ShellPlatform): TitleBarApi => ({
  getUpdate: () => Promise.resolve({ state: { kind: 'disabled' }, lastCheckedAt: null, platform }),
  onUpdate: () => () => undefined,
  openAppMenu: NO_WINDOW,
  showHostCard: NO_WINDOW,
  requestOverlay: NO_WINDOW,
  openQuickOpen: NO_WINDOW,
  toggleSidebar: NO_WINDOW,
  toggleTerminal: NO_WINDOW,
  toggleEditor: NO_WINDOW,
  toggleTheme: NO_WINDOW,
  openSettings: NO_WINDOW,
  restartEngine: NO_WINDOW,
  runUpdateAction: NO_WINDOW,
  windowControl: NO_WINDOW,
});
