import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ WebContentsView: vi.fn(), nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() }, protocol: {} }));

import { MAX_MESSAGE_PREVIEW_LINES, MAX_OVERLAY_LABEL_LENGTH } from '../../preload/overlay-channels';
import { parseMessageRequest, parseOverlayAnswer, parseOverlayRequest } from '../overlay';

const grid = { x: 0, y: 40, width: 1000, height: 700 };
const slots = { main: 'chat', side: 'editor', bottom: 'terminal' } as const;

describe('drop zones and Quick Open requests', () => {
  it('takes a drop zones request from the shell only with a pane, a permutation of slots, a grid and a pointer', () => {
    expect(parseOverlayRequest({ kind: 'dropZones', pane: 'terminal', slots, grid, pointer: { x: 10, y: 50 }, extra: 1 })).toEqual({ kind: 'dropZones', pane: 'terminal', slots, grid, pointer: { x: 10, y: 50 } });
    expect(parseOverlayRequest({ kind: 'dropZones', pane: 'sidebar', slots, grid, pointer: { x: 1, y: 1 } })).toBeUndefined();
    expect(parseOverlayRequest({ kind: 'dropZones', pane: 'chat', slots: { ...slots, side: 'chat' }, grid, pointer: { x: 1, y: 1 } })).toBeUndefined();
    expect(parseOverlayRequest({ kind: 'dropZones', pane: 'chat', slots, grid, pointer: { x: -1, y: 1 } })).toBeUndefined();
  });

  it('never lets the shell open Quick Open, which only main asks for', () => {
    expect(parseOverlayRequest({ kind: 'quickOpen' })).toBeUndefined();
  });

  it('keeps a menu caption within bounds', () => {
    const menu = { kind: 'menu', label: 'File', anchor: grid, items: [{ kind: 'item', id: 'open', label: 'Open' }] };
    expect(parseOverlayRequest({ ...menu, caption: 'src/a.ts' })).toMatchObject({ caption: 'src/a.ts' });
    expect(parseOverlayRequest({ ...menu, caption: 'x'.repeat(201) })).toBeUndefined();
  });

  it('accepts a drop zone answer naming a slot or none, and a Quick Open pick a renderer may name', () => {
    const dropZones = { kind: 'dropZones', pane: 'terminal', slots, grid, pointer: { x: 1, y: 1 } } as const;
    expect(parseOverlayAnswer({ kind: 'dropZones', slot: 'side' }, dropZones)).toEqual({ kind: 'dropZones', slot: 'side' });
    expect(parseOverlayAnswer({ kind: 'dropZones', slot: null }, dropZones)).toEqual({ kind: 'dropZones', slot: null });
    expect(parseOverlayAnswer({ kind: 'dropZones', slot: 'top' }, dropZones)).toBeUndefined();

    const quickOpen = { kind: 'quickOpen', mode: 'files' } as const;
    expect(parseOverlayAnswer({ kind: 'quickOpen', pick: { projectKey: 'p', relativePath: 'src/a.ts', line: 4, mention: false } }, quickOpen))
      .toEqual({ kind: 'quickOpen', pick: { projectKey: 'p', relativePath: 'src/a.ts', line: 4, mention: false } });
    expect(parseOverlayAnswer({ kind: 'quickOpen', pick: null }, quickOpen)).toEqual({ kind: 'quickOpen', pick: null });
    for (const relativePath of ['../x', '/etc/passwd', 'C:\\x', '']) {
      expect(parseOverlayAnswer({ kind: 'quickOpen', pick: { projectKey: 'p', relativePath, mention: false } }, quickOpen)).toBeUndefined();
    }
    expect(parseOverlayAnswer({ kind: 'quickOpen', pick: { projectKey: 'p', relativePath: 'a', line: 0, mention: false } }, quickOpen)).toBeUndefined();
  });
});

describe('terminal quick picks, menu glyphs and the paste preview', () => {
  const quickPick = {
    kind: 'quickPick',
    placeholder: 'Select a color for the terminal',
    items: [{ id: 'default', label: 'No color' }, { id: 'red', label: 'Red', glyph: 'powershell', color: 'red' }],
  } as const;

  it('never lets a renderer open a quick pick, which only main asks for', () => {
    expect(parseOverlayRequest(quickPick)).toBeUndefined();
  });

  it('accepts a quick pick answer only for an item the request offered', () => {
    expect(parseOverlayAnswer({ kind: 'quickPick', itemId: 'red' }, quickPick)).toEqual({ kind: 'quickPick', itemId: 'red' });
    expect(parseOverlayAnswer({ kind: 'quickPick', itemId: 'blue' }, quickPick)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'quickPick', itemId: 7 }, quickPick)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'quickPick' }, quickPick)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'dismissed' }, quickPick)).toEqual({ kind: 'dismissed' });
  });

  it('lets a menu item carry a shell or custom terminal glyph, and nothing else', () => {
    const menu = (glyph: unknown) => parseOverlayRequest({ kind: 'menu', label: 'New Terminal', anchor: grid, items: [{ kind: 'item', id: 'pwsh', label: 'PowerShell', glyph }] });
    expect(menu('powershell')).toMatchObject({ items: [{ glyph: 'powershell' }] });
    expect(menu('rocket')).toMatchObject({ items: [{ glyph: 'rocket' }] });
    for (const glyph of ['trash-2', '../x', 3, null]) expect(menu(glyph), String(glyph)).toBeUndefined();
    const tinted = (color: unknown) => parseOverlayRequest({ kind: 'menu', label: 'New Terminal', anchor: grid, items: [{ kind: 'item', id: 'user:Dev', label: 'Dev', glyph: 'code', color }] });
    expect(tinted('magenta')).toMatchObject({ items: [{ glyph: 'code', color: 'magenta' }] });
    for (const color of ['#ff00ff', 'Magenta', 5, null]) expect(tinted(color), String(color)).toBeUndefined();
  });

  it('keeps a message preview within its line count and width', () => {
    const message = { kind: 'message', severity: 'warning', message: 'Paste 2 lines?', actions: ['Paste'], cancelLabel: 'Cancel' } as const;
    expect(parseMessageRequest({ ...message, preview: ['a', 'b'] })).toMatchObject({ preview: ['a', 'b'] });
    expect(parseMessageRequest({ ...message, preview: Array.from({ length: MAX_MESSAGE_PREVIEW_LINES + 1 }, () => 'a') })).toBeUndefined();
    expect(parseMessageRequest({ ...message, preview: ['a'.repeat(MAX_OVERLAY_LABEL_LENGTH + 1)] })).toBeUndefined();
    expect(parseMessageRequest({ ...message, preview: 'a' })).toBeUndefined();
  });
});
