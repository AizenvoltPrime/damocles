// Which stage 0 a host gets: `uname -s` alone first, since csh refuses `2>/dev/null`; any other answer is a Windows host,
// whose default shell `echo %COMSPEC%~$PSHOME` tells apart, because cmd and PowerShell each expand only one of the two.
import type { CachedPlatform } from '../../../preload/overlay-channels';

export const UNAME_COMMAND = 'uname -s';
export const WINDOWS_SHELL_COMMAND = 'echo %COMSPEC%~$PSHOME';

export type UnameAnswer = { readonly kind: 'posix'; readonly os: 'linux' | 'darwin' } | { readonly kind: 'bsd'; readonly name: string } | { readonly kind: 'other' };

const BSD = /^(FreeBSD|OpenBSD|NetBSD|DragonFly|MidnightBSD)$/;

/**
 * The line of `uname -s`'s output that names a POSIX kernel, wherever a login script's output put it; other when none does.
 * Git Bash or Cygwin on a Windows host answers MINGW, MSYS or CYGWIN, which is other.
 */
export function parseUname(stdout: string): UnameAnswer {
  for (const name of stdout.split(/\r?\n/).map((line) => line.trim())) {
    if (name === 'Linux') return { kind: 'posix', os: 'linux' };
    if (name === 'Darwin') return { kind: 'posix', os: 'darwin' };
    if (BSD.test(name)) return { kind: 'bsd', name };
  }
  return { kind: 'other' };
}

/**
 * cmd expands %COMSPEC% and leaves $PSHOME; PowerShell does the reverse. A POSIX shell (Git Bash as Win32-OpenSSH's default
 * shell) expands neither, and runs stage 0's `powershell -EncodedCommand` line as cmd does.
 */
export function parseWindowsShell(stdout: string): 'cmd' | 'powershell' {
  const line = stdout.split(/\r?\n/).map((text) => text.trim()).find((text) => text.includes('~')) ?? '';
  const [comspec = '', pshome = ''] = line.split('~');
  if (comspec !== '%COMSPEC%' && pshome === '$PSHOME') return 'cmd';
  if (comspec === '%COMSPEC%' && pshome !== '$PSHOME' && pshome !== '') return 'powershell';
  return 'cmd';
}

export type DetectedPlatform = { readonly ok: true; readonly platform: CachedPlatform } | { readonly ok: false; readonly os: string };

export interface DetectionDeps {
  // runs `command` as the host's remote command and resolves with its stdout, whatever the exit code
  readonly run: (command: string) => Promise<string>;
}

async function windowsPlatform(deps: DetectionDeps): Promise<DetectedPlatform> {
  return { ok: true, platform: { os: 'win32', windowsShell: parseWindowsShell(await deps.run(WINDOWS_SHELL_COMMAND)) } };
}

/**
 * The platform a connect uses. The host's override wins, a cached detection is reused, and only what neither answers runs
 * on the host: `uname -s`, then the shell echo on a Windows host (also under a Windows override with no cached shell).
 */
export async function resolvePlatform(override: CachedPlatform['os'] | undefined, cached: CachedPlatform | undefined, deps: DetectionDeps): Promise<DetectedPlatform> {
  if (override !== undefined && override !== 'win32') return { ok: true, platform: { os: override } };
  if (override === 'win32') return cached?.os === 'win32' && cached.windowsShell !== undefined ? { ok: true, platform: cached } : windowsPlatform(deps);
  if (cached !== undefined && (cached.os !== 'win32' || cached.windowsShell !== undefined)) return { ok: true, platform: cached };
  const uname = parseUname(await deps.run(UNAME_COMMAND));
  if (uname.kind === 'posix') return { ok: true, platform: { os: uname.os } };
  if (uname.kind === 'bsd') return { ok: false, os: uname.name };
  return windowsPlatform(deps);
}
