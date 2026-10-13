import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ WebContentsView: vi.fn(), nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() }, protocol: {} }));

import { MAX_MESSAGE_PREVIEW_LINES, MAX_OVERLAY_LABEL_LENGTH, tidyMenu } from '../../preload/overlay-channels';
import { createInputAsker, parseMessageRequest, parseOverlayAnswer, parseOverlayRequest, type InputOverlay } from '../overlay';
import type { OverlayAnswer, OverlayRequest } from '../../preload/overlay-channels';

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

  it('keeps the tail of an over-long caption, menu label or item label behind an ellipsis, so a path keeps its file name', () => {
    const menu = { kind: 'menu', label: 'File', anchor: grid, items: [{ kind: 'item', id: 'open', label: 'Open' }] };
    expect(parseOverlayRequest({ ...menu, caption: 'src/a.ts' })).toMatchObject({ caption: 'src/a.ts' });
    const long = `${'deep/'.repeat(60)}name.ts`;
    const clamped = `…${long.slice(long.length - MAX_OVERLAY_LABEL_LENGTH + 1)}`;
    const parsed = parseOverlayRequest({
      ...menu,
      label: long,
      caption: long,
      items: [{ kind: 'item', id: 'open', label: long }, { kind: 'submenu', id: 'more', label: long, items: [{ kind: 'item', id: 'leaf', label: long }] }],
    });
    expect(parsed).toMatchObject({ label: clamped, caption: clamped, items: [{ id: 'open', label: clamped }, { id: 'more', label: clamped, items: [{ id: 'leaf', label: clamped }] }] });
    expect(clamped).toHaveLength(MAX_OVERLAY_LABEL_LENGTH);
    expect(clamped.endsWith('/name.ts')).toBe(true);
    const emoji = parseOverlayRequest({ ...menu, caption: `${'x'.repeat(10)}${'😀'.repeat(MAX_OVERLAY_LABEL_LENGTH)}` }) as { caption: string };
    expect(emoji.caption.charCodeAt(1)).not.toBeGreaterThanOrEqual(0xdc00);
    expect(parseOverlayRequest({ ...menu, items: [{ kind: 'item', id: 'x'.repeat(201), label: 'Open' }] })).toBeUndefined();
    expect(parseOverlayRequest({ ...menu, caption: 7 })).toBeUndefined();
  });

  describe('menus with one level of submenus', () => {
    const item = (id: string, extra: object = {}) => ({ kind: 'item', id, label: id, ...extra });
    const submenu = (id: string, items: unknown[]) => ({ kind: 'submenu', id, label: id, icon: 'files', items });
    const menu = (items: unknown[]) => parseOverlayRequest({ kind: 'menu', label: 'More', anchor: grid, items });

    it('keeps a submenu of items and separators, and refuses one inside another or an empty one', () => {
      expect(menu([submenu('changes', [item('stage'), { kind: 'separator' }, item('discard')])]))
        .toMatchObject({ items: [{ kind: 'submenu', id: 'changes', items: [{ id: 'stage' }, { kind: 'separator' }, { id: 'discard' }] }] });
      expect(menu([submenu('outer', [submenu('inner', [item('a')])])])).toBeUndefined();
      expect(menu([submenu('empty', [])])).toBeUndefined();
      expect(menu([submenu('bad', 'nope' as unknown as unknown[])])).toBeUndefined();
    });

    it('counts every item at both levels against the bound before walking a nested list', () => {
      const children = Array.from({ length: 99 }, (_, index) => item(`c${index}`));
      expect(menu([submenu('s', children)])).toBeDefined();
      expect(menu([submenu('s', [...children, item('c99')])])).toBeUndefined();
      expect(menu([item('top'), submenu('s', children)])).toBeUndefined();
    });

    it('refuses an id used twice across levels, the submenu id included, and a clipboard item in a submenu', () => {
      expect(menu([item('a'), submenu('s', [item('a')])])).toBeUndefined();
      expect(menu([submenu('s', [item('s')])])).toBeUndefined();
      expect(menu([submenu('s', [item('cut', { clipboard: 'cut' })])])).toBeUndefined();
    });

    it('tidies a submenu and drops one left empty', () => {
      expect(tidyMenu([{ kind: 'submenu', id: 's', label: 's', items: [{ kind: 'separator' }] }, { kind: 'separator' }, { kind: 'item', id: 'a', label: 'a' }]))
        .toEqual([{ kind: 'item', id: 'a', label: 'a' }]);
    });

    it('answers only an enabled leaf at either level, never a submenu id', () => {
      const request = menu([item('top'), submenu('s', [item('leaf'), item('off', { disabled: true })])])!;
      expect(parseOverlayAnswer({ kind: 'menu', itemId: 'leaf' }, request)).toEqual({ kind: 'menu', itemId: 'leaf' });
      expect(parseOverlayAnswer({ kind: 'menu', itemId: 'top' }, request)).toEqual({ kind: 'menu', itemId: 'top' });
      expect(parseOverlayAnswer({ kind: 'menu', itemId: 's' }, request)).toBeUndefined();
      expect(parseOverlayAnswer({ kind: 'menu', itemId: 'off' }, request)).toBeUndefined();
    });
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

  it('marks a checked item as one of exclusive choices only beside checked, and only with a boolean', () => {
    const menu = (item: Record<string, unknown>) => parseOverlayRequest({ kind: 'menu', label: 'Views', anchor: grid, items: [{ kind: 'item', id: 'tree', label: 'View as Tree', ...item }] });
    expect(menu({ checked: true, radio: true })).toMatchObject({ items: [{ checked: true, radio: true }] });
    expect(menu({ checked: false })).toEqual(expect.objectContaining({ items: [expect.not.objectContaining({ radio: expect.anything() })] }));
    expect(menu({ radio: true })).toBeUndefined();
    expect(menu({ checked: true, radio: 'yes' })).toBeUndefined();
  });

  it('keeps a message preview within its line count and width', () => {
    const message = { kind: 'message', severity: 'warning', message: 'Paste 2 lines?', actions: ['Paste'], cancelLabel: 'Cancel' } as const;
    expect(parseMessageRequest({ ...message, preview: ['a', 'b'] })).toMatchObject({ preview: ['a', 'b'] });
    expect(parseMessageRequest({ ...message, preview: Array.from({ length: MAX_MESSAGE_PREVIEW_LINES + 1 }, () => 'a') })).toBeUndefined();
    expect(parseMessageRequest({ ...message, preview: ['a'.repeat(MAX_OVERLAY_LABEL_LENGTH + 1)] })).toBeUndefined();
    expect(parseMessageRequest({ ...message, preview: 'a' })).toBeUndefined();
  });
});

