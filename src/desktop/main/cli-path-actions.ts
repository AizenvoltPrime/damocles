import type { CliPath, MacCliPathResult, WindowsCliPathResult } from './cli-path';
import type { NoticeSeverity } from '../preload/notifications';

type Translate = (message: string, ...args: string[]) => string;
type Outcome = { readonly severity: NoticeSeverity; readonly message: string } | undefined;

// Windows: add and remove edit the user's Path; each result says what PATH holds now.
function windowsOutcome(result: WindowsCliPathResult, t: Translate): NonNullable<Outcome> {
  switch (result) {
    case 'added': return { severity: 'info', message: t('The \'damocles\' command is on your PATH. Open a new terminal and run damocles . in any folder, or in WSL.') };
    case 'alreadyPresent': return { severity: 'info', message: t('The \'damocles\' command is already on your PATH.') };
    case 'keptRemoved': return { severity: 'info', message: t('The \'damocles\' command stays off your PATH, as you removed it earlier.') };
    case 'removed': return { severity: 'info', message: t('The \'damocles\' command is no longer on your PATH. Terminals you open from now on will not find it.') };
    case 'notPresent': return { severity: 'info', message: t('The \'damocles\' command was not on your PATH.') };
  }
}

// macOS: a link in /usr/local/bin.
function macOutcome(result: Exclude<MacCliPathResult, 'cancelled'>, t: Translate): NonNullable<Outcome> {
  switch (result) {
    case 'installed': return { severity: 'info', message: t('The \'damocles\' command is installed. Open a new terminal and run damocles . in any folder.') };
    case 'alreadyInstalled': return { severity: 'info', message: t('The \'damocles\' command is already installed.') };
    case 'uninstalled': return { severity: 'info', message: t('The \'damocles\' command is uninstalled.') };
    case 'notInstalled': return { severity: 'info', message: t('The \'damocles\' command was not installed.') };
    case 'notOurs': return { severity: 'warning', message: t('/usr/local/bin/damocles belongs to another program, so Damocles left it in place.') };
  }
}

export interface CliPathActionsDeps {
  readonly cliPath: CliPath;
  readonly platform: 'win32' | 'darwin';
  readonly t: Translate;
  readonly notice: (severity: NoticeSeverity, message: string) => void;
  readonly log: (line: string) => void;
}

/** The palette's PATH commands (MenuActions.cliCommand): each runs as the user's own choice and tells its outcome as a notice. */
export function cliPathActions(deps: CliPathActionsDeps): { install(): void; uninstall(): void } {
  const run = (action: string, edit: () => Promise<Outcome>): void => {
    edit().then((outcome) => {
      deps.log(`[cli-path] ${action}: ${outcome === undefined ? 'cancelled' : 'done'}`);
      if (outcome) deps.notice(outcome.severity, outcome.message);
    }, (err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      deps.log(`[cli-path] ${action} failed: ${reason}`);
      deps.notice('error', deps.t('Damocles could not change the \'damocles\' command: {0}', reason));
    });
  };
  if (deps.platform === 'win32') {
    return {
      install: () => run('add', async () => windowsOutcome(await deps.cliPath.add('user'), deps.t)),
      uninstall: () => run('remove', async () => windowsOutcome(await deps.cliPath.remove('user'), deps.t)),
    };
  }
  // a cancelled administrator prompt says nothing
  const mac = (result: MacCliPathResult): Outcome => (result === 'cancelled' ? undefined : macOutcome(result, deps.t));
  return {
    install: () => run('install', async () => mac(await deps.cliPath.install())),
    uninstall: () => run('uninstall', async () => mac(await deps.cliPath.uninstall())),
  };
}
