// Which shells start with an integration script and how, adapted from VS Code's getShellIntegrationInjection
// (terminalEnvironment.ts, MIT).
import * as path from 'node:path';

// The script names under the shell-integration resource folder.
export const SHELL_INTEGRATION_SCRIPTS = {
  powershell: 'shellIntegration.ps1',
  bash: 'shellIntegration-bash.sh',
  fish: 'shellIntegration.fish',
} as const;
// zsh reads its startup files from ZDOTDIR by these names; each is a copy of one script.
const ZSH_DOTFILES: ReadonlyArray<readonly [script: string, dotfile: string]> = [
  ['shellIntegration-env.zsh', '.zshenv'],
  ['shellIntegration-profile.zsh', '.zprofile'],
  ['shellIntegration-rc.zsh', '.zshrc'],
  ['shellIntegration-login.zsh', '.zlogin'],
];

// The variables the scripts read; each script removes them from its environment once read.
export const NONCE_ENV = 'DAMOCLES_NONCE';
export const INJECTION_ENV = 'DAMOCLES_INJECTION';
export const SCRIPT_ENV = 'DAMOCLES_SHELL_INTEGRATION_SCRIPT';
export const SHELL_LOGIN_ENV = 'DAMOCLES_SHELL_LOGIN';
export const USER_ZDOTDIR_ENV = 'DAMOCLES_USER_ZDOTDIR';
// Every variable the scripts read, set or export. A Damocles started from its own terminal inherits the exported ones, so
// terminalEnvironment drops them all, as VS Code's sanitizeProcessEnvironment drops VSCODE_*; any other DAMOCLES_ variable is the user's.
export const SCRIPT_STATE_ENV: readonly string[] = [
  NONCE_ENV,
  INJECTION_ENV,
  SCRIPT_ENV,
  SHELL_LOGIN_ENV,
  USER_ZDOTDIR_ENV,
  'DAMOCLES_ZDOTDIR',
  'DAMOCLES_SHELL_INTEGRATION',
  'DAMOCLES_PROFILE_INITIALIZED',
  'DAMOCLES_LOGIN_INITIALIZED',
];

export interface InjectionRequest {
  readonly platform: NodeJS.Platform;
  readonly file: string;
  readonly args: readonly string[];
  // the app's own shell-integration folder (resources, unpacked); never a project path
  readonly scriptsDir: string;
  // zsh's ZDOTDIR: a folder in the user's own app data, which no other user and no project writes
  readonly zshDotDir: string;
  readonly nonce: string;
  // the environment the shell gets otherwise, for the user's ZDOTDIR
  readonly env: Readonly<Record<string, string>>;
  readonly homedir: string;
}

export interface Injection {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  // copied before the shell starts (zsh's dotfiles)
  readonly filesToCopy?: ReadonlyArray<{ readonly source: string; readonly dest: string }>;
}

const PWSH_LOGIN_ARGS = ['-login', '-l'];
const SH_LOGIN_ARGS = ['--login', '-l'];
const SH_INTERACTIVE_ARGS = ['-i', '--interactive'];
const PWSH_IMPLIED_ARGS = ['-nol', '-nologo'];

const lower = (args: readonly string[]): string[] => args.map((arg) => arg.toLowerCase());

function arePwshImpliedArgs(args: readonly string[]): boolean {
  return args.length === 0 || (args.length === 1 && PWSH_IMPLIED_ARGS.includes(lower(args)[0]!));
}

function arePwshLoginArgs(args: readonly string[]): boolean {
  const [first, second] = lower(args);
  if (args.length === 1) return PWSH_LOGIN_ARGS.includes(first!);
  return args.length === 2 && (PWSH_LOGIN_ARGS.includes(first!) || PWSH_LOGIN_ARGS.includes(second!)) && (PWSH_IMPLIED_ARGS.includes(first!) || PWSH_IMPLIED_ARGS.includes(second!));
}

function areShLoginArgs(args: readonly string[]): boolean {
  const rest = lower(args).filter((arg) => !SH_INTERACTIVE_ARGS.includes(arg));
  return rest.length === 1 && SH_LOGIN_ARGS.includes(rest[0]!);
}

/**
 * The args and extra environment that start the shell with its integration script, or undefined for a shell VS Code does not
 * inject (cmd.exe, wsl.exe and every other Windows executable but pwsh.exe, powershell.exe and bash.exe; a POSIX shell other
 * than bash, fish, pwsh and zsh) and for args it does not recognize. Paths travel as their own argv entries or in the
 * environment, never inside shell source, so no quoting applies.
 */
export function shellIntegrationInjection(request: InjectionRequest): Injection | undefined {
  const { args, scriptsDir } = request;
  const windows = request.platform === 'win32';
  const shell = windows ? path.win32.basename(request.file).toLowerCase() : path.posix.basename(request.file);
  const join = windows ? path.win32.join : path.posix.join;
  const base = { [INJECTION_ENV]: '1', [NONCE_ENV]: request.nonce };
  // PowerShell dot-sources the path from the environment; on Windows a Restricted execution policy refuses the script, and
  // VS Code's try lets the shell start without integration instead of printing that error at every start.
  const pwsh = (dotSource: string): Injection | undefined => {
    const env = { ...base, [SCRIPT_ENV]: join(scriptsDir, SHELL_INTEGRATION_SCRIPTS.powershell) };
    if (arePwshImpliedArgs(args)) return { args: ['-noexit', '-command', dotSource], env };
    return arePwshLoginArgs(args) ? { args: ['-l', '-noexit', '-command', dotSource], env } : undefined;
  };
  const bash = (): Injection | undefined => {
    const initFile = ['--init-file', join(scriptsDir, SHELL_INTEGRATION_SCRIPTS.bash)];
    if (args.length === 0) return { args: initFile, env: base };
    return areShLoginArgs(args) ? { args: initFile, env: { ...base, [SHELL_LOGIN_ENV]: '1' } } : undefined;
  };
  if (windows) {
    if (shell === 'pwsh.exe' || shell === 'powershell.exe') return pwsh(`try { . $env:${SCRIPT_ENV} } catch {}`);
    return shell === 'bash.exe' ? bash() : undefined;
  }
  switch (shell) {
    case 'bash':
      return bash();
    case 'pwsh':
      return pwsh(`. $env:${SCRIPT_ENV}`);
    case 'fish': {
      const env = { ...base, [SCRIPT_ENV]: join(scriptsDir, SHELL_INTEGRATION_SCRIPTS.fish) };
      const initCommand = ['--init-command', `source $${SCRIPT_ENV}`];
      if (args.length === 0) return { args: initCommand, env };
      return areShLoginArgs(args) ? { args: ['-l', ...initCommand], env } : undefined;
    }
    case 'zsh': {
      const newArgs = args.length === 0 ? ['-i'] : areShLoginArgs(args) ? ['-il'] : undefined;
      if (!newArgs) return undefined;
      // zsh's startup files in ZDOTDIR source the user's own from DAMOCLES_USER_ZDOTDIR.
      return {
        args: newArgs,
        env: { ...base, ZDOTDIR: request.zshDotDir, [USER_ZDOTDIR_ENV]: request.env['ZDOTDIR'] ?? request.homedir },
        filesToCopy: ZSH_DOTFILES.map(([script, dotfile]) => ({ source: join(scriptsDir, script), dest: join(request.zshDotDir, dotfile) })),
      };
    }
    default:
      return undefined;
  }
}
