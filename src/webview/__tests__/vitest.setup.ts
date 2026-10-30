import { loadLocale } from '@/i18n';

// usePlatformBridge selects its host on first use, so the VS Code API must exist before any test runs.
const vscodeStub: VsCodeApi = {
  postMessage: () => {},
  getState: () => undefined,
  setState: () => {},
};

(globalThis as unknown as { acquireVsCodeApi: () => VsCodeApi }).acquireVsCodeApi = () => vscodeStub;

// The Greek catalogs load once, so a test that switches to Greek renders it at once, as a view does after its first load.
await loadLocale('el');
