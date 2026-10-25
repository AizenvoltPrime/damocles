import { describe, expect, it } from 'vitest';
import { MAX_PLAN_MODEL_ID_CHARS, MAX_PLAN_MODEL_IDS, planModelIdsOf, VOICE_VIEW_MESSAGES, VOICE_VIEW_POSTS } from '../remote-user';

// One rule for every reader and sender, so a local and a remote core never gate one credential differently.
describe('planModelIdsOf', () => {
  it('takes a list of ids within the bounds whole', () => {
    const ids = Array.from({ length: MAX_PLAN_MODEL_IDS }, (_, i) => `m${i}`);
    expect(planModelIdsOf(ids)).toEqual(ids);
    expect(planModelIdsOf(['x'.repeat(MAX_PLAN_MODEL_ID_CHARS)])).toEqual(['x'.repeat(MAX_PLAN_MODEL_ID_CHARS)]);
    expect(planModelIdsOf([])).toEqual([]);
  });

  it('takes any other value as no list, never a part of one', () => {
    const tooMany = Array.from({ length: MAX_PLAN_MODEL_IDS + 1 }, (_, i) => `m${i}`);
    for (const value of [tooMany, ['x'.repeat(MAX_PLAN_MODEL_ID_CHARS + 1)], [''], ['gpt-6-luna', 7], 'gpt-6-luna', undefined, null]) {
      expect(planModelIdsOf(value)).toBeUndefined();
    }
  });
});

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
