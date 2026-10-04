// usePlatformBridge selects its host on first use, so the VS Code API must exist before any test runs.
const vscodeStub: VsCodeApi = {
  postMessage: () => {},
  getState: () => undefined,
  setState: () => {},
};

(globalThis as unknown as { acquireVsCodeApi: () => VsCodeApi }).acquireVsCodeApi = () => vscodeStub;
