import { contextBridge, ipcRenderer } from 'electron';
import { applyHostTheme } from './apply-theme';
import { PANEL_CHANNELS, type PanelInit, type PanelTheme } from './panel-channels';
import type { DamoclesBridge } from '../../shared/damocles-bridge';

// Hydrated on first use, not at preload start: main checks the sender frame's URL, which commits only after the preload has run.
// Undefined while main refuses the frame (it answers null); the next call asks again.
let hydrated: { state: unknown; theme: PanelTheme } | undefined;
function current(): { state: unknown; theme: PanelTheme } | undefined {
  if (!hydrated) {
    const init = ipcRenderer.sendSync(PANEL_CHANNELS.init) as PanelInit | null;
    if (init === null) return undefined;
    hydrated = { state: init.state, theme: init.theme };
  }
  return hydrated;
}
const listeners = new Set<(message: unknown) => void>();

ipcRenderer.on(PANEL_CHANNELS.message, (_event, message: unknown) => {
  for (const listener of [...listeners]) listener(message);
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
  setState: (next: unknown): void => {
    const hydratedState = current();
    if (hydratedState) hydratedState.state = next;
    ipcRenderer.send(PANEL_CHANNELS.setState, next);
  },
};

contextBridge.exposeInMainWorld('damoclesBridge', bridge);
