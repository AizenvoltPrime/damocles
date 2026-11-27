// A capture of an on-screen page for ThemeRead's screenshot. webContents.capturePage copies the frame the compositor holds
// when the copy runs, which under software compositing is often the one before a change the page has already acknowledged.

/** The part of a WebContents a capture uses. */
export interface CaptureContents {
  readonly debugger: {
    isAttached(): boolean;
    attach(protocolVersion?: string): void;
    detach(): void;
    sendCommand(method: string, params?: object): Promise<unknown>;
  };
  isDestroyed(): boolean;
}

/**
 * A PNG of the page in device pixels, from a frame it presented after the call: Page.captureScreenshot from the surface forces a
 * redraw and copies once that frame was presented, so the image holds everything the page drew before the call.
 */
export async function presentedFrame(contents: CaptureContents): Promise<Uint8Array> {
  const ours = !contents.debugger.isAttached();
  if (ours) contents.debugger.attach('1.3');
  try {
    const answer = await contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }) as { data?: unknown } | undefined;
    if (typeof answer?.data !== 'string') throw new Error('The page returned no capture');
    return new Uint8Array(Buffer.from(answer.data, 'base64'));
  } finally {
    if (ours && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
  }
}
