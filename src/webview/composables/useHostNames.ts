import { readonly, shallowRef, type Ref } from 'vue';
import type { BridgeHostName } from '@shared/damocles-bridge';
import { isHostTone, type HostTone } from '@shared/host-tones';

export interface HostName {
  readonly name: string;
  readonly color?: HostTone;
}

const names = shallowRef<ReadonlyMap<string, HostName> | undefined>(undefined);
let watching = false;

function shown(map: Readonly<Record<string, BridgeHostName>>): ReadonlyMap<string, HostName> {
  return new Map(Object.entries(map).map(([hostId, entry]) => [hostId, { name: entry.name, ...(isHostTone(entry.color) ? { color: entry.color } : {}) }]));
}

/**
 * Every saved host's name and color by host id, as this computer's host store has them (desktop main, on a page of this
 * computer's core); undefined on a remote chat's page and in VS Code. Main resends the map after a rename, recolor or forget.
 */
export function useHostNames(): Readonly<Ref<ReadonlyMap<string, HostName> | undefined>> {
  const bridge = typeof window === 'undefined' ? undefined : window.damoclesBridge;
  if (!watching && bridge) {
    watching = true;
    // subscribed first: a read made before main answers the page's init learns the names once it does
    bridge.onHostNames((next) => {
      names.value = shown(next);
    });
    const initial = bridge.getHostNames();
    if (initial) names.value = shown(initial);
  }
  return readonly(names) as Readonly<Ref<ReadonlyMap<string, HostName> | undefined>>;
}
