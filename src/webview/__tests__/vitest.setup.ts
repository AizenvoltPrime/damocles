/**
 * Webview test setup. Stubs the VS Code webview host API so that modules which
 * eagerly call `acquireVsCodeApi()` at import time (e.g. useVSCode.ts) don't
 * crash before any test runs.
 */
const vscodeStub = {
  postMessage: () => {},
  getState: () => undefined,
  setState: () => {},
};

(globalThis as unknown as { acquireVsCodeApi: () => typeof vscodeStub }).acquireVsCodeApi = () => vscodeStub;
