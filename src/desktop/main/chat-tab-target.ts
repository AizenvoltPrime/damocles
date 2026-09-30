import type { PanelHost } from '../../platform/window-service';

export interface ChatTabSources {
  // open chat panels by core panel id (PanelManager.getPanels)
  panels(): ReadonlyMap<string, { readonly host: PanelHost; readonly webviewReady?: Promise<void> }>;
  // the selected tab's host, matched to a chat panel by identity
  selected(): unknown;
  // tab hosts in strip order
  tabs(): readonly unknown[];
  // opens a chat tab on the default project; resolves its core panel id
  openChat(): Promise<string>;
}

export interface ChatTabTarget {
  readonly panelId: string;
  readonly host: PanelHost;
}

/** The requested chat tab while it is open, else the selected chat tab, else the first one; opens one on the default project and waits for its webview when none is open. */
export async function resolveChatTab(sources: ChatTabSources, panelId: string | undefined): Promise<ChatTabTarget> {
  const panels = sources.panels();
  const requested = panelId === undefined ? undefined : panels.get(panelId);
  if (panelId !== undefined && requested) return { panelId, host: requested.host };
  const idByHost = new Map<unknown, string>([...panels].map(([id, instance]) => [instance.host, id]));
  for (const tab of [sources.selected(), ...sources.tabs()]) {
    const id = idByHost.get(tab);
    const instance = id === undefined ? undefined : panels.get(id);
    if (id !== undefined && instance) return { panelId: id, host: instance.host };
  }
  const opened = await sources.openChat();
  await sources.panels().get(opened)?.webviewReady;
  const instance = sources.panels().get(opened);
  if (!instance) throw new Error('The chat tab closed before it could show this');
  return { panelId: opened, host: instance.host };
}
