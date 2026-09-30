import type { HostCapabilities } from '../../../shared/types/messages';

// macOS builds are ad hoc signed, and such an app gets no microphone input and no prompt, so voice is hidden there.
export function desktopHostCapabilities(platform: NodeJS.Platform): HostCapabilities {
  return {
    voice: platform !== 'darwin',
    hostSpeechExtensions: false,
    hostSettingsEditor: false,
    markdownPreview: false,
    diffReview: true,
    settingsSources: true,
    monaco: true,
    ideContext: false,
  };
}
