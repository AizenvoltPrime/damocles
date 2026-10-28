import type { PanelHost } from "../../platform/window-service";
import type { RemoteHost } from "../../platform/remote-host";
import type { SettingsChange } from "../../platform/settings-store";
import { asClient } from "../client-snapshots";

/** On a panel several devices show, a host whose posts reach that device's views alone; elsewhere the panel's host. */
export function deviceHost(panel: PanelHost, clientId: string | undefined): PanelHost {
  if (!panel.views || !panel.viewHost) return panel;
  return Object.assign(Object.create(panel) as PanelHost, {
    panelHost: panel,
    clientId,
    postMessage: (message: unknown): Promise<boolean> => {
      for (const own of panel.views!()) if (own.clientId === clientId) void panel.viewHost!(own.viewKey).postMessage(message);
      return Promise.resolve(true);
    },
  });
}

/** The host a settings change re-sends a panel's state to: one device's views when only that device's user layer changed. */
export function hostForChange(panel: PanelHost, change: SettingsChange): PanelHost {
  return change.clientId === undefined ? panel : deviceHost(panel, change.clientId);
}

/**
 * Sends state read from the user layer or the account (settings, tools, MCP, image generation): on a daemon's core, a
 * post to a panel several devices show becomes one per device, each built as that device's client sees it, and a post to
 * one device's or view's host is built as its client.
 */
export function forEachDevice<T>(remote: RemoteHost | undefined, host: PanelHost, send: (target: PanelHost) => T): T[] {
  if (!remote) return [send(host)];
  if (host.panelHost !== undefined || !host.views || !host.viewHost) {
    return [host.clientId === undefined ? send(host) : asClient(remote, host.clientId, () => send(host))];
  }
  const clients = new Set(host.views().map((view) => view.clientId));
  return [...clients].map((clientId) => asClient(remote, clientId, () => send(deviceHost(host, clientId))));
}
