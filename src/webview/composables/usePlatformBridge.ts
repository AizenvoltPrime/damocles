import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from '@shared/types/messages';
import type { DamoclesBridge } from '@shared/damocles-bridge';

export interface PlatformBridge {
  postMessage(message: WebviewToExtensionMessage): void;
  onMessage(handler: (message: ExtensionToWebviewMessage) => void): () => void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

function vscodeBridge(api: VsCodeApi): PlatformBridge {
  return {
    postMessage: (message) => api.postMessage(message),
    onMessage: (handler) => {
      const wrappedHandler = (event: MessageEvent) => {
        handler(event.data as ExtensionToWebviewMessage);
      };
      window.addEventListener('message', wrappedHandler);
      return () => window.removeEventListener('message', wrappedHandler);
    },
    getState: <T>() => api.getState() as T | undefined,
    setState: (state) => api.setState(state),
  };
}

function desktopBridge(bridge: DamoclesBridge): PlatformBridge {
  return {
    postMessage: (message) => bridge.postMessage(message),
    onMessage: (handler) => bridge.onMessage((message) => handler(message as ExtensionToWebviewMessage)),
    getState: <T>() => bridge.getState() as T | undefined,
    setState: (state) => bridge.setState(state),
  };
}

function selectBridge(): PlatformBridge {
  // acquireVsCodeApi may be called only once per webview, so selection runs once, on first use.
  if (typeof acquireVsCodeApi === 'function') return vscodeBridge(acquireVsCodeApi());
  const bridge = window.damoclesBridge;
  if (!bridge) throw new Error('No host bridge: neither acquireVsCodeApi nor window.damoclesBridge is defined');
  return desktopBridge(bridge);
}

let bridge: PlatformBridge | null = null;

/** A page with neither host bridge (the desktop overlay) installs its own before anything uses the bridge. */
export function installPlatformBridge(pageBridge: PlatformBridge): void {
  if (bridge) throw new Error('The platform bridge is already in use');
  bridge = pageBridge;
}

export function usePlatformBridge(): PlatformBridge {
  bridge ??= selectBridge();
  return bridge;
}
