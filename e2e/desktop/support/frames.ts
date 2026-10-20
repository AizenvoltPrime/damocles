import type { ElectronApplication, Page } from '@playwright/test';
import { expect } from './fixtures';
import { settled } from './screenshots';

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Records every frame `page` composites from before `act` until `done` resolves and two more frames have painted, and returns
 * per frame how many pixels of `box` (CSS px) are strongly coloured, chroma above 50 of 255: a saturated icon counts above
 * zero and the grey theme surfaces count zero, so a 0 between non-zero frames is a frame painted without the icon.
 */
export async function colouredPixelsPerFrame(app: ElectronApplication, page: Page, box: Box, act: () => Promise<void>, done: () => Promise<void>): Promise<number[]> {
  const cdp = await app.context().newCDPSession(page);
  const frames: string[] = [];
  // An ack still pending at detach rejects, so each is awaited before it.
  const acks: Array<Promise<unknown>> = [];
  const onFrame = ({ data, sessionId }: { data: string; sessionId: number }): void => {
    frames.push(data);
    acks.push(cdp.send('Page.screencastFrameAck', { sessionId }));
  };
  cdp.on('Page.screencastFrame', onFrame);
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await expect.poll(() => frames.length).toBeGreaterThan(0);
  await act();
  await done();
  await settled(page);
  cdp.off('Page.screencastFrame', onFrame);
  await cdp.send('Page.stopScreencast');
  await Promise.all(acks);
  await cdp.detach();
  return page.evaluate(async ({ frames, box }) => {
    const counts: number[] = [];
    for (const data of frames) {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: 'image/png' }));
      const scale = bitmap.width / window.innerWidth;
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(Math.round(box.x * scale), Math.round(box.y * scale), Math.max(1, Math.round(box.width * scale)), Math.max(1, Math.round(box.height * scale))).data;
      let coloured = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (Math.max(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) - Math.min(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) > 50) coloured++;
      }
      counts.push(coloured);
    }
    return counts;
  }, { frames, box });
}
