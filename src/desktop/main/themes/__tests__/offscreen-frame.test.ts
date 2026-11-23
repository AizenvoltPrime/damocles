import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { frameAfterResize, freshFrames, type FreshFrames, type OffscreenFrames } from '../offscreen-frame';

// A capture is a 'paint' frame the page rendered after the call; a frame of an earlier size, or one at the job's size from
// before the fence, would show the page as it was before it drew.

interface Frame {
  readonly id: string;
  getSize(): { width: number; height: number };
}

class FakeContents extends EventEmitter implements OffscreenFrames<Frame> {
  paint(width: number, height: number, id = `${width}x${height}`): void {
    this.emit('paint', {}, { x: 0, y: 0, width, height }, { id, getSize: () => ({ width, height }) });
  }
}

const settledYet = async <T>(promise: Promise<T>): Promise<boolean> => {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return settled;
};

describe('frameAfterResize', () => {
  it('listens before it resizes and resolves with the first frame of the size', async () => {
    const contents = new FakeContents();
    const frame = frameAfterResize(contents, 1280, 900, (width, height) => contents.paint(width, height, 'at once'));
    await expect(frame).resolves.toMatchObject({ id: 'at once' });
    expect(contents.listenerCount('paint')).toBe(0);
  });

  it('ignores frames of other sizes', async () => {
    const contents = new FakeContents();
    const frame = frameAfterResize(contents, 1280, 900, () => undefined);
    contents.paint(1280, 800);
    contents.paint(900, 1280);
    expect(await settledYet(frame)).toBe(false);
    contents.paint(1280, 900, 'new');
    await expect(frame).resolves.toMatchObject({ id: 'new' });
    expect(contents.listenerCount('paint')).toBe(0);
  });
});

describe('freshFrames', () => {
  const setup = (): { contents: FakeContents; sizes: string[]; frames: FreshFrames<Frame> } => {
    const contents = new FakeContents();
    const sizes: string[] = [];
    const frames = freshFrames(contents, (width, height) => sizes.push(`${width}x${height}`), { width: 1280, height: 800 });
    return { contents, sizes, frames };
  };

  it('takes the first frame at the size after the first one at a fence size, never a frame from before', async () => {
    const { contents, sizes, frames } = setup();
    frames.resize(1280, 900);
    const shot = frames.fresh(1280, 900);
    expect(sizes).toEqual(['1280x900', '1280x899']);
    contents.paint(1280, 900, 'before the call');
    expect(await settledYet(shot)).toBe(false);
    contents.paint(1280, 899, 'fence');
    await settledYet(shot);
    expect(sizes).toEqual(['1280x900', '1280x899', '1280x900']);
    contents.paint(1280, 900, 'after');
    await expect(shot).resolves.toMatchObject({ id: 'after' });
    expect(contents.listenerCount('paint')).toBe(0);
  });

  it('fences at a size the window did not take since the last returned frame, so no frame at it predates the call', async () => {
    const { contents, sizes, frames } = setup();
    frames.resize(1280, 801);
    const first = frames.fresh(1280, 801);
    contents.paint(1280, 801);
    expect(await settledYet(first)).toBe(false);
    contents.paint(1280, 800);
    expect(await settledYet(first)).toBe(false);
    expect(sizes).toEqual(['1280x801', '1280x799']);
    contents.paint(1280, 799);
    await settledYet(first);
    contents.paint(1280, 801);
    await first;
    // the returned frame came after every frame of the sizes before it, so those sizes are free again
    const second = frames.fresh(1280, 800);
    expect(sizes.at(-1)).toBe('1280x799');
    contents.paint(1280, 801, 'stale');
    expect(await settledYet(second)).toBe(false);
    contents.paint(1280, 799);
    await settledYet(second);
    contents.paint(1280, 800, 'fresh');
    await expect(second).resolves.toMatchObject({ id: 'fresh' });
  });

  it('uses the same fence for every capture at one size, however many there are', async () => {
    const { contents, sizes, frames } = setup();
    for (let round = 0; round < 5; round++) {
      const shot = frames.fresh(1280, 800);
      expect(sizes.at(-1)).toBe('1280x799');
      contents.paint(1280, 799);
      await settledYet(shot);
      contents.paint(1280, 800);
      await shot;
    }
    expect(new Set(sizes)).toEqual(new Set(['1280x799', '1280x800']));
  });

  it('fences above a capture one pixel high, and above again when the window just had that height', async () => {
    const { contents, sizes, frames } = setup();
    frames.resize(64, 1);
    const first = frames.fresh(64, 1);
    expect(sizes.at(-1)).toBe('64x2');
    contents.paint(64, 2);
    await settledYet(first);
    contents.paint(64, 1);
    await first;
    frames.resize(64, 2);
    frames.resize(64, 1);
    const second = frames.fresh(64, 1);
    expect(sizes.at(-1)).toBe('64x3');
    contents.paint(64, 2, 'stale');
    expect(await settledYet(second)).toBe(false);
    contents.paint(64, 3);
    await settledYet(second);
    contents.paint(64, 1, 'fresh');
    await expect(second).resolves.toMatchObject({ id: 'fresh' });
  });
});