describe('the QuickInput asker', () => {
  const branch = { title: 'Commit to a New Branch', prompt: 'Please provide a new branch name', value: 'me/', valueSelection: [3, 3], validation: 'branchName' } as const;

  function asker(answer: (request: OverlayRequest) => OverlayAnswer | Error, overlay = true) {
    const requests: OverlayRequest[] = [];
    const lines: string[] = [];
    let unavailable = 0;
    const host: InputOverlay = {
      request: (request) => {
        requests.push(request);
        const value = answer(request);
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
      },
    };
    const ask = createInputAsker({ overlay: () => (overlay ? host : undefined), focused: () => undefined, unavailable: () => unavailable++, log: (line) => lines.push(line) });
    return { ask, requests, lines, unavailable: () => unavailable };
  }

  it('never lets a renderer open an input box, which only main asks for', () => {
    expect(parseOverlayRequest({ kind: 'input', prompt: 'Name' })).toBeUndefined();
  });

  it('asks with a clean request and resolves the typed value', async () => {
    const fake = asker(() => ({ kind: 'input', value: 'me/fix' }));
    expect(await fake.ask({ ...branch, extra: 1 } as never)).toBe('me/fix');
    expect(fake.requests).toEqual([{ kind: 'input', ...branch }]);
    expect(fake.unavailable()).toBe(0);
  });

  it('resolves undefined for Escape without telling the user anything', async () => {
    const fake = asker(() => ({ kind: 'dismissed' }));
    expect(await fake.ask(branch)).toBeUndefined();
    expect(fake.unavailable()).toBe(0);
  });

  it('checks the answer again in main: a value the validation kind refuses is no answer', () => {
    const request = { kind: 'input', ...branch } as const;
    expect(parseOverlayAnswer({ kind: 'input', value: 'me/fix' }, request)).toEqual({ kind: 'input', value: 'me/fix' });
    expect(parseOverlayAnswer({ kind: 'input', value: 'me/fix..x' }, request)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'input', value: 'HEAD' }, request)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'input', value: ['x'] }, request)).toBeUndefined();
  });

  it('checks a path answer against the rules of the platform main runs on', () => {
    const request = { kind: 'input', prompt: 'Rename', validation: 'path' } as const;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      expect(parseOverlayAnswer({ kind: 'input', value: 'src/con.ts' }, request)).toBeUndefined();
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
      expect(parseOverlayAnswer({ kind: 'input', value: 'src/con.ts' }, request)).toEqual({ kind: 'input', value: 'src/con.ts' });
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('reports a box it cannot show, so the caller can say so', async () => {
    const hung = asker(() => new Error('The overlay did not respond'));
    expect(await hung.ask(branch)).toBeUndefined();
    expect(hung.unavailable()).toBe(1);
    const none = asker(() => ({ kind: 'dismissed' }), false);
    expect(await none.ask(branch)).toBeUndefined();
    expect(none.unavailable()).toBe(1);
    const unbounded = asker(() => ({ kind: 'dismissed' }));
    expect(await unbounded.ask({ prompt: '' })).toBeUndefined();
    expect(unbounded.requests).toEqual([]);
    expect(unbounded.unavailable()).toBe(1);
  });
});
