import { describe, expect, it } from 'vitest';
import { SDK_SAFE_MAX_DIMENSION } from '../../browser/page-controller';
import type { DesignPreviewHost } from '../../../platform/design-preview';
import { DEFAULT_RENDER_IMAGE_TARGET, DEFAULT_RENDER_MEDIA, DESIGN_RENDER_CLIENT_ABSENT, DESIGN_RENDER_PREDATES, DESIGN_RENDER_UPDATE_NEEDED, imageSize, MAX_RENDER_IMAGE_SIDE, renderImageTarget, renderScale } from '../../../shared/design-render';
import type { DesignRenderRequest } from '../../../shared/types/design';
import { asksBeyondCapture, renderForModel } from '../model-render';
import { prepareScreenshotArguments } from '../tools/design-screenshot';
import { DesignRenderUnavailableError } from '../width-checks';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

// SOI, an APP0 segment of 16 bytes, a DQT segment, then a progressive SOF2 of width × height
function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(4 + 16 + 4 + 2 + 19);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
  bytes.set([0xff, 0xdb, 0, 4, 0, 0], 20);
  bytes.set([0xff, 0xc2, 0, 17, 8], 26);
  new DataView(bytes.buffer).setUint16(31, height);
  new DataView(bytes.buffer).setUint16(33, width);
  return bytes;
}

const request: DesignRenderRequest = { width: 390, state: null, media: DEFAULT_RENDER_MEDIA, format: 'jpeg', maxSide: 1568, quality: 80 };

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

  it('keeps the long side within the model\'s own bound, never past 1950 px', () => {
    expect(Math.round(1440 * renderScale(1440, 900, 2, 1568))).toBeLessThanOrEqual(1568);
    expect(renderScale(1440, 900, 2, 4000)).toBe(renderScale(1440, 900, 2));
  });
});

describe('the model\'s image target (D85)', () => {
  it('reads the published resize profile, else the default target', () => {
    expect(renderImageTarget({ inputLimits: { images: { resize: { maxWidth: 1568, maxHeight: 1568, maxBytes: 4_718_592, jpegQuality: 70 } } } })).toEqual({ maxSide: 1568, quality: 70, maxBytes: 4_718_592 });
    // pi's catalog publishes 2000 × 2000 for every image model that sets a profile; the cap stays 1950
    expect(renderImageTarget({ inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000 } } } })).toEqual({ maxSide: MAX_RENDER_IMAGE_SIDE, quality: 80 });
    expect(renderImageTarget(undefined)).toEqual({ maxSide: DEFAULT_RENDER_IMAGE_TARGET.maxSide, quality: DEFAULT_RENDER_IMAGE_TARGET.jpegQuality });
    expect(renderImageTarget({ inputLimits: {} })).toEqual({ maxSide: 1568, quality: 80 });
    expect(renderImageTarget({ inputLimits: { images: { resize: { maxWidth: 0, maxHeight: -1 } } } })).toEqual({ maxSide: MAX_RENDER_IMAGE_SIDE, quality: 80 });
    expect(renderImageTarget({ inputLimits: { images: { resize: { maxWidth: 0, maxHeight: 1200 } } } })).toEqual({ maxSide: 1200, quality: 80 });
  });
});

describe('imageSize', () => {
  it('reads a PNG\'s IHDR and a JPEG\'s start of frame past the segments before it, and refuses anything else', () => {
    expect(imageSize(png(1950, 1371), 'image/png')).toEqual({ width: 1950, height: 1371 });
    expect(imageSize(jpeg(1567, 979), 'image/jpeg')).toEqual({ width: 1567, height: 979 });
    expect(() => imageSize(png(10, 10), 'image/jpeg')).toThrow('not a JPEG');
    expect(() => imageSize(jpeg(10, 10), 'image/png')).toThrow('not a PNG');
    expect(() => imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 200]), 'image/jpeg')).toThrow('not a JPEG');
  });
});

