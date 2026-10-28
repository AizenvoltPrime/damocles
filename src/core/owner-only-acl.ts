import { runProcess } from './process-launcher';
import { windowsSystemTool } from './system-tools';

// The user's SID: a bare name resolves to a local account of the same name before the domain one.
async function userSid(): Promise<string> {
  const { exit, stdout } = await runProcess({ file: windowsSystemTool('whoami'), args: ['/user', '/fo', 'csv', '/nh'], windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }, { timeoutMs: 30_000 });
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(stdout.toString('utf8').trim())?.[1];
  if (exit?.code !== 0 || sid === undefined) throw new Error(`whoami did not name the user's SID (exit ${String(exit?.code ?? 'none')})`);
  return sid;
}

/**
 * Replaces the folder's ACL with one entry granting the user, by SID, inherited by every file made inside it (Windows; a
 * no-op elsewhere). /reset drops the explicit entries first: a folder whose parent hands nothing down holds the creating
 * token's default DACL. Throws when either icacls run fails.
 */
export async function restrictToUser(folder: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const sid = await userSid();
  for (const args of [[folder, '/reset'], [folder, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]]) {
    const { exit } = await runProcess({ file: windowsSystemTool('icacls'), args, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }, { timeoutMs: 30_000 });
    if (exit?.code !== 0) throw new Error(`icacls ${args.slice(1).join(' ')} could not restrict ${folder} to ${sid} (exit ${String(exit?.code ?? 'none')})`);
  }
}
