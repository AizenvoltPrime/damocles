import { vi } from 'vitest';
import { loadLocale } from '@/i18n';
import { loadShellLocale } from '../../desktop/shell/i18n';

// usePlatformBridge selects its host on first use, so the VS Code API must exist before any test runs.
const vscodeStub: VsCodeApi = {
  postMessage: () => {},
  getState: () => undefined,
  setState: () => {},
};

// A card just shown answers at once here; a test of that hold calls vi.unmock on this module.
vi.mock('@/composables/trusted-hold', () => ({
  SHOWN_HOLD_MS: 0,
  afterShownHold: (done: () => void): (() => void) => {
    done();
    return () => {};
  },
}));

(globalThis as unknown as { acquireVsCodeApi: () => VsCodeApi }).acquireVsCodeApi = () => vscodeStub;

// The Greek catalogs (the webview's and the shell's) load once, so a test that switches to Greek renders it at once, as a view
// does after its first load.
await loadLocale('el');
await loadShellLocale('el');
