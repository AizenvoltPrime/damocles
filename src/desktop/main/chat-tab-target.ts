import type { PanelHost } from '../../platform/window-service';

export interface ChatTabSources {
  // open chat panels by core panel id (PanelManager.getPanels)
  panels(): ReadonlyMap<string, { readonly host: PanelHost; readonly webviewReady?: Promise<void> }>;
  // the selected chat's host, matched to a chat panel by identity
  selected(): unknown;
  // loaded chat hosts in load order
  chats(): readonly unknown[];
  // opens a chat in the selected project; resolves its core panel id
  openChat(): Promise<string>;
}

export interface ChatTabTarget {
  readonly panelId: string;
  readonly host: PanelHost;
}

/** The requested chat while it is loaded, else the selected chat, else the first loaded one; opens one in the selected project and waits for its webview when none is loaded. */
export async function resolveChatTab(sources: ChatTabSources, panelId: string | undefined): Promise<ChatTabTarget> {
  const panels = sources.panels();
  const requested = panelId === undefined ? undefined : panels.get(panelId);
  if (panelId !== undefined && requested) return { panelId, host: requested.host };
  const idByHost = new Map<unknown, string>([...panels].map(([id, instance]) => [instance.host, id]));
  for (const chat of [sources.selected(), ...sources.chats()]) {
    const id = idByHost.get(chat);
    const instance = id === undefined ? undefined : panels.get(id);
    if (id !== undefined && instance) return { panelId: id, host: instance.host };
  }
  const opened = await sources.openChat();
  await sources.panels().get(opened)?.webviewReady;
  const instance = sources.panels().get(opened);
  if (!instance) throw new Error('The chat closed before it could show this');
  return { panelId: opened, host: instance.host };
}
