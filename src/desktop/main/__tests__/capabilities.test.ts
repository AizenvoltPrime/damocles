import { describe, expect, it } from 'vitest';
import { desktopHostCapabilities } from '../platform/capabilities';

describe('desktop host capabilities', () => {
  it('hides voice on macOS only, routes settings to the overlay modal and renders editors with Monaco', () => {
    expect(desktopHostCapabilities('darwin').voice).toBe(false);
    expect(desktopHostCapabilities('win32').voice).toBe(true);
    expect(desktopHostCapabilities('linux')).toEqual({
      voice: true,
      hostSpeechExtensions: false,
      hostSettingsEditor: false,
      diffReview: true,
      settingsSources: true,
      monaco: true,
      ideContext: false,
      damoclesTheme: true,
      settingsInPanel: false,
      historyInPanel: false,
      folderPickerInPanel: false,
    });
  });
});
