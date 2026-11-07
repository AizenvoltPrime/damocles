import { describe, expect, it } from 'vitest';
import { SDK_SAFE_MAX_DIMENSION } from '../../browser/page-controller';
import { MAX_RENDER_IMAGE_SIDE, renderScale } from '../../../shared/design-render';

describe('design render caps (PD-41)', () => {
  it('caps every image at the side browser screenshots use', () => {
    expect(MAX_RENDER_IMAGE_SIDE).toBe(SDK_SAFE_MAX_DIMENSION);
  });

  it('takes the largest scale up to 2 that keeps the frame within 1950 px', () => {
    expect(renderScale(390, 900, 2)).toBe(2);
    expect(renderScale(1280, 900, 2)).toBe(1.523);
    expect(renderScale(2560, 900, 2) * 2560).toBeLessThanOrEqual(1950);
    expect(renderScale(390, 300, 1)).toBe(1);
    for (const width of [320, 640, 768, 1024, 1280, 1536, 1920, 2560]) expect(Math.round(width * renderScale(width, 900, 2))).toBeLessThanOrEqual(1950);
  });
});
