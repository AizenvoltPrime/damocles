// Allow background work: logind's linger for the daemon's own user, so its agents outlive the last logout. An explicit user
// action, one of the user-run writes outside .damocles (docs/invariants.md "Remote daemon and wire").
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runProcess, type RunOutput, type SpawnSpec } from '../../core/process-launcher';
import { posixToolAsync } from '../../core/system-tools';
import { LINGER_USER, type LingerResult } from './control-messages';

const LINGER_TIMEOUT_MS = 30_000;
// loginctl's error when polkit refuses an unprivileged user, in the C locale (sd-bus's access denied and interactive auth errors)
const POLKIT_REFUSAL = /access denied|permission denied|interactive authentication required|not authorized/i;
// logind's record of the users with linger, one file per user name, which stage1-posix.sh's check_linger reads too
const LINGER_FOLDER = '/var/lib/systemd/linger';

export interface LingerDeps {
  readonly log: (line: string) => void;
  readonly platform?: NodeJS.Platform;
  readonly run?: (spec: SpawnSpec, options: { readonly timeoutMs: number }) => Promise<RunOutput>;
  readonly loginctl?: () => Promise<string | undefined>;
  readonly user?: () => string;
  readonly lingerFolder?: string;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Whether logind already records linger for the user; a read that fails for another reason than a missing file answers no.
async function lingerRecorded(folder: string, user: string, log: (line: string) => void): Promise<boolean> {
  try {
    await fs.stat(path.posix.join(folder, user));
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') log(`[linger] reading ${folder} failed: ${messageOf(err)}`);
    return false;
  }
}

/**
 * Runs `loginctl enable-linger <own user>` without sudo or a password prompt, unless logind already records linger for the
 * user; polkit's refusal names the user an admin enables.
 */
export async function enableLinger(deps: LingerDeps): Promise<LingerResult> {
  if ((deps.platform ?? process.platform) !== 'linux') {
    deps.log('[linger] logind exists only on Linux');
    return { result: 'failed', code: 'noLoginctl' };
  }
  let user: string;
  try {
    user = (deps.user ?? (() => os.userInfo().username))();
  } catch (err) {
    deps.log(`[linger] reading the user name failed: ${messageOf(err)}`);
    return { result: 'failed', code: 'userInfo' };
  }
  if (!LINGER_USER.test(user)) {
    deps.log('[linger] the user name is not one loginctl takes');
    return { result: 'failed', code: 'user' };
  }
  if (await lingerRecorded(deps.lingerFolder ?? LINGER_FOLDER, user, deps.log)) {
    deps.log(`[linger] already enabled for ${user}`);
    return { result: 'alreadyEnabled' };
  }
  const loginctl = await (deps.loginctl ?? (() => posixToolAsync('loginctl')))();
  if (loginctl === undefined) {
    deps.log('[linger] no loginctl on this host');
    return { result: 'failed', code: 'noLoginctl' };
  }
  const run = deps.run ?? runProcess;
  let output: RunOutput;
  try {
    // the C locale keeps loginctl's refusal in the words POLKIT_REFUSAL reads
    output = await run(
      { file: loginctl, args: ['--no-ask-password', 'enable-linger', user], env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'ignore', 'pipe'] },
      { timeoutMs: LINGER_TIMEOUT_MS },
    );
  } catch (err) {
    deps.log(`[linger] loginctl did not start: ${messageOf(err)}`);
    return { result: 'failed', code: 'spawn' };
  }
  const { exit, stderr } = output;
  if (exit === null) {
    deps.log(`[linger] loginctl did not finish within ${LINGER_TIMEOUT_MS} ms`);
    return { result: 'failed', code: 'timeout' };
  }
  if (exit.code === 0) {
    deps.log(`[linger] enabled for ${user}`);
    return { result: 'enabled' };
  }
  const reason = stderr.toString('utf8').trim().slice(0, 512);
  deps.log(`[linger] loginctl enable-linger ${user} exited ${exit.code ?? exit.signal}: ${reason}`);
  if (POLKIT_REFUSAL.test(reason)) return { result: 'refused', user };
  // LOG_NAME bounds the code, which takes no ':'
  return { result: 'failed', code: exit.code !== null ? `exit${exit.code}` : `signal-${exit.signal}` };
}
