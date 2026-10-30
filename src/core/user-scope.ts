// On a daemon's core the user-scope services (the browser, global memory) live on the client, which nothing relays to a
// chat on a remote host, so each refuses with its reason here.
import { USER_SCOPE_UNAVAILABLE } from '../shared/remote-user';
import type { LocalizedText } from '../shared/localized-text';
import { l } from './l10n';
import { installedPlatform } from './platform-host';

/** Whether this core is a daemon's, whose user-scope services are its client's. */
export function userScopeRemote(): boolean {
  return installedPlatform()?.remote !== undefined;
}

/** A view's form; a thrown LocalizedError's message and a tool's block reason carry its English form. */
export function browserUnavailableReason(): LocalizedText {
  return l('{0} is not available in a chat on a remote host yet: it runs on your computer ({1}).', l('The browser'), USER_SCOPE_UNAVAILABLE);
}

export function globalMemoryUnavailableReason(): LocalizedText {
  return l('{0} is not available in a chat on a remote host yet: it runs on your computer ({1}).', l('Global memory'), USER_SCOPE_UNAVAILABLE);
}
