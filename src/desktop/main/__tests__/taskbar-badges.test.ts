import { beforeEach, describe, expect, it, vi } from 'vitest';

// nativeImage decodes the PNG's own size; a buffer that is no PNG decodes empty, as Chromium's does.
vi.mock('electron', () => {
  class FakeImage {
    readonly width: number;
    readonly height: number;
    readonly kind: 'png' | 'bitmap' | 'empty';
    constructor(width: number, height: number, kind: 'png' | 'bitmap' | 'empty') {
      this.width = width;
      this.height = height;
      this.kind = kind;
    }
    isEmpty(): boolean {
      return this.kind === 'empty';
    }
    getSize(): { width: number; height: number } {
      return { width: this.width, height: this.height };
    }
  }
  return {
    nativeImage: {
      createFromBuffer: (png: Buffer) => (png.length > 24 && png.toString('latin1', 12, 16) === 'IHDR'
        ? new FakeImage(png.readUInt32BE(16), png.readUInt32BE(20), 'png')
        : new FakeImage(0, 0, 'empty')),
      createFromBitmap: (_pixels: Buffer, size: { width: number; height: number }) => new FakeImage(size.width, size.height, 'bitmap'),
    },
  };
});

import type { RasterArt } from '../../preload/overlay-channels';
import { TaskbarBadges, type TaskbarBadgesDeps } from '../taskbar-badges';
import { pngFixture } from './png-fixture';

let drawn: RasterArt[];
let scale: number;

function badges(overrides: Partial<TaskbarBadgesDeps> = {}): TaskbarBadges {
  return new TaskbarBadges({
    rasterize: async (art) => {
      drawn.push(art);
      return pngFixture(art.width, art.height);
    },
    scaleFactor: () => scale,
    colors: { fill: '#cd333a', text: '#ffffff' },
    log: () => undefined,
    ...overrides,
  });
}

beforeEach(() => {
  drawn = [];
  scale = 1;
});

describe('taskbar badge images', () => {
  it('draws each label once, at 16 px times the display scale, as the one image Windows gets', async () => {
    scale = 1.5;
    const service = badges();
    const image = await service.badge('4') as unknown as { width: number; height: number };
    expect(drawn.map((art) => [art.width, art.scale])).toEqual([[24, 1.5]]);
    expect(image).toMatchObject({ width: 24, height: 24 });
    expect(await service.badge('4')).toBe(image);
    expect(drawn).toHaveLength(1);
    // A new display scale draws it again at that size.
    scale = 1;
    expect(await service.badge('4')).toMatchObject({ width: 16, height: 16 });
    expect(drawn.map((art) => art.width)).toEqual([24, 16]);
  });

  it('shows a plain dot when the overlay refuses or misdraws the badge, and draws it again for the next count', async () => {
    expect(await badges({ rasterize: async () => undefined }).badge('9+')).toMatchObject({ kind: 'bitmap', width: 16 });
    scale = 2;
    expect(await badges({ rasterize: async () => undefined }).badge('9+')).toMatchObject({ kind: 'bitmap', width: 32 });
    scale = 1;
    expect(await badges({ rasterize: async () => pngFixture(20, 20) }).badge('1')).toMatchObject({ kind: 'bitmap' });
    let calls = 0;
    const flaky = badges({ rasterize: async (art) => (calls++ < 1 ? undefined : pngFixture(art.width, art.height)) });
    expect(await flaky.badge('1')).toMatchObject({ kind: 'bitmap' });
    expect(await flaky.badge('1')).toMatchObject({ kind: 'png' });
  });
});
