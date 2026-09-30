import { describe, expect, it } from 'vitest';
import { desktopHostCapabilities } from '../platform/capabilities';

describe('desktop host capabilities', () => {
  it('hides voice on macOS only, routes settings to the in-app panel and renders editors with Monaco', () => {
    expect(desktopHostCapabilities('darwin').voice).toBe(false);
    expect(desktopHostCapabilities('win32').voice).toBe(true);
    expect(desktopHostCapabilities('linux')).toEqual({
      voice: true,
      hostSpeechExtensions: false,
      hostSettingsEditor: false,
      markdownPreview: false,
      diffReview: true,
      settingsSources: true,
      monaco: true,
      ideContext: false,
    });
  });
});
