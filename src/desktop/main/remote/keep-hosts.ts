// What a core start tells this computer's core to keep: the account bindings, host defaults, project looks and character pins
// of the authorities this computer still holds. Core drops those of every other authority.
import type { CoreClient } from '../core-client';
import type { HostStore } from './host-store';

/** Tells core the authorities this computer still holds (a saved host's, or one with listed projects). */
export async function keepKnownHosts(store: Pick<HostStore, 'hosts' | 'projects' | 'authorityOf' | 'unreadable'> | undefined, client: Pick<CoreClient, 'forgeKeepHosts' | 'themesKeepHosts'>, log: (line: string) => void): Promise<void> {
  if (!store) {
    log('[forge] the host store is not open, so no forgotten host\'s account bindings are dropped');
    return;
  }
  // a file that did not parse lists no host, which says nothing about the hosts it holds
  const unreadable = store.unreadable();
  if (unreadable !== undefined) {
    log(`[hosts] remote-hosts.json could not be read (${unreadable}), so core is not told which hosts to keep and drops nothing`);
    return;
  }
  const kept = new Set([...store.hosts().flatMap((record) => store.authorityOf(record.id) ?? []), ...store.projects().map(({ authorityKey }) => authorityKey)]);
  await client.forgeKeepHosts([...kept]);
  await client.themesKeepHosts([...kept]);
}
