// Frames of an offscreen page, read through its 'paint' event (Electron's offscreen rendering), which presents them in the
// order the page rendered them.

export interface FrameImage {
  getSize(): { readonly width: number; readonly height: number };
}

type PaintListener<I extends FrameImage> = (event: unknown, dirty: unknown, image: I) => void;

/** The part of an offscreen WebContents a frame wait uses. */
export interface OffscreenFrames<I extends FrameImage> {
  on(event: 'paint', listener: PaintListener<I>): unknown;
  off(event: 'paint', listener: PaintListener<I>): unknown;
}

const sizeKey = (width: number, height: number): string => `${width}x${height}`;

/**
 * Resolves with the first frame of exactly width x height the page presents once `setSize` gave its window that size. It has
 * no timeout of its own: the caller bounds the wait.
 */
export function frameAfterResize<I extends FrameImage>(contents: OffscreenFrames<I>, width: number, height: number, setSize: (width: number, height: number) => void): Promise<I> {
  return new Promise((resolve) => {
    const painted: PaintListener<I> = (_event, _dirty, image) => {
      const size = image.getSize();
      if (size.width !== width || size.height !== height) return;
      contents.off('paint', painted);
      resolve(image);
    };
    contents.on('paint', painted);
    setSize(width, height);
  });
}

export interface FreshFrames<I extends FrameImage> {
  // every size the window takes goes through here, or `fresh` may take a frame from before the call
  resize(width: number, height: number): void;
  fresh(width: number, height: number): Promise<I>;
}

/**
 * The window's sizes and a frame of width x height rendered after `fresh` was called: the window first takes a fence size
 * no frame can still arrive at, so the first frame at it was rendered after the call, and then width x height again, whose
 * first frame after the fence's is the one returned. One `fresh` runs at a time.
 */
export function freshFrames<I extends FrameImage>(contents: OffscreenFrames<I>, setContentSize: (width: number, height: number) => void, initial: { readonly width: number; readonly height: number }): FreshFrames<I> {
  // the sizes the window took since the last frame `fresh` returned: `resize` waits for no frame, so one at any of them may
  // still arrive. A returned frame was presented after every frame rendered before it, so it leaves only its own size.
  const pending = new Set<string>([sizeKey(initial.width, initial.height)]);
  const setSize = (width: number, height: number): void => {
    pending.add(sizeKey(width, height));
    setContentSize(width, height);
  };
  return {
    resize: setSize,
    fresh: async (width, height) => {
      let fence = height - 1;
      while (fence >= 1 && pending.has(sizeKey(width, fence))) fence--;
      // a window has no height below 1, so the fence is the nearest free height above
      if (fence < 1) {
        fence = height + 1;
        while (pending.has(sizeKey(width, fence))) fence++;
      }
      await frameAfterResize(contents, width, fence, setSize);
      const frame = await frameAfterResize(contents, width, height, setSize);
      pending.clear();
      pending.add(sizeKey(width, height));
      return frame;
    },
  };
}
