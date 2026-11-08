import type { ElectronApplication, Page } from '@playwright/test';

export interface DragPoint {
  readonly x: number;
  readonly y: number;
}

// A native HTML5 drag under way: each call reaches the page as the browser's own drag events at that point.
export interface HtmlDrag {
  // dragenter, then dragover
  over(point: DragPoint): Promise<void>;
  // dragenter, dragover and drop, then the button's release
  drop(point: DragPoint): Promise<void>;
  // the drag ends with no drop, as Escape ends it
  cancel(): Promise<void>;
}

type DragData = { items: Array<{ mimeType: string; data: string }>; dragOperationsMask: number };

/**
 * Presses at `from` and moves until Chromium starts the page's drag, which CDP intercepts instead of handing it to the OS (a
 * synthetic mouse never drives an OS drag loop); `run` then moves and drops it through Input.dispatchDragEvent with the data
 * the page's dragstart set.
 */
export async function htmlDrag(app: ElectronApplication, page: Page, from: DragPoint, run: (drag: HtmlDrag) => Promise<void>): Promise<void> {
  const cdp = await app.context().newCDPSession(page);
  let timer: NodeJS.Timeout | undefined;
  try {
    await cdp.send('Input.setInterceptDrags', { enabled: true });
    const intercepted = new Promise<DragData>((resolve) => cdp.once('Input.dragIntercepted', (event) => resolve(event.data)));
    const mouse = (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, y: number) =>
      cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    await mouse('mouseMoved', from.x, from.y);
    await mouse('mousePressed', from.x, from.y);
    for (let step = 1; step <= 5; step++) await mouse('mouseMoved', from.x + step * 4, from.y + step * 2);
    const data = await Promise.race([intercepted, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no drag started at ${from.x},${from.y}`)), 5000);
    })]);
    let entered = false;
    let last = from;
    const over = async (point: DragPoint): Promise<void> => {
      last = point;
      if (!entered) await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data });
      entered = true;
      await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...point, data });
    };
    await run({
      over,
      async drop(point) {
        await over(point);
        await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...point, data });
        await mouse('mouseReleased', point.x, point.y);
      },
      async cancel() {
        await cdp.send('Input.dispatchDragEvent', { type: 'dragCancel', ...last, data });
        await mouse('mouseReleased', last.x, last.y);
      },
    });
  } finally {
    clearTimeout(timer);
    try {
      await cdp.send('Input.setInterceptDrags', { enabled: false });
    } finally {
      await cdp.detach();
    }
  }
}

/** Drags from `from` and drops at `to`. */
export function dragAndDrop(app: ElectronApplication, page: Page, from: DragPoint, to: DragPoint): Promise<void> {
  return htmlDrag(app, page, from, (drag) => drag.drop(to));
}
