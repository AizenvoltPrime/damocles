import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from '@shared/types/messages';
import type { DamoclesBridge } from '@shared/damocles-bridge';
import { malformedWebviewText } from '@shared/localized-paths';

export interface PlatformBridge {
  // the page's host, known before the first render: a VS Code webview, a desktop chat page, or the desktop overlay
  readonly host: 'vscode' | 'desktop' | 'overlay';
  postMessage(message: WebviewToExtensionMessage): void;
  onMessage(handler: (message: ExtensionToWebviewMessage) => void): () => void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

/**
 * Every bridge hands its pages only messages whose LocalizedText parses, so renderText never meets a malformed core's text;
 * such a message is dropped with an error naming it.
 */
export function withParsedText(handler: (message: ExtensionToWebviewMessage) => void): (message: unknown) => void {
  return (message) => {
    const malformed = malformedWebviewText(message);
    if (malformed === undefined) {
      handler(message as ExtensionToWebviewMessage);
      return;
    }
    console.error(`[bridge] dropped a ${(message as { readonly type: string }).type} message: its ${malformed} is not LocalizedText`);
  };
}

function vscodeBridge(api: VsCodeApi): PlatformBridge {
  return {
    host: 'vscode',
    postMessage: (message) => api.postMessage(message),
    onMessage: (handler) => {
      const checked = withParsedText(handler);
      const wrappedHandler = (event: MessageEvent) => {
        checked(event.data);
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
    host: 'desktop',
    postMessage: (message) => bridge.postMessage(message),
    onMessage: (handler) => bridge.onMessage(withParsedText(handler)),
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
