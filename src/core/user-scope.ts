// On a daemon's core the user-scope services (the browser, global memory) live on the client, which nothing relays to a
// chat on a remote host, so each refuses with its reason here.
import { USER_SCOPE_UNAVAILABLE } from '../shared/remote-user';
import { t } from './l10n';
import { installedPlatform } from './platform-host';

/** Whether this core is a daemon's, whose user-scope services are its client's. */
export function userScopeRemote(): boolean {
  return installedPlatform()?.remote !== undefined;
}

export function browserUnavailableReason(): string {
  return t('{0} is not available in a chat on a remote host yet: it runs on your computer ({1}).', t('The browser'), USER_SCOPE_UNAVAILABLE);
}

export function globalMemoryUnavailableReason(): string {
  return t('{0} is not available in a chat on a remote host yet: it runs on your computer ({1}).', t('Global memory'), USER_SCOPE_UNAVAILABLE);
}
