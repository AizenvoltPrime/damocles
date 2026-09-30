/** `window.damoclesBridge`, exposed by the desktop panel preload through contextBridge; payloads are untyped at that boundary. */
export interface DamoclesBridge {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): () => void;
  getState(): unknown;
  setState(state: unknown): void;
}
