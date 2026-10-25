/** `window.damoclesBridge`, exposed by the desktop panel preload through contextBridge; payloads are untyped at that boundary. */
export interface DamoclesBridge {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): () => void;
  getState(): unknown;
  setState(state: unknown): void;
  // a remote chat's host as this computer names it, from main's init; undefined for a local chat, and while main has not
  // answered the init yet, after which onHost hears it
  getHost(): { readonly hostId: string; readonly name: string; readonly color?: string } | undefined;
  onHost(listener: (host: { readonly hostId: string; readonly name: string; readonly color?: string }) => void): () => void;
}
