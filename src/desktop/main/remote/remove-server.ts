// Remove Damocles server: the daemon shuts down for the removal and its connection closes once it released its lock, then a
// fixed removal stage runs over ssh as stage 0 runs stage 1 (remove-posix.sh, remove-windows.ps1). Its parameters enter the
// script only as quoted literals.
import { psQuote, shellQuote } from './bootstrap/quote';
import { validateInstallFolder } from './bootstrap/stage1';
import REMOVE_POSIX from './bootstrap/remove-posix.sh';
import REMOVE_WINDOWS from './bootstrap/remove-windows.ps1';
import { RUN_KEY } from '../../daemon/control-messages';
import { isHostFilePath, KEY_ENTRY } from './host-store';
import type { RemoveServerFailureCode, RemoveServerNoticeCode, RemoveServerResult } from '../../preload/overlay-channels';

const PARAMETERS = /# BEGIN PARAMETERS\r?\n[\s\S]*?# END PARAMETERS/;
const NOTICE_CODES: readonly RemoveServerNoticeCode[] = ['versionKept', 'serverFolderKept', 'keyNotFound', 'lingerFailed', 'deleteFailed', 'installInProgress'];
const STAGE_FAILURES: readonly RemoveServerFailureCode[] = ['daemonRunning', 'stageFailed'];
// the stageFailed codes the scripts send; main adds protocol, killed and exit (with exitCode)
const SCRIPT_STAGE_FAILED_CODES: readonly string[] = ['keyFile', 'runKey', 'userName'];
const MAX_PARAM_CHARS = 500;

export interface RemovalParameters {
  readonly runKey: string;
  // the host's install folder and the one before it, when set; Damocles' entries go from <folder>/<user> in each
  readonly installFolder?: string;
  readonly previousInstallFolder?: string;
  // the key Damocles installed ("ssh-ed25519 <blob>") and the host file it went into, only when its box is checked
  readonly key?: { readonly entry: string; readonly file: string };
  // only when its box is checked, on a POSIX target
  readonly disableLinger: boolean;
}

function checked(params: RemovalParameters): RemovalParameters {
  if (!RUN_KEY.test(params.runKey)) throw new RangeError('a run key that is not 16 hex digits');
  for (const folder of [params.installFolder, params.previousInstallFolder]) {
    if (folder !== undefined && !validateInstallFolder(folder).ok) throw new RangeError('an install folder that is not an absolute path on one line');
  }
  if (params.key !== undefined && (!KEY_ENTRY.test(params.key.entry) || !isHostFilePath(params.key.file))) throw new RangeError('a key that is not an ssh-ed25519 type and blob in an absolute file');
  return params;
}

function withParameters(template: string, block: string): string {
  if (!PARAMETERS.test(template)) throw new Error('the removal template has no parameter block');
  return template.replace(PARAMETERS, () => `# BEGIN PARAMETERS\n${block}\n# END PARAMETERS`);
}

export function buildPosixRemoval(raw: RemovalParameters, template: string = REMOVE_POSIX): string {
  const params = checked(raw);
  return withParameters(template, [
    `D_RUN_KEY=${shellQuote(params.runKey)}`,
    `D_INSTALL_FOLDER=${shellQuote(params.installFolder ?? '')}`,
    `D_PREVIOUS_FOLDER=${shellQuote(params.previousInstallFolder ?? '')}`,
    `D_KEY=${shellQuote(params.key?.entry ?? '')}`,
    `D_KEY_FILE=${shellQuote(params.key?.file ?? '')}`,
    `D_DISABLE_LINGER=${shellQuote(params.disableLinger ? '1' : '0')}`,
  ].join('\n'));
}

export function buildWindowsRemoval(raw: RemovalParameters, template: string = REMOVE_WINDOWS): string {
  const params = checked(raw);
  if (params.disableLinger) throw new RangeError('a Windows host has no linger');
  return withParameters(template, [
    `$D_RUN_KEY = ${psQuote(params.runKey)}`,
    `$D_INSTALL_FOLDER = ${psQuote(params.installFolder ?? '')}`,
    `$D_PREVIOUS_FOLDER = ${psQuote(params.previousInstallFolder ?? '')}`,
    `$D_KEY = ${psQuote(params.key?.entry ?? '')}`,
    `$D_KEY_FILE = ${psQuote(params.key?.file ?? '')}`,
  ].join('\n'));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function stageParams(raw: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(raw)) return undefined;
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || value.length > MAX_PARAM_CHARS || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) return undefined;
    Object.defineProperty(params, key, { value, enumerable: true });
  }
  return params;
}

/**
 * The removal stage's outcome from its status lines and exit code: removed with its notices, its own failure, or stageFailed
 * for anything outside the protocol (no removed line, a malformed line, a non-zero exit).
 */
