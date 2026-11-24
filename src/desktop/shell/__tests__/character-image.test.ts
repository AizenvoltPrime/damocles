// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { CharacterFrameView } from '@shared/themes/characters';
import CharacterImage from '../components/CharacterImage.vue';

// One state of a character: a strip steps through d-sprite while it moves, and `frame` holds it on one frame, still, as the
// character sheet draws each frame of a strip side by side.

const STRIP: CharacterFrameView = { url: 'app://damocles/theme-blob/strip', strip: { frameWidth: 10, frameHeight: 12, frames: 4, fps: 4 }, moves: true, playable: true };
const STILL: CharacterFrameView = { url: 'app://damocles/theme-blob/gif', still: 'app://damocles/theme-cache/gif/still.png', moves: true, playable: true };

const image = (props: Record<string, unknown>) => mount(CharacterImage, { props: { image: STRIP, alt: '', moves: true, ...props } }).find('img');

describe('CharacterImage', () => {
  it('steps a moving strip through its frames', () => {
    const img = image({});
    expect(img.classes()).toContain('d-sprite');
    expect(img.attributes('style')).toContain('--sprite-frames: 4');
    expect(img.attributes('data-sprite-frame')).toBeUndefined();
  });

  it('holds a strip on the frame named, still, whatever moves says', () => {
    for (const [frame, shift] of [[0, '0%'], [1, '25%'], [3, '75%']] as const) {
      const img = image({ frame });
      expect(img.classes()).not.toContain('d-sprite');
      expect(img.attributes('style')).toContain(`translateX(-${shift})`);
      expect(img.attributes('style')).not.toContain('--sprite-frames');
      expect(img.attributes('data-sprite-frame')).toBe(String(frame));
    }
    // a frame past the strip's end shows its last frame
    expect(image({ frame: 9 }).attributes('style')).toContain('translateX(-75%)');
  });

  it("shows an image that is no strip as it would without a frame: an animated one's still frame while it does not move", () => {
    const img = image({ image: STILL, moves: false, frame: 2 });
    expect(img.attributes('src')).toBe(STILL.still);
    expect(img.attributes('data-sprite-frame')).toBeUndefined();
  });
});
