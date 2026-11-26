// <runDir>/active: a shell keeps what its server version named and runs whichever package the link points at later, so
// FROZEN_THROUGH_ACTIVE_LINK never changes once released (docs/invariants.md "The damocles command").
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

// Package-relative paths a shell names through the link (every target, POSIX, Windows), and the names its environment or
// git's helper argv carries, each with the package files that read it.
export const FROZEN_THROUGH_ACTIVE_LINK = {
  paths: {
    all: [
      'bin/remote-cli/damocles',
      'dist/askpass-main.js',
      'resources/shell-integration/shellIntegration-bash.sh',
      'resources/shell-integration/shellIntegration-env.zsh',
      'resources/shell-integration/shellIntegration-login.zsh',
      'resources/shell-integration/shellIntegration-profile.zsh',
      'resources/shell-integration/shellIntegration-rc.zsh',
      'resources/shell-integration/shellIntegration.fish',
      'resources/shell-integration/shellIntegration.ps1',
    ],
    posix: ['bin/helpers/browser.sh', 'dist/git-credential/git-credential-relay.sh', 'node/node'],
    win32: ['bin/remote-cli/damocles.cmd', 'bin/helpers/browser.exe', 'dist/git-credential/git-credential-relay.cmd', 'node/node.exe'],
  },
  reads: [
    { names: ['DAMOCLES_ASKPASS_NODE', 'DAMOCLES_ASKPASS_MAIN'], by: ['dist/git-credential/git-credential-relay.sh', 'dist/git-credential/git-credential-relay.cmd'] },
    { names: ['DAMOCLES_ASKPASS_HANDLE', 'DAMOCLES_CREDENTIAL_NONCE', '--takeover'], by: ['dist/askpass-main.js'] },
    { names: ['DAMOCLES_CLI_HOOK'], by: ['dist/cli-remote.js'] },
  ],
} as const;

export function activeLinkPath(runDir: string): string {
  return path.join(runDir, 'active');
}

/** file as a shell names it: through the active link when it lies under root, else unchanged. */
export function throughActiveLink(root: string, active: string, file: string): string {
  const relative = path.relative(root, file);
  return relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? file : path.join(active, relative);
}

const missing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';
// pointActiveLink's temporary names
const LEFTOVER = /^active\.[1-9][0-9]*\.[0-9a-f]{12}\.(?:new|old)$/;

/** Points <runDir>/active at root; a link is never removed recursively, which would delete the package it points at. */
export async function pointActiveLink(runDir: string, root: string, log: (line: string) => void): Promise<void> {
  const link = activeLinkPath(runDir);
  // a start that ended between the steps left its temporary links: each goes as a link, anything else at such a name stays
  for (const name of await fs.readdir(runDir)) {
    if (!LEFTOVER.test(name)) continue;
    const file = path.join(runDir, name);
    if ((await fs.lstat(file)).isSymbolicLink()) await fs.unlink(file);
  }
  const present = await fs.lstat(link).catch((err: unknown) => {
    if (missing(err)) return undefined;
    throw err;
  });
  if (present && !present.isSymbolicLink()) throw new Error(`${link} is not a link`);
  const windows = process.platform === 'win32';
  const temporary = (what: string): string => `${link}.${process.pid}.${randomBytes(6).toString('hex')}.${what}`;
  const made = temporary('new');
  await fs.symlink(root, made, windows ? 'junction' : 'dir');
  const old = temporary('old');
  try {
    if (!windows) {
      await fs.rename(made, link);
      return;
    }
    const moved = await fs.rename(link, old).then(() => true, (err: unknown) => {
      if (missing(err)) return false;
      throw err;
    });
    try {
      await fs.rename(made, link);
    } catch (err) {
      if (moved) await fs.rename(old, link);
      throw err;
    }
    if (!moved) return;
  } catch (err) {
    await fs.unlink(made).catch((cleanup: unknown) => {
      if (!missing(cleanup)) throw cleanup;
    });
    throw err;
  }
  await fs.unlink(old).catch((err: unknown) => log(`[daemon] could not unlink ${old}, which the next start removes: ${err instanceof Error ? err.message : String(err)}`));
}
