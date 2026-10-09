import type { ClipboardService } from '../../platform/clipboard-service';
import type { SettingsTarget } from '../../shared/settings-sections';
import { OVERLAY_CHANNELS, type OverlayRequest } from '../preload/overlay-channels';
import type { UpdateAction, VersionInfo } from '../preload/updates';
import { isVersion, type ReleaseNotesSource } from './release-notes';
import { versionInfoText, type UpdateService } from './updater';

export interface AboutOverlay {
  handle(channel: string, handler: (...args: unknown[]) => unknown): void;
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

/** Settings › About's channels, each refused unless the settings modal is open. */
export function handleAboutChannels(overlay: AboutOverlay, deps: AboutDeps): void {
  const whileOpen = <A extends unknown[], R>(act: (...args: A) => R) => (...args: A): R => {
    if (!overlay.isOpen('settings')) throw new Error('The settings are not open');
    return act(...args);
  };
  const { updates, releaseNotes } = deps;
  overlay.handle(OVERLAY_CHANNELS.updateGet, whileOpen(() => updates.snapshot()));
  overlay.handle(OVERLAY_CHANNELS.updateCheck, whileOpen(() => updates.check('about')));
  overlay.handle(OVERLAY_CHANNELS.updateRestart, whileOpen(() => updates.restart()));
  overlay.handle(OVERLAY_CHANNELS.updateShowLog, whileOpen(() => deps.showLog()));
  overlay.handle(OVERLAY_CHANNELS.updateCopyInfo, whileOpen(() => deps.clipboard.writeText(versionInfoText(deps.versionInfo()))));
  overlay.handle(OVERLAY_CHANNELS.updateVersionInfo, whileOpen(() => deps.versionInfo()));
  overlay.handle(OVERLAY_CHANNELS.updateOpenReleasePage, whileOpen(() => updates.openReleasePage()));
  overlay.handle(OVERLAY_CHANNELS.releaseNotesIndex, whileOpen(() => releaseNotes.index()));
  overlay.handle(OVERLAY_CHANNELS.releaseNotesGet, whileOpen(async (version: unknown) => {
    if (!isVersion(version) || !(await releaseNotes.has(version))) throw new Error('Not a version of the release index');
    return releaseNotes.notes(version);
  }));
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
