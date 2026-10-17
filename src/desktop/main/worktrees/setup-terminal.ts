// How the worktree Setup tab runs D32's commands (slice 12a rule 23): a shell from an absolute path, one command after
// another, stopping at the first failure with its exit code.
import * as path from 'node:path';
import { findOnAbsolutePath, windowsPowerShell } from '../../../core/system-tools';
import { NONCE_ENV } from '../terminal/shell-integration-injection';

export type SetupShellKind = 'powershell' | 'posix' | 'fish';

// Login shells that run setupArgs' POSIX script; any other $SHELL (tcsh, nushell, xonsh, elvish) would fail on its syntax.
const POSIX_SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash']);

export interface SetupShell {
  readonly file: string;
  readonly kind: SetupShellKind;
}

/**
 * pwsh 7 when the terminal profiles found it, else Windows PowerShell on Windows; elsewhere $SHELL when it is absolute and
 * a POSIX shell or fish, else bash from an absolute PATH folder. undefined: no shell to run setup with.
 */
export function setupShell(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>, detectedPwsh: string | undefined): SetupShell | undefined {
  if (platform === 'win32') return { file: detectedPwsh ?? windowsPowerShell(env), kind: 'powershell' };
  const login = env['SHELL'];
  const name = login !== undefined && path.posix.isAbsolute(login) ? path.posix.basename(login) : undefined;
  if (login !== undefined && name === 'fish') return { file: login, kind: 'fish' };
  if (login !== undefined && name !== undefined && POSIX_SHELLS.has(name)) return { file: login, kind: 'posix' };
  const bash = findOnAbsolutePath('bash', platform, env);
  return bash === undefined ? undefined : { file: bash, kind: 'posix' };
}

/**
 * The shell's arguments that run the commands in order and exit with the first failure's code, else 0. Each command is
 * framed by shell integration's C and D sequences with the tab's nonce (read from NONCE_ENV, then cleared before any
 * command runs), which is how main learns which command runs (TerminalTaskRequest.onCommandStart).
 */
export function setupArgs(shell: SetupShell, commands: readonly string[]): string[] {
  if (shell.kind === 'powershell') {
    const osc = (body: string): string => `[Console]::Write("$([char]0x1b)]633;${body};$__damoclesNonce$([char]7)")`;
    // $? is false after a failing cmdlet or a native command's non-zero exit, in Windows PowerShell 5.1 and pwsh 7
    const lines = commands.flatMap((command) => [
      osc('C'),
      command,
      '$__damoclesRc = if ($?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }',
      osc('D;$__damoclesRc'),
      'if ($__damoclesRc -ne 0) { exit $__damoclesRc }',
    ]);
    const script = [`$__damoclesNonce = $env:${NONCE_ENV}`, `$env:${NONCE_ENV} = $null`, '$global:LASTEXITCODE = 0', ...lines, 'exit 0'].join('\n');
    // process-scope Bypass, as the agent's PowerShell tool runs: Windows PowerShell 5.1's default Restricted policy blocks npm.ps1
    return ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  }
  // each check sits on its own line, so a trailing comment in a command never swallows it; zsh and fish reserve `status`
  if (shell.kind === 'fish') {
    const start = `set -l __damocles_nonce $${NONCE_ENV}; set -e ${NONCE_ENV}`;
    const lines = commands.flatMap((command) => [
      "printf '\\033]633;C;%s\\007' $__damocles_nonce",
      command,
      "set -l damocles_rc $status; printf '\\033]633;D;%s;%s\\007' $damocles_rc $__damocles_nonce; test $damocles_rc -eq 0; or exit $damocles_rc",
    ]);
    return ['-c', [start, ...lines].join('\n')];
  }
  const start = `__damocles_nonce=$${NONCE_ENV}; unset ${NONCE_ENV}`;
  const lines = commands.flatMap((command) => [
    `printf '\\033]633;C;%s\\007' "$__damocles_nonce"`,
    command,
    `damocles_rc=$?; printf '\\033]633;D;%s;%s\\007' "$damocles_rc" "$__damocles_nonce"; [ "$damocles_rc" -eq 0 ] || exit "$damocles_rc"`,
  ]);
  return ['-c', [start, ...lines].join('\n')];
}
