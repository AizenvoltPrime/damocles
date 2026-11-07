// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignFreeze } from '../../preload/shell-channels';
import { flattenMarkup, type MarkupColors } from '../editor/markup-flatten';
import { dropMarkupSession, newMarkId, startMarkupSession } from '../editor/markup-session';

// A capture of a 1280 px wide viewport at scale 2, shown 640 shell px wide: 4 image px per shell px on screen.
const FREEZE = {
  png: 'data:image/png;base64,iVBORw0KGgo=',
  imageWidth: 2560,
  imageHeight: 1800,
  width: 1280,
  height: 900,
  breakpoint: 'xl',
  zoom: 1,
  pixelRatio: 1,
  scale: 2,
  state: 'default',
  screen: 'S1',
  file: 'screens/S1.html',
  elements: [],
} satisfies DesignFreeze;
const COLORS: MarkupColors = { design: 'rgb(183, 148, 246)', onDesign: 'rgb(3, 18, 28)', designText: 'rgb(196, 166, 248)', bg: 'rgb(0, 0, 0)' };

type Call = [string, ...unknown[]];

/** A 2D context that records every method call and property write, in order. */
function recordingContext(): { context: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const written: Record<string, unknown> = {};
  const context = new Proxy(written, {
    get: (_, name: string) => (name in written ? written[name] : (...args: unknown[]) => { calls.push([name, ...args]); }),
    set: (_, name: string, value: unknown) => {
      written[name] = value;
      calls.push([`${name}=`, value]);
      return true;
    },
  });
  return { context: context as unknown as CanvasRenderingContext2D, calls };
}

const rounded = (calls: readonly Call[]): unknown[] => calls.map(([name, ...args]) => [name, ...args.map((arg) => {
  if (typeof arg === 'number') return Math.round(arg * 100) / 100;
  return typeof arg === 'object' && arg !== null ? '<image>' : arg;
})]);

let recorded: ReturnType<typeof recordingContext>;
beforeEach(() => {
  recorded = recordingContext();
  HTMLImageElement.prototype.decode = () => Promise.resolve();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => recorded.context as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,RkxBVA==');
});

afterEach(() => {
  dropMarkupSession('flat');
  vi.restoreAllMocks();
});

describe('the flattened markup PNG', () => {
  it('draws an arrow, a box and a pin at the capture\'s scale, sized as the layer shows them', async () => {
    const session = startMarkupSession('flat', FREEZE);
    session.marks = [
      { id: newMarkId(), type: 'arrow', points: [[100, 300], [300, 300]] },
      { id: newMarkId(), type: 'box', points: [[40, 60], [360, 140]] },
      { id: newMarkId(), type: 'pin', kind: 'change', text: 'Denser', at: [700, 200], anchor: null },
    ];

    expect(await flattenMarkup(session, 640, COLORS)).toBe('data:image/png;base64,RkxBVA==');

    const turn = 2 * Math.PI;
    expect(rounded(recorded.calls)).toEqual(rounded([
      ['drawImage', {}, 0, 0],
      // 2.5 px strokes on screen are 10 image px
      ['lineCap=', 'round'], ['lineJoin=', 'round'], ['lineWidth=', 10], ['strokeStyle=', COLORS.design],
      // the arrow's shaft, then its 12 px (48 image px) wings at ±28° from the shaft, both ending at the head
      ['beginPath'], ['moveTo', 200, 600], ['lineTo', 600, 600], ['moveTo', 557.62, 622.53], ['lineTo', 600, 600], ['lineTo', 557.62, 577.47], ['stroke'],
      // the box with its 3 px (12 image px) corners and its 8% fill
      ['beginPath'], ['roundRect', 80, 120, 640, 160, 12], ['globalAlpha=', 0.08], ['fillStyle=', COLORS.design], ['fill'], ['globalAlpha=', 1], ['stroke'],
      // a 1.5rem (96 image px) pin with its 2 px ring, numbered 1
      ['textAlign=', 'center'], ['textBaseline=', 'middle'], ['font=', 'bold 53px system-ui, sans-serif'],
      ['beginPath'], ['arc', 1400, 400, 56, 0, turn], ['fillStyle=', COLORS.bg], ['fill'],
      ['beginPath'], ['arc', 1400, 400, 48, 0, turn], ['fillStyle=', COLORS.design], ['fill'],
      ['fillStyle=', COLORS.onDesign], ['fillText', '1', 1400, 400],
    ]));
  });

  it('keeps a pin at the image\'s edge whole: its center stays inside by the pin and its ring', async () => {
    const session = startMarkupSession('flat', FREEZE);
    session.marks = [{ id: newMarkId(), type: 'pin', kind: 'note', text: '', at: [0, 900], anchor: null }];
    await flattenMarkup(session, 640, COLORS);
    const arcs = recorded.calls.filter(([name]) => name === 'arc').map(([, x, y]) => [x, y]);
    expect(arcs).toEqual([[56, 1744], [56, 1744], [56, 1744]]);
    expect(recorded.calls.find(([name]) => name === 'fillText')).toEqual(['fillText', '1', 56, 1744]);
  });
});
