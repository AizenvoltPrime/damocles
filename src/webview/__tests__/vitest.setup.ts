// usePlatformBridge selects its host at import time, so the VS Code API must exist before any module loads.
const vscodeStub: VsCodeApi = {
  postMessage: () => {},
  getState: () => undefined,
  setState: () => {},
};

(globalThis as unknown as { acquireVsCodeApi: () => VsCodeApi }).acquireVsCodeApi = () => vscodeStub;