export function removalOutcome(lines: readonly string[], code: number | null): RemoveServerResult {
  const notices: Array<{ readonly code: RemoveServerNoticeCode; readonly params: Readonly<Record<string, string>> }> = [];
  const protocol: RemoveServerResult = { ok: false, code: 'stageFailed', params: { code: 'protocol' } };
  const ended: RemoveServerResult = { ok: false, code: 'stageFailed', params: code === null ? { code: 'killed' } : { code: 'exit', exitCode: String(code) } };
  for (const line of lines) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return protocol;
    }
    if (!isRecord(message)) return protocol;
    const params = message['params'] === undefined ? {} : stageParams(message['params']);
    if (message['kind'] === 'removed') return code === 0 ? { ok: true, notices } : ended;
    if (message['kind'] === 'notice' && NOTICE_CODES.includes(message['code'] as RemoveServerNoticeCode) && params) {
      notices.push({ code: message['code'] as RemoveServerNoticeCode, params });
      continue;
    }
    if (message['kind'] === 'fail' && message['code'] === 'stageFailed' && params) {
      const failed = params['code'];
      return failed !== undefined && SCRIPT_STAGE_FAILED_CODES.includes(failed) ? { ok: false, code: 'stageFailed', params: { code: failed } } : protocol;
    }
    if (message['kind'] === 'fail' && STAGE_FAILURES.includes(message['code'] as RemoveServerFailureCode) && params) return { ok: false, code: message['code'] as RemoveServerFailureCode, params };
    return protocol;
  }
  return ended;
}

export interface RemoveServerDeps {
  // the host's daemon connection while connected
  // shutdownForRemoval: the run key, and closed, which settles once the daemon ended the connection after releasing its lock
  // or the connection dropped; the stage refuses with daemonRunning while the daemon still holds its lock
  readonly connected: () => { readonly features: readonly string[]; shutdownForRemoval(): Promise<{ readonly runKey: string; readonly closed: Promise<void> }> } | undefined;
  readonly os: 'posix' | 'win32';
  readonly installFolder?: string;
  readonly previousInstallFolder?: string;
  // what Damocles installed, present only when its box is checked and the host store recorded it
  readonly key?: { readonly entry: string; readonly file: string };
  // the removal stage over ssh: its status lines and exit code
  readonly runStage: (script: string) => Promise<{ readonly code: number | null; readonly lines: readonly string[] }>;
  readonly log: (line: string) => void;
  readonly closeWaitMs?: number;
}

export const REMOVAL_FEATURE = 'control.shutdownForRemoval';
// the most the removal waits for the daemon to end its connection; the stage then decides by the daemon's lock
export const REMOVAL_CLOSE_WAIT_MS = 15_000;

/** The removal stage over ssh and its outcome; a retry after daemonRunning runs the same script again, attaching nothing. */
export async function runRemovalStage(deps: Pick<RemoveServerDeps, 'runStage' | 'log'>, script: string): Promise<RemoveServerResult> {
  const { code, lines } = await deps.runStage(script);
  const outcome = removalOutcome(lines, code);
  deps.log(`[remote] the removal stage ended: ${outcome.ok ? `removed (${outcome.notices.map((notice) => notice.code).join(', ') || 'no notices'})` : outcome.code}`);
  return outcome;
}

/** Shuts the daemon down for the removal, waits for its connection to close (the daemon released its lock), then runs the stage. */
export async function removeServer(deps: RemoveServerDeps, options: { readonly disableLinger: boolean }): Promise<RemoveServerResult> {
  const connection = deps.connected();
  if (!connection) return { ok: false, code: 'notConnected', params: {} };
  if (!connection.features.includes(REMOVAL_FEATURE)) return { ok: false, code: 'unsupported', params: {} };
  const { runKey, closed } = await connection.shutdownForRemoval();
  let timer: NodeJS.Timeout | undefined;
  const waited = await Promise.race([
    closed.then(() => 'closed' as const),
    new Promise<'timedOut'>((resolve) => { timer = setTimeout(() => resolve('timedOut'), deps.closeWaitMs ?? REMOVAL_CLOSE_WAIT_MS); }),
  ]).finally(() => clearTimeout(timer));
  // a daemon still holding its lock makes the stage stop with daemonRunning before it deletes anything
  if (waited === 'timedOut') deps.log(`[remote] the daemon did not end its connection within ${deps.closeWaitMs ?? REMOVAL_CLOSE_WAIT_MS} ms; the removal stage checks its lock`);
  const params: RemovalParameters = {
    runKey,
    ...(deps.installFolder !== undefined ? { installFolder: deps.installFolder } : {}),
    ...(deps.previousInstallFolder !== undefined ? { previousInstallFolder: deps.previousInstallFolder } : {}),
    ...(deps.key !== undefined ? { key: deps.key } : {}),
    disableLinger: options.disableLinger && deps.os === 'posix',
  };
  return runRemovalStage(deps, deps.os === 'win32' ? buildWindowsRemoval(params) : buildPosixRemoval(params));
}
