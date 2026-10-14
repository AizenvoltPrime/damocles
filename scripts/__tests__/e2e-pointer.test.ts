import { describe, expect, it } from 'vitest';
import { parkingSpot } from '../../e2e/desktop/support/pointer';

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea };
const main = { x: 240, y: 70, width: 1440, height: 900 };

describe('e2e pointer parking spot', () => {
  it('parks left of the main window, at its middle, clear of its resize border', () => {
    expect(parkingSpot(main, [main], display)).toEqual({ x: 216, y: 520 });
  });

  it('tries right, above and below when a side is off the display or under another app window', () => {
    const leftEdge = { ...main, x: 0 };
    expect(parkingSpot(leftEdge, [leftEdge], display)).toEqual({ x: 1464, y: 520 });
    // the notification popup sits right of the window, so the spot moves above it
    const popup = { x: 1450, y: 400, width: 400, height: 200 };
    expect(parkingSpot(leftEdge, [leftEdge, popup], display)).toEqual({ x: 720, y: 46 });
    const wide = { x: 0, y: 0, width: 1920, height: 900 };
    expect(parkingSpot(wide, [wide], display)).toEqual({ x: 960, y: 924 });
  });

  it('parks in the taskbar when the window fills the work area, as on a 1024x768 Windows runner', () => {
    const runner = { bounds: { x: 0, y: 0, width: 1024, height: 768 }, workArea: { x: 0, y: 0, width: 1024, height: 728 } };
    expect(parkingSpot(runner.workArea, [runner.workArea], runner)).toEqual({ x: 512, y: 748 });
  });

  it('parks in the menu bar when a window wider than the display fills its height, as on a 1024x768 macOS runner', () => {
    const runner = { bounds: { x: 0, y: 0, width: 1024, height: 768 }, workArea: { x: 0, y: 25, width: 1024, height: 677 } };
    const wide = { x: 0, y: 25, width: 1400, height: 677 };
    expect(parkingSpot(wide, [wide], runner)).toEqual({ x: 512, y: 12 });
  });

  it('finds no spot when the window covers a display that has no bars', () => {
    const bare = { bounds: workArea, workArea };
    expect(parkingSpot(workArea, [workArea], bare)).toBeUndefined();
  });
});
