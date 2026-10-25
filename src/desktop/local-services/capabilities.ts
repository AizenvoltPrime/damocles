import type { ClientPolicy } from '../../shared/remote-user';
import type { HostCapabilities } from '../../shared/types/messages';

// macOS builds are ad hoc signed, and such an app gets no microphone input and no prompt, so voice is hidden there.
export function desktopHostCapabilities(platform: NodeJS.Platform): HostCapabilities {
  return {
    voice: platform !== 'darwin',
    hostSpeechExtensions: false,
    hostSettingsEditor: false,
    diffReview: true,
    settingsSources: true,
    monaco: true,
    ideContext: true,
    damoclesTheme: true,
    settingsInPanel: false,
    historyInPanel: false,
    folderPickerInPanel: false,
    fileMentionDrop: true,
    windowLayout: true,
    chatReview: true,
    worktrees: true,
  };
}

/** A daemon's core: voice runs on the client, and YOLO only where the client's policy allows it. */
export function remoteHostCapabilities(capabilities: HostCapabilities, policy: ClientPolicy | undefined): HostCapabilities {
  return { ...capabilities, voice: policy?.voice === true, bypassPermissions: policy?.allowBypass === true };
}
