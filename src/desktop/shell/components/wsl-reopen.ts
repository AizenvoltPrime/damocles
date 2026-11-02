import type { ShellPlatform, ShellProject, ReopenInWslResult } from '../../preload/shell-channels';
import type { WslDistroInfo } from '../../preload/overlay-channels';
import { visibleText } from '@shared/visible-text';
import { wslVersionName } from '../overlay/connect-text';

type Translate = (key: string, values?: Record<string, unknown>) => string;

/** The distro a local project's Reopen in WSL notice names, while the notice was not dismissed. */
export function wslNoticeDistro(project: Pick<ShellProject, 'authority' | 'wsl' | 'wslNoticeDismissed'>): string | undefined {
  if (project.authority.kind !== 'local' || project.wslNoticeDismissed) return undefined;
  return project.wsl?.distro;
}

// the drive paths main maps through wslpath (reopen-in-wsl.ts isWindowsDrivePath)
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\\/;

/** Whether a project offers Reopen in WSL... in its menu: a local folder on a Windows drive, on Windows. */
export function offersReopenInWsl(project: Pick<ShellProject, 'authority' | 'fsPath' | 'wsl'>, platform: ShellPlatform): boolean {
  return platform === 'win32' && project.authority.kind === 'local' && project.wsl === undefined && WINDOWS_DRIVE_PATH.test(project.fsPath);
}

/** A distro as the Reopen in WSL... pick describes it: "Running · Default · WSL 1". */
export function distroHint(distro: WslDistroInfo, t: Translate): string {
  return [
    t(`remote.distro.state.${distro.state}`),
    ...(distro.isDefault ? [t('remote.distro.default')] : []),
    ...(distro.version === 1 ? [wslVersionName(1)] : []),
  ].join(' · ');
}

/** A refused reopen in the user's language; wslpath's own text follows its failure, since it says what was wrong. */
export function reopenFailureText(result: Extract<ReopenInWslResult, { ok: false }>, names: { readonly name: string; readonly distro: string }, t: Translate): string {
  const text = t(`wsl.failure.${result.code}`, names);
  return result.code === 'wslpathFailed' && result.message !== undefined && result.message !== '' ? `${text} ${visibleText(result.message)}` : text;
}
