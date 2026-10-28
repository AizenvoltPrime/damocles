import { contextBridge, ipcRenderer } from 'electron';
import { applyHostTheme } from './apply-theme';
import { PANEL_CHANNELS, type PanelConnection, type PanelHostAction, type PanelHostLabel, type PanelInit, type PanelQueueAction, type PanelTheme } from './panel-channels';
import type { DamoclesBridge } from '../../shared/damocles-bridge';

// Hydrated on first use, not at preload start: main checks the sender frame's URL, which commits only after the preload has run.
// Undefined while main refuses the frame (it answers null); the next call asks again, DOMContentLoaded's at the latest, and
// a host it learns then reaches the onHost listeners of a page that read none before.
type Hydrated = { state: unknown; theme: PanelTheme; host: PanelHostLabel | undefined; offline: PanelInit['offline']; connection: PanelConnection | undefined };
let hydrated: Hydrated | undefined;
function current(): Hydrated | undefined {
  if (!hydrated) {
    const init = ipcRenderer.sendSync(PANEL_CHANNELS.init) as PanelInit | null;
    if (init === null) return undefined;
    hydrated = { state: init.state, theme: init.theme, host: init.host, offline: init.offline, connection: init.connection };
    const { host, connection } = init;
    if (host) for (const listener of [...hostListeners]) listener(host);
    if (connection) for (const listener of [...connectionListeners]) listener(connection);
  }
  return hydrated;
}
const listeners = new Set<(message: unknown) => void>();
const hostListeners = new Set<(host: PanelHostLabel) => void>();
const connectionListeners = new Set<(connection: PanelConnection) => void>();

function parsed(payload: string): { readonly message: unknown } | undefined {
  try {
    return { message: JSON.parse(payload) as unknown };
  } catch {
    return undefined;
  }
}

// Main forwards core's messages as JSON text, and one holding binary (a browser page's frame) as a structured clone. Main
// parses only the page-state types it persists, so text that is not JSON is dropped here; the page's console says so.
ipcRenderer.on(PANEL_CHANNELS.message, (_event, payload: unknown) => {
  const delivered = typeof payload === 'string' ? parsed(payload) : { message: payload };
  if (delivered === undefined) {
    console.warn('[damocles] dropped a host message that is not JSON');
    return;
  }
  for (const listener of [...listeners]) listener(delivered.message);
});

// The panel HTML carries the theme CSS from its creation; this brings a reloaded or crash-recreated page up to the current theme too.
function applyTheme(): void {
  const theme = current()?.theme;
  if (theme) applyHostTheme(theme);
}

ipcRenderer.on(PANEL_CHANNELS.theme, (_event, next: PanelTheme) => {
  const hydratedState = current();
  if (!hydratedState) return;
  hydratedState.theme = next;
  if (document.body) applyTheme();
});
document.addEventListener('DOMContentLoaded', applyTheme, { once: true });

ipcRenderer.on(PANEL_CHANNELS.host, (_event, host: PanelHostLabel) => {
  const hydratedState = current();
  if (!hydratedState) return;
  hydratedState.host = host;
  for (const listener of [...hostListeners]) listener(host);
});

ipcRenderer.on(PANEL_CHANNELS.connection, (_event, connection: PanelConnection) => {
  const hydratedState = current();
  if (!hydratedState) return;
  hydratedState.connection = connection;
  for (const listener of [...connectionListeners]) listener(connection);
});

const bridge: DamoclesBridge = {
  postMessage: (message: unknown): void => {
    ipcRenderer.send(PANEL_CHANNELS.post, message);
  },
  onMessage: (listener: (message: unknown) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getState: (): unknown => current()?.state,
  getHost: (): PanelHostLabel | undefined => current()?.host,
  onHost: (listener: (host: PanelHostLabel) => void): (() => void) => {
    hostListeners.add(listener);
    return () => {
      hostListeners.delete(listener);
    };
  },
  getOffline: () => current()?.offline,
  hostAction: (action: PanelHostAction): void => {
    ipcRenderer.send(PANEL_CHANNELS.hostAction, action);
  },
  getConnection: (): PanelConnection | undefined => current()?.connection,
  onConnection: (listener: (connection: PanelConnection) => void): (() => void) => {
    connectionListeners.add(listener);
    return () => {
      connectionListeners.delete(listener);
    };
  },
  queueAction: (action: PanelQueueAction): void => {
    ipcRenderer.send(PANEL_CHANNELS.queueAction, { action: action.action, id: action.id });
  },
  setState: (next: unknown): void => {
    const hydratedState = current();
    if (hydratedState) hydratedState.state = next;
    ipcRenderer.send(PANEL_CHANNELS.setState, next);
  },
};

contextBridge.exposeInMainWorld('damoclesBridge', bridge);
