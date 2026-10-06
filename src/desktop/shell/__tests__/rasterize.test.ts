// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import type { RasterArt } from '../../preload/overlay-channels';
import { installRasterizer, rasterize } from '../overlay/rasterize';
import { fakeOverlayApi } from './fakes';

const ART: RasterArt = { width: 16, height: 16, scale: 1, ops: [] };

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty('--d-font');
});

describe('rasterize', () => {
  it('loads the font before it draws, and centres the text on its point by the ink box, on a whole-pixel baseline', async () => {
    const calls: string[] = [];
    const context = {
      font: '',
      fillStyle: '',
      textAlign: '',
      textBaseline: '',
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
      measureText: () => ({ actualBoundingBoxLeft: -1, actualBoundingBoxRight: 9, actualBoundingBoxAscent: 7.2, actualBoundingBoxDescent: 0.2 }),
      fillText: (text: string, x: number, y: number) => calls.push(`fillText ${text} ${x} ${y} ${context.font} ${context.fillStyle} ${context.textBaseline}`),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback: BlobCallback) => callback(new Blob([new Uint8Array([137, 80])])));
    const load = vi.fn(async (font: string, text?: string) => {
      calls.push(`load ${font} ${text}`);
      return [];
    });
    Object.defineProperty(document, 'fonts', { value: { load }, configurable: true });
    document.documentElement.style.setProperty('--d-font', 'Geist Variable');

    const png = await rasterize({ width: 32, height: 32, scale: 2, ops: [{ kind: 'text', text: '9+', x: 8, y: 8, size: 9, weight: 700, color: '#ffffff' }] });

    expect(png).toEqual(new Uint8Array([137, 80]));
    // x: 16 - (9 - -1) / 2; y: 16 + (7.2 - 0.2) / 2, rounded.
    expect(calls).toEqual(['save', 'load 700 18px Geist Variable 9+', 'fillText 9+ 11 20 700 18px Geist Variable #ffffff alphabetic', 'restore']);
  });
});

describe('overlay rasterizer (D52)', () => {
  it('answers each of main\'s requests with the PNG it drew, and null when drawing fails', async () => {
    const api = fakeOverlayApi();
    const png = new Uint8Array([1, 2, 3]);
    const draw = vi.fn(async (art: RasterArt) => {
      if (art.width === 0) throw new Error('no canvas');
      return png;
    });
    installRasterizer(api, draw);
    api.rasterizeRequest({ id: 'r1', art: ART });
    api.rasterizeRequest({ id: 'r2', art: { ...ART, width: 0 } });
    await flushPromises();
    expect(draw).toHaveBeenCalledWith(ART);
    expect(api.rasterized).toHaveBeenCalledWith('r1', png);
    expect(api.rasterized).toHaveBeenCalledWith('r2', null);
  });
});
