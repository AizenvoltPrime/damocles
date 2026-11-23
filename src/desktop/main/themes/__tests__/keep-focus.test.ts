import { describe, expect, it } from 'vitest';
import { KeepFocus } from '../keep-focus';

describe('KeepFocus', () => {
  it('gives focus back to the part F6 took it from when the countdown ends with focus on the banner', () => {
    const focus = new KeepFocus<string>();
    focus.entered('sidebar');
    expect(focus.ended(true, 'chat')).toBe('sidebar');
    expect(focus.ended(true, 'chat')).toBe('chat');
  });

  it('moves nothing when focus is not on the banner as the countdown ends', () => {
    const focus = new KeepFocus<string>();
    focus.entered('editor');
    expect(focus.ended(false, 'chat')).toBeUndefined();
  });

  it('forgets the part once focus left the banner, so a later click on the banner ends on the fallback', () => {
    const focus = new KeepFocus<string>();
    focus.entered('terminal');
    focus.left();
    expect(focus.ended(true, 'chat')).toBe('chat');
  });
});
