import { describe, expect, it, vi } from 'vitest';
import { presentedFrame, type CaptureContents } from '../window-capture';

// A draft screenshot captures right after the pages acknowledged the draft; a copy of whatever frame the compositor holds
// (capturePage) can still show the look from before, so the capture must be one that forces and waits for a new frame.

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function fakeContents(answer: () => Promise<unknown>, attachedBefore = false): CaptureContents & { readonly calls: string[] } {
  let attached = attachedBefore;
  const calls: string[] = [];
  return {
    calls,
    isDestroyed: () => false,
    debugger: {
      isAttached: () => attached,
      attach: () => {
        calls.push('attach');
        attached = true;
      },
      detach: () => {
        calls.push('detach');
        attached = false;
      },
      sendCommand: vi.fn(async (method: string, params?: object) => {
        calls.push(`${method} ${JSON.stringify(params)}`);
        return answer();
      }),
    },
  };
}

describe('presentedFrame', () => {
  it('takes the page from its surface after a forced redraw, never a copy of the frame it holds, and detaches after', async () => {
    const contents = fakeContents(async () => ({ data: Buffer.from(PNG).toString('base64') }));
    await expect(presentedFrame(contents)).resolves.toEqual(PNG);
    expect(contents.calls).toEqual(['attach', 'Page.captureScreenshot {"format":"png","fromSurface":true,"captureBeyondViewport":false}', 'detach']);
  });

  it('leaves a debugger attached before it attached', async () => {
    const contents = fakeContents(async () => ({ data: Buffer.from(PNG).toString('base64') }), true);
    await presentedFrame(contents);
    expect(contents.calls).toEqual(['Page.captureScreenshot {"format":"png","fromSurface":true,"captureBeyondViewport":false}']);
  });

  it('detaches when the capture fails or answers no image', async () => {
    const failed = fakeContents(async () => {
      throw new Error('Target closed');
    });
    await expect(presentedFrame(failed)).rejects.toThrow('Target closed');
    expect(failed.calls.at(-1)).toBe('detach');
    const empty = fakeContents(async () => ({}));
    await expect(presentedFrame(empty)).rejects.toThrow('The page returned no capture');
    expect(empty.calls.at(-1)).toBe('detach');
  });
});
