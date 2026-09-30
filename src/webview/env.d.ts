/// <reference types="vite/client" />

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

// Defined only inside a VS Code webview; the desktop host exposes window.damoclesBridge instead.
declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;

interface Window {
  damoclesBridge?: import('@shared/damocles-bridge').DamoclesBridge;
}
