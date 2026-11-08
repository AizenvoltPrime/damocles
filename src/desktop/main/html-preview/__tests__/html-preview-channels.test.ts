import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeListener: vi.fn() }, protocol: {} }));

import { htmlPreviewAreaToDip, parseHtmlPreviewAction } from '../../shell';

describe('the HTML preview channels main accepts', () => {
  it('takes exactly a tab id and one of the actions', () => {
    for (const action of ['reload', 'openInBrowser', 'trustFolder']) expect(parseHtmlPreviewAction({ tabId: 't1', action })).toEqual({ tabId: 't1', action });
    for (const raw of [
      { tabId: 't1', action: 'devTools' },
      { tabId: 't1', action: 'reload', url: 'https://example.com/' },
      { tabId: '', action: 'reload' },
      { tabId: 't'.repeat(10_000), action: 'reload' },
      { tabId: 7, action: 'reload' },
      { action: 'reload' },
      ['t1', 'reload'],
      null,
    ]) {
      expect(parseHtmlPreviewAction(raw), JSON.stringify(raw)).toBeUndefined();
    }
  });

  it('scales a page card to window DIP with its radius, and refuses a malformed one', () => {
    expect(htmlPreviewAreaToDip({ tabId: 't1', x: 10, y: 20, width: 300, height: 200, radius: 6 }, 1.5)).toMatchObject({ tabId: 't1', radius: 9, bounds: { x: 15, y: 30 } });
    for (const raw of [
      { tabId: 't1', x: 10, y: 20, width: 300, height: 200 },
      { tabId: 't1', x: -1, y: 20, width: 300, height: 200, radius: 6 },
      { tabId: 't1', x: 10, y: 20, width: Number.NaN, height: 200, radius: 6 },
      { tabId: 't1', x: 10, y: 20, width: 300, height: 200, radius: 6, zoom: 1 },
      { x: 10, y: 20, width: 300, height: 200, radius: 6 },
      { tabId: '', x: 10, y: 20, width: 300, height: 200, radius: 6 },
    ]) {
      expect(htmlPreviewAreaToDip(raw, 1), JSON.stringify(raw)).toBeUndefined();
    }
  });
});
