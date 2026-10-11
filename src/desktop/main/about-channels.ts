import type { ClipboardService } from '../../platform/clipboard-service';
import type { SettingsTarget } from '../../shared/settings-sections';
import { OVERLAY_CHANNELS, type OverlayRequest } from '../preload/overlay-channels';
import type { UpdateAction, VersionInfo } from '../preload/updates';
import { isVersion, type ReleaseNotesSource } from './release-notes';
import { versionInfoText, type UpdateService } from './updater';

export interface AboutOverlay {
  handleWhileOpen<T>(channel: string, isOpen: () => boolean, handler: (...args: unknown[]) => T | Promise<T>): void;
  isOpen(kind: OverlayRequest['kind']): boolean;
}

export interface AboutDeps {
  readonly updates: UpdateService;
  readonly releaseNotes: ReleaseNotesSource;
  readonly versionInfo: () => VersionInfo;
  readonly clipboard: ClipboardService;
  // the existing Show Log path
  readonly showLog: () => void;
  readonly openSettings: (target: SettingsTarget) => void;
}

/** Settings › About's channels, each answering closed unless the settings modal is open. */
export function handleAboutChannels(overlay: AboutOverlay, deps: AboutDeps): void {
  const settingsOpen = (): boolean => overlay.isOpen('settings');
  const whileSettingsOpen = <T>(channel: string, handler: (...args: unknown[]) => T | Promise<T>): void => overlay.handleWhileOpen(channel, settingsOpen, handler);
  const { updates, releaseNotes } = deps;
  whileSettingsOpen(OVERLAY_CHANNELS.updateGet, () => updates.snapshot());
  whileSettingsOpen(OVERLAY_CHANNELS.updateCheck, () => updates.check('about'));
  whileSettingsOpen(OVERLAY_CHANNELS.updateRestart, () => updates.restart());
  whileSettingsOpen(OVERLAY_CHANNELS.updateShowLog, () => deps.showLog());
  whileSettingsOpen(OVERLAY_CHANNELS.updateCopyInfo, () => deps.clipboard.writeText(versionInfoText(deps.versionInfo())));
  whileSettingsOpen(OVERLAY_CHANNELS.updateVersionInfo, () => deps.versionInfo());
  whileSettingsOpen(OVERLAY_CHANNELS.updateOpenReleasePage, () => updates.openReleasePage());
  whileSettingsOpen(OVERLAY_CHANNELS.releaseNotesIndex, () => releaseNotes.index());
  whileSettingsOpen(OVERLAY_CHANNELS.releaseNotesGet, async (version) => {
    if (!isVersion(version) || !(await releaseNotes.has(version))) throw new Error('Not a version of the release index');
    return releaseNotes.notes(version);
  });
}

/** The title-bar pill's action; restart, releasePage and releaseNotes are refused unless the update state offers them. */
export async function runUpdateAction(action: UpdateAction, deps: AboutDeps): Promise<void> {
  const kind = deps.updates.snapshot().state.kind;
  switch (action) {
    case 'restart':
      deps.updates.restart();
      return;
    case 'releasePage':
      await deps.updates.openReleasePage();
      return;
    case 'showLog':
      deps.showLog();
      return;
    case 'releaseNotes':
      if (kind !== 'ready' && kind !== 'available') throw new Error('No update has release notes');
      deps.openSettings({ section: 'about' });
  }
}
