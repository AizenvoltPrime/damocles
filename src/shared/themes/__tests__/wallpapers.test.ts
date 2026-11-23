import { describe, expect, it } from 'vitest';
import { decodedDurationRefused, isFlashRecord, MAX_VIDEO_MS, VIDEO_DURATION_TOLERANCE_MS } from '../wallpapers';

describe('decodedDurationRefused', () => {
  it('refuses a video that decodes longer than the cap or than its header declared', () => {
    expect(decodedDurationRefused(MAX_VIDEO_MS + VIDEO_DURATION_TOLERANCE_MS + 1, undefined)).toBe(true);
    expect(decodedDurationRefused(30_000, 5_000)).toBe(true);
    expect(decodedDurationRefused(Number.POSITIVE_INFINITY, 5_000)).toBe(true);
  });

  it('takes a video as long as it declared, within what a container and a decoder round apart', () => {
    expect(decodedDurationRefused(5_000 + VIDEO_DURATION_TOLERANCE_MS, 5_000)).toBe(false);
    expect(decodedDurationRefused(4_000, 5_000)).toBe(false);
    expect(decodedDurationRefused(MAX_VIDEO_MS, undefined)).toBe(false);
  });
});

describe('isFlashRecord', () => {
  it('takes a flash at any whole millisecond: an animated image has no duration cap', () => {
    expect(isFlashRecord({ flagged: true, atMs: MAX_VIDEO_MS + 30_000, kind: 'general' })).toBe(true);
    expect(isFlashRecord({ flagged: true, atMs: 0, kind: 'red', allowed: true })).toBe(true);
    expect(isFlashRecord({ flagged: false })).toBe(true);
  });

  it.each([1.5, -1, 1e300, Number.NaN, Number.POSITIVE_INFINITY, '5', null])('refuses a time of %s', (atMs) => {
    expect(isFlashRecord({ flagged: true, atMs })).toBe(false);
  });

  it('refuses anything else that is no record', () => {
    expect(isFlashRecord(null)).toBe(false);
    expect(isFlashRecord({ flagged: 'yes' })).toBe(false);
    expect(isFlashRecord({ flagged: true, kind: 'blue' })).toBe(false);
    expect(isFlashRecord({ flagged: true, allowed: 1 })).toBe(false);
  });
});