describe('renderForModel', () => {
  const host = (overrides: Partial<DesignPreviewHost>): DesignPreviewHost & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      open: async () => true,
      changed: () => undefined,
      probe: () => Promise.reject(new Error('unused')),
      journey: () => Promise.reject(new Error('unused')),
      replayJourney: () => Promise.reject(new Error('unused')),
      render: async () => {
        asked.push('render');
        return { frames: [{ image: jpeg(780, 1800), mimeType: 'image/jpeg', cssWidth: 390, cssHeight: 900, top: 0 }], contentHeight: 1200, scale: 2, moving: false };
      },
      capture: async (_designId, _relPath, width) => {
        asked.push('capture');
        return { png: png(width * 2, 1800), cssWidth: width, cssHeight: 900, contentHeight: 1200, scale: 2 };
      },
      ...overrides,
    };
  };
  const absent = (): Promise<never> => Promise.reject(new Error(DESIGN_RENDER_CLIENT_ABSENT));
  const predates = (): Promise<never> => Promise.reject(new Error(DESIGN_RENDER_PREDATES));
  const signal = new AbortController().signal;

  it('renders through design.render when the app has it', async () => {
    const app = host({});
    expect(await renderForModel(app, 'd-1', 'screens/S1.html', request, signal)).toMatchObject({ legacy: false, frames: [{ mimeType: 'image/jpeg' }] });
    expect(app.asked).toEqual(['render']);
  });

  it('takes the plain capture from an app without design.render, as PNG with the media unpinned (acceptance)', async () => {
    const older = host({ render: predates });
    const shot = await renderForModel(older, 'd-1', 'screens/S1.html', request, signal);
    expect(shot).toMatchObject({ legacy: true, moving: false, frames: [{ mimeType: 'image/png', cssWidth: 390, cssHeight: 900, top: 0 }] });
    expect(older.asked).toEqual(['capture']);
  });

  it('names the update when a call asks for what only design.render does, and the absence when no app renders (acceptance)', async () => {
    for (const asked of [{ ...request, media: { ...DEFAULT_RENDER_MEDIA, colorScheme: 'dark' as const } }, { ...request, region: 'fullPage' as const }, { ...request, region: { selector: '#tasks' } }, { ...request, steps: [{ action: 'click' as const, target: { role: 'button', name: 'More' } }] }]) {
      expect(asksBeyondCapture(asked)).toBe(true);
      await expect(renderForModel(host({ render: predates }), 'd-1', 'screens/S1.html', asked, signal)).rejects.toThrow(DESIGN_RENDER_UPDATE_NEEDED);
      // with no app attached, the refusal names no update
      const none = host({ render: absent });
      await expect(renderForModel(none, 'd-1', 'screens/S1.html', asked, signal)).rejects.toBeInstanceOf(DesignRenderUnavailableError);
      expect(none.asked).toEqual([]);
    }
    expect(asksBeyondCapture(request)).toBe(false);
    await expect(renderForModel(host({ render: absent }), 'd-1', 'screens/S1.html', request, signal)).rejects.toBeInstanceOf(DesignRenderUnavailableError);
    await expect(renderForModel(host({ render: predates, capture: absent }), 'd-1', 'screens/S1.html', request, signal)).rejects.toBeInstanceOf(DesignRenderUnavailableError);
    await expect(renderForModel(host({ render: () => Promise.reject(new Error('page crashed')) }), 'd-1', 'screens/S1.html', request, signal)).rejects.toThrow('page crashed');
  });
});

describe('DesignScreenshot arguments', () => {
  it('turn malformed steps into one sentence naming the step and field, never a validator dump (acceptance)', () => {
    expect(() => prepareScreenshotArguments({ steps: [{ action: 'click', target: { selector: '.more' } }] })).toThrow('DesignScreenshot captured nothing: step 1: target must be exactly one of {role, name}, {label}, {placeholder} or {text}, with an optional exact; never a CSS selector.');
    expect(prepareScreenshotArguments({ steps: [{ action: 'click', target: { role: 'button', name: 'More' } }] })).toEqual({ steps: [{ action: 'click', target: { role: 'button', name: 'More' } }] });
    expect(prepareScreenshotArguments({ fullPage: true })).toEqual({ fullPage: true });
  });
});
