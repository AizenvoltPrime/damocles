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
  // acquireVsCodeApi may be called only once per webview, so selection runs at module load.
  if (typeof acquireVsCodeApi === 'function') return vscodeBridge(acquireVsCodeApi());
  const bridge = window.damoclesBridge;
  if (!bridge) throw new Error('No host bridge: neither acquireVsCodeApi nor window.damoclesBridge is defined');
  return desktopBridge(bridge);
}

const bridge = selectBridge();

export function usePlatformBridge(): PlatformBridge {
  return bridge;
}
