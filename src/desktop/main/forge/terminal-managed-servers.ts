import type { ManagedServer } from '../../../core/scm/askpass/credential-config';
import type { CoreClient } from '../core-client';

/**
 * The managed servers a local terminal's credential takeover starts with: the running core's forge mirror, waited for while
 * that core has not published it, else `last`, the set main read from a ready core before (docs/invariants.md "GitHub and
 * GitLab accounts", core restart window).
 */
export async function terminalManagedServers(core: Pick<CoreClient, 'forgeManagedServers' | 'forgeServersRead'> | undefined, last: readonly ManagedServer[]): Promise<readonly ManagedServer[]> {
  // settles once core read its forge files or failed to, after the mirror that read published
  if (core && core.forgeManagedServers() === undefined) await core.forgeServersRead();
  return core?.forgeManagedServers() ?? last;
}
