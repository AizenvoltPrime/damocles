// Another machine in the target's home: docs/invariants.md "Remote daemon and wire", another machine running Damocles.
import type { ClientToControl, ControlToClient } from '../../daemon/control-messages';
import type { Endpoint } from '../../core-protocol/endpoint';
import { SHARED_HOME_SEPARATOR, type HostNotice } from '../../preload/overlay-channels';

// the daemon names the other machines (control.sharedHome)
export const SHARED_HOME_FEATURE = 'control.sharedHome';

export interface SharedHomeConnection {
  readonly features: readonly string[];
  readonly control: Pick<Endpoint<ClientToControl, ControlToClient>, 'request'>;
}

export interface SharedHomeDeps {
  readonly notify: (authorityKey: string, hosts: readonly string[]) => void;
  // the host card's notices changed
  readonly changed: (authorityKey: string) => void;
  readonly log: (line: string) => void;
}

export interface SharedHomes {
  // asks the connection once, when its daemon lists the feature
  ask(authorityKey: string, connection: SharedHomeConnection): void;
  // the host card's notice while connection is the one that named other machines
  notice(authorityKey: string, connection: object | undefined): HostNotice | undefined;
}

export function createSharedHomes(deps: SharedHomeDeps): SharedHomes {
  const asked = new Map<string, object>();
  const found = new Map<string, { readonly connection: object; readonly notice: HostNotice }>();
  return {
    ask(authorityKey, connection) {
      if (asked.get(authorityKey) === connection) return;
      asked.set(authorityKey, connection);
      if (!connection.features.includes(SHARED_HOME_FEATURE)) return;
      connection.control.request('sharedHome', {}).then(({ hosts }) => {
        if (asked.get(authorityKey) !== connection || hosts.length === 0) return;
        deps.log(`[remote] ${authorityKey}: ${hosts.join(', ')} also run Damocles in this home`);
        found.set(authorityKey, { connection, notice: { code: 'sharedHome', params: { hosts: hosts.join(SHARED_HOME_SEPARATOR) } } });
        deps.notify(authorityKey, hosts);
        deps.changed(authorityKey);
      }, (err: unknown) => deps.log(`[remote] ${authorityKey}: reading the machines sharing the home failed: ${err instanceof Error ? err.message : String(err)}`));
    },
    notice(authorityKey, connection) {
      const entry = found.get(authorityKey);
      return entry && connection !== undefined && entry.connection === connection ? entry.notice : undefined;
    },
  };
}
