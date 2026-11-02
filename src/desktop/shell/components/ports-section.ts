import type { OverlayMenuItem } from '../../preload/overlay-channels';
import { ON_DETECT, type OnDetect, type PortRow } from '../../preload/ports-channels';

export type PortDotShape = 'live' | 'idle' | 'detected' | 'ignored' | 'error' | 'direct';

/** The row's dot: green only while the forward carries connections; a port WSL forwards itself has no tunnel to count them. */
export function portDotShape(row: PortRow): PortDotShape {
  if (row.state === 'forwarded' && row.viaWsl) return 'direct';
  if (row.state === 'forwarded') return row.liveConnections > 0 ? 'live' : 'idle';
  return row.state;
}

/** The target the row forwards, as the user would type it: the port alone for the target's own loopback. */
export function remoteText(row: Pick<PortRow, 'remoteHost' | 'remotePort'>): string {
  return row.remoteHost === 'localhost' ? String(row.remotePort) : `${row.remoteHost}:${row.remotePort}`;
}

export type PortAction = 'openInPane' | 'openInBrowser' | 'copyAddress' | 'setLabel' | 'changeLocalPort' | 'stop' | 'forward';

/**
 * What a row offers, in menu order; a forward that is not listening offers only to forward again or stop. A port WSL forwards
 * itself has no tunnel to move or stop.
 */
export function portActions(row: PortRow): readonly PortAction[] {
  switch (row.state) {
    case 'forwarded':
      return row.viaWsl ? ['openInPane', 'openInBrowser', 'copyAddress', 'setLabel'] : ['openInPane', 'openInBrowser', 'copyAddress', 'setLabel', 'changeLocalPort', 'stop'];
    case 'error':
      return ['forward', 'stop'];
    case 'detected':
    case 'ignored':
      return ['forward', 'setLabel'];
  }
}

/** The action Enter runs on a row. */
export const primaryAction = (row: PortRow): PortAction => (row.state === 'forwarded' ? 'openInPane' : 'forward');

const ON_DETECT_PREFIX = 'onDetect:';

export interface PortMenuLabels {
  readonly action: (action: PortAction) => string;
  readonly whenDetected: string;
  readonly onDetect: (value: OnDetect) => string;
}

/** The row's menu: its actions, then When detected as radio choices, with Stop forwarding last and set apart. */
export function portMenu(row: PortRow, labels: PortMenuLabels, connected: boolean): OverlayMenuItem[] {
  const item = (action: PortAction): OverlayMenuItem => ({
    kind: 'item',
    id: action,
    label: labels.action(action),
    ...(action === 'stop' ? { danger: true } : {}),
    ...(!connected && action !== 'stop' && action !== 'setLabel' ? { disabled: true } : {}),
  });
  const actions = portActions(row);
  const open = actions.filter((action) => action === 'openInPane' || action === 'openInBrowser' || action === 'copyAddress' || action === 'forward');
  const edit = actions.filter((action) => action === 'setLabel' || action === 'changeLocalPort');
  const whenDetected: OverlayMenuItem = {
    kind: 'submenu',
    id: 'whenDetected',
    label: labels.whenDetected,
    items: ON_DETECT.map((value) => ({ kind: 'item', id: `${ON_DETECT_PREFIX}${value}`, label: labels.onDetect(value), checked: row.onDetect === value, radio: true })),
  };
  const sections: OverlayMenuItem[][] = [open.map(item), [...edit.map(item), whenDetected], actions.includes('stop') ? [item('stop')] : []];
  return sections.filter((section) => section.length > 0).flatMap((section, index) => (index === 0 ? section : [{ kind: 'separator' }, ...section]));
}

/** The choice a menu answer names, or undefined for an id the menu never had. */
export function menuChoice(itemId: string): { readonly action: PortAction } | { readonly onDetect: OnDetect } | undefined {
  if (itemId.startsWith(ON_DETECT_PREFIX)) {
    const value = itemId.slice(ON_DETECT_PREFIX.length);
    return (ON_DETECT as readonly string[]).includes(value) ? { onDetect: value as OnDetect } : undefined;
  }
  const actions: readonly string[] = ['openInPane', 'openInBrowser', 'copyAddress', 'setLabel', 'changeLocalPort', 'stop', 'forward'];
  return actions.includes(itemId) ? { action: itemId as PortAction } : undefined;
}
