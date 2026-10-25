import { describe, expect, it } from 'vitest';
import { VOICE_VIEW_MESSAGES, VOICE_VIEW_POSTS } from '../remote-user';

describe('the voice messages a remote chat\'s view exchanges with this computer\'s core', () => {
  // only what the chat page sends: voice settings, keys, downloads and installs change in the User tab, never through a foreign view
  it('VOICE_VIEW_MESSAGES is exactly the chat page\'s voice messages', () => {
    expect([...VOICE_VIEW_MESSAGES].sort()).toEqual([
      'cancelVoiceRecording',
      'requestVoiceConfig',
      'startVoiceRecording',
      'stopVoiceRecording',
      'voiceAcceptFirstRunModal',
      'voiceAcceptModelUpgrade',
      'voiceCancelFirstRunModal',
      'voiceCancelModelDownload',
      'voiceDismissModelUpgrade',
      'voiceStreamDisable',
      'voiceStreamEnable',
      'voiceStreamMute',
      'voiceWebviewMicUnavailable',
    ]);
  });

  it('VOICE_VIEW_POSTS names only voice posts', () => {
    expect([...VOICE_VIEW_POSTS].every((type) => type.startsWith('voice') || type.startsWith('transcription'))).toBe(true);
    expect(VOICE_VIEW_POSTS.size).toBe(22);
  });
});
