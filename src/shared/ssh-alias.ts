/** Control, format and line or paragraph separator characters, which ssh or a terminal would read as something other than the text. */
export const SSH_UNSAFE: RegExp = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

// at most 255 characters, MAX_SSH_ALIAS_LENGTH (preload/overlay-channels.ts); a DNS name's wire-format bound
const ALIAS = /^[^\s-][^\s]{0,254}$/;

/** A Host alias ssh takes as written: no option, no `user@` or `ssh://` it would reinterpret, no pattern. Pass it to ssh after `--`. */
export function isSafeAlias(alias: string): boolean {
  return ALIAS.test(alias) && !SSH_UNSAFE.test(alias) && !/[*?!@]/.test(alias) && !alias.startsWith('ssh://');
}
