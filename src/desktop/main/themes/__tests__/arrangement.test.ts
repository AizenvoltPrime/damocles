import { describe, expect, it } from 'vitest';
import { arrangementRoom } from '../arrangement';

const DEFAULT = { width: 1280, height: 800 };

describe('the room an arrangement is clamped to', () => {
  it("is the window's content size in CSS px at its zoom", () => {
    expect(arrangementRoom({ width: 1800, height: 1200, zoom: 1.5 }, { width: 900, height: 700 }, DEFAULT)).toEqual({ width: 1200, height: 800 });
  });

  // A launch puts back the arrangement from before an unsettled change before the window exists.
  it('is the size the saved placement opens the window at while there is no window', () => {
    expect(arrangementRoom(undefined, { width: 2560, height: 1400 }, DEFAULT)).toEqual({ width: 2560, height: 1400 });
  });

  it('is the default window size only when no placement was saved', () => {
    expect(arrangementRoom(undefined, undefined, DEFAULT)).toEqual(DEFAULT);
  });
});
