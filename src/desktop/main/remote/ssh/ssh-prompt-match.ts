// Which hop an ssh prompt belongs to, by OpenSSH's exact prompt text (docs/invariants.md "Remote daemon and wire"). A
// remembered answer is offered only to the one hop a prompt names, so a ProxyJump host never gets the target's answer.
import * as path from 'node:path';
import type { SshHop } from './ssh-config';

export type RememberedKind = 'password' | 'passphrase';

// a passphrase belongs to one key file of the hop, as `ssh -G` lists it
export type HopBinding = { readonly hop: SshHop; readonly kind: 'password' } | { readonly hop: SshHop; readonly kind: 'passphrase'; readonly identityFile: string };

// ssh's password prompt names the host as its HostKeyAlias when one is set, else as its alias or the HostName it resolved
function passwordPrompts(hop: SshHop): string[] {
  const hosts = hop.hostKeyAlias !== undefined ? [hop.hostKeyAlias] : [...new Set([hop.alias, hop.hostname])];
  return hosts.flatMap((host) => [`${hop.user}@${host}'s password:`, `(${hop.user}@${host}) Password:`]);
}

// ssh prints the key's path with `~` expanded, as the home folder joined to the rest; without a home, as written
function keyPaths(file: string, home: string | undefined): string[] {
  if (home === undefined || (file !== '~' && !file.startsWith('~/') && !file.startsWith('~\\'))) return [file];
  return [file, `${home}${file.slice(1)}`, path.join(home, file.slice(1))];
}

function passphraseKey(hop: SshHop, text: string, home: string | undefined): string | undefined {
  return hop.identityFiles.find((file) => keyPaths(file, home).some((key) => text === `Enter passphrase for key '${key}':`));
}

/**
 * The one hop whose password or passphrase prompt equals text, which is the prompt as askpass shows it (trimmed); undefined
 * when no hop's prompt or more than one hop's prompt equals it, so the prompt is asked.
 */
export function matchHopPrompt(text: string, hops: readonly SshHop[], home: string | undefined): HopBinding | undefined {
  const matches: HopBinding[] = [];
  for (const hop of hops) {
    const identityFile = passphraseKey(hop, text, home);
    if (passwordPrompts(hop).includes(text)) matches.push({ hop, kind: 'password' });
    else if (identityFile !== undefined) matches.push({ hop, kind: 'passphrase', identityFile });
  }
  return matches.length === 1 ? matches[0] : undefined;
}
