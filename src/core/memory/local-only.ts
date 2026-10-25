import { userScopeRemote } from '../user-scope';

/** On a daemon's core, a condition that leaves out global rows (D5); on this computer's core, none. */
export function localOnly(column = ''): string {
  return userScopeRemote() ? ` AND ${column}scope != 'global'` : '';
}
