import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ WebContentsView: vi.fn(), nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() }, protocol: {} }));

import { MAX_MENU_ITEMS, MAX_MESSAGE_PREVIEW_LINES, MAX_OVERLAY_ITEMS, MAX_OVERLAY_LABEL_LENGTH, MAX_QUICK_PICK_BYTES, MAX_QUICK_PICK_ITEMS, parseInputRequest, quickPickItemBytes, tidyMenu } from '../../preload/overlay-channels';
import { MAX_INPUT_VALUE_LENGTH } from '../../../shared/input-validation';
import { createInputAsker, createQuickPickAsker, parseBrowseCall, parseMessageRequest, parseOverlayAnswer, parseOverlayRequest, parseQuickPickRequest, type InputBrowseHandler, type InputOverlay } from '../overlay';
import { moreActionsMenu, toOverlayMenu } from '../../shell/scm/scm-menus';
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

  it('accepts the fullest Source control More Actions menu, whose Pull, Push items are scoped apart from the top-level ones', () => {
    const full = moreActionsMenu({
      viewMode: 'list',
      sortKey: 'name',
      untrackedChanges: 'separate',
      openRepos: 2,
      closedCount: 1,
      commit: { operation: null, hasCommit: true, hasTemplate: true, allowNoVerifyCommit: true, amending: false },
      remote: { hasRemotes: true, allowForcePush: true, operation: null },
      refs: { head: 'branch', stashStaged: true, stashes: 1 },
    });
    const items = toOverlayMenu(full, (key) => key);
    const parsed = parseOverlayRequest({ kind: 'menu', label: 'More Actions', anchor: grid, items });
    expect(parsed).toBeDefined();
    const ids = JSON.stringify(parsed);
    for (const id of ['"pull"', '"push"', '"fetch"', '"clone"', '"pullPush:pushForce"', '"pullPush:pushToForce"', '"addRemote"', '"removeRemote"']) expect(ids).toContain(id);
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

    it('counts every item at both levels against MAX_MENU_ITEMS, and each list against MAX_OVERLAY_ITEMS, before walking a nested list', () => {
      const children = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => item(`${prefix}${index}`));
      expect(menu([submenu('s', children('c', MAX_OVERLAY_ITEMS))])).toBeDefined();
      expect(menu([submenu('s', children('c', MAX_OVERLAY_ITEMS + 1))])).toBeUndefined();
      // 2 submenu rows and 158 items: exactly MAX_MENU_ITEMS
      expect(menu([submenu('s', children('a', 79)), submenu('t', children('b', MAX_MENU_ITEMS - 81))])).toBeDefined();
      expect(menu([submenu('s', children('a', 79)), submenu('t', children('b', MAX_MENU_ITEMS - 80))])).toBeUndefined();
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

describe('the quick picks main asks', () => {
  it('keeps icon, hint, group and current, and cuts a long label, description or hint to its tail', () => {
    const long = `${'x'.repeat(300)}/name`;
    const request = parseQuickPickRequest('Select a branch or tag to checkout', [
      { id: '0', label: 'Create new branch...', icon: 'add' },
      { id: '1', label: 'main', icon: 'branch', group: 'branches', hint: '0\u2193 1\u2191', current: true, description: 'abc1234 \u2022 subject' },
      { id: '2', label: long, icon: 'branch', group: 'branches', hint: long },
      { id: '3', label: 'v1', icon: 'tag', group: 'tags' },
    ]);
    expect(request?.items[1]).toEqual({ id: '1', label: 'main', icon: 'branch', group: 'branches', hint: '0\u2193 1\u2191', current: true, description: 'abc1234 \u2022 subject' });
    expect(request?.items[2]!.label).toHaveLength(MAX_OVERLAY_LABEL_LENGTH);
    expect(request?.items[2]!.label.endsWith('/name')).toBe(true);
    expect(request?.items[2]!.hint!.startsWith('\u2026')).toBe(true);
  });

  it('refuses an unknown icon, a duplicate id, a group split in two runs, no items, and more than MAX_QUICK_PICK_ITEMS or MAX_QUICK_PICK_BYTES', () => {
    expect(parseQuickPickRequest('p', [{ id: '0', label: 'a', icon: 'rocket' }])).toBeUndefined();
    expect(parseQuickPickRequest('p', [{ id: '0', label: 'a' }, { id: '0', label: 'b' }])).toBeUndefined();
    expect(parseQuickPickRequest('p', [{ id: '0', label: 'a', group: 'g' }, { id: '1', label: 'b', group: 'h' }, { id: '2', label: 'c', group: 'g' }])).toBeUndefined();
    expect(parseQuickPickRequest('p', [])).toBeUndefined();
    expect(parseQuickPickRequest('p', [{ id: '0', label: 'a', alwaysShow: true }])?.items[0]).toEqual({ id: '0', label: 'a', alwaysShow: true });
    expect(parseQuickPickRequest('p', [{ id: '0', label: 'a', alwaysShow: false }])).toBeUndefined();
    expect(parseQuickPickRequest('p', [{ id: '0', label: 'a', alwaysShow: true, group: 'g' }])).toBeUndefined();
    // an echoing item shows whatever the filter, so it needs alwaysShow
    expect(parseQuickPickRequest('p', [{ id: '0', label: 'a', alwaysShow: true, echoQuery: true }])?.items[0]).toEqual({ id: '0', label: 'a', alwaysShow: true, echoQuery: true });
    expect(parseQuickPickRequest('p', [{ id: '0', label: 'a', echoQuery: true }])).toBeUndefined();
    expect(parseQuickPickRequest('p', [{ id: '0', label: 'a', alwaysShow: true, echoQuery: 'yes' }])).toBeUndefined();
    expect(parseQuickPickRequest('p', [{ id: '0', label: 'a', alwaysShow: true, echoQuery: false }])).toBeUndefined();
    // past the 10,000 items a ref picker once could not show
    expect(MAX_QUICK_PICK_ITEMS).toBeGreaterThan(10_000);
    const many = Array.from({ length: MAX_QUICK_PICK_ITEMS }, (_, index) => ({ id: `${index}`, label: `b${index}` }));
    expect(parseQuickPickRequest('p', many)?.items).toHaveLength(MAX_QUICK_PICK_ITEMS);
    expect(parseQuickPickRequest('p', [...many, { id: 'x', label: 'x' }])).toBeUndefined();
    // a long label is cut once shown, so the budget counts the items as sent
    const wide = { id: '0', label: 'x'.repeat(4096) };
    const fit = Math.floor(MAX_QUICK_PICK_BYTES / quickPickItemBytes(wide));
    const heavy = Array.from({ length: fit + 1 }, (_, index) => ({ ...wide, id: `${index}` }));
    expect(parseQuickPickRequest('p', heavy)).toBeUndefined();
    expect(parseQuickPickRequest('p', heavy.slice(0, fit - 10))).toBeDefined();
  });

  it("shows a repository's control and bidi characters as escapes in every text, so a ref cannot read as another", () => {
    const request = parseQuickPickRequest('Select a branch or tag to checkout', [
      { id: '0', label: 'main\u202Exe.nigol', icon: 'branch', group: 'branches\u200B', hint: 'lo\u2066cal', description: 'abc1234 \u2022 fix\u0007' },
      { id: '1', label: `${'\u202E'.repeat(150)}tail`, icon: 'branch', group: 'branches\u200B' },
    ])!;
    expect(request.items[0]).toEqual({ id: '0', label: 'main\\u{202E}xe.nigol', icon: 'branch', group: 'branches\\u{200B}', hint: 'lo\\u{2066}cal', description: 'abc1234 \u2022 fix\\u{7}' });
    // escaped before the cut, so the label shown stays within its bound and keeps its tail
    expect(request.items[1]!.label).toHaveLength(MAX_OVERLAY_LABEL_LENGTH);
    expect(request.items[1]!.label.endsWith('\\u{202E}tail')).toBe(true);
    // the bytes budget counts the escapes the overlay receives
    expect(quickPickItemBytes({ id: '0', label: '\u202E' })).toBe(quickPickItemBytes({ id: '0', label: '\\u{202E}' }));
  });

  it('shows an info row, which no answer may name', () => {
    const request = parseQuickPickRequest('p', [{ id: '0', label: 'main' }, { id: '1', label: '3 more refs not shown', alwaysShow: true, info: true }])!;
    expect(request.items[1]).toEqual({ id: '1', label: '3 more refs not shown', alwaysShow: true, info: true });
    expect(parseQuickPickRequest('p', [{ id: '0', label: 'a', info: false }])).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'quickPick', itemId: '0', query: '' }, request)).toEqual({ kind: 'quickPick', itemId: '0', query: '' });
    expect(parseOverlayAnswer({ kind: 'quickPick', itemId: '1', query: '' }, request)).toBeUndefined();
  });

  function picker(answer: (request: OverlayRequest) => OverlayAnswer | Error, overlay = true) {
    const requests: OverlayRequest[] = [];
    const lines: string[] = [];
    const told: string[] = [];
    const host: InputOverlay = {
      dismiss: () => undefined,
      request: (request) => {
        requests.push(request);
        const value = answer(request);
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
      },
    };
    const ask = createQuickPickAsker({ overlay: () => (overlay ? host : undefined), focused: () => undefined, unavailable: () => told.push('unavailable'), tooLarge: () => told.push('tooLarge'), log: (line) => lines.push(line) });
    return { ask, requests, lines, told };
  }

  it('asks a clean quick pick and resolves the picked id and the query; Escape tells nothing', async () => {
    const fake = picker(() => ({ kind: 'quickPick', itemId: '1', query: 'ma' }));
    expect(await fake.ask('Pick', [{ id: '0', label: 'a' }, { id: '1', label: 'main', extra: 1 }])).toEqual({ id: '1', query: 'ma' });
    expect(fake.requests).toEqual([{ kind: 'quickPick', placeholder: 'Pick', items: [{ id: '0', label: 'a' }, { id: '1', label: 'main' }] }]);
    const dismissed = picker(() => ({ kind: 'dismissed' }));
    expect(await dismissed.ask('Pick', [{ id: '0', label: 'a' }])).toBeUndefined();
    expect(dismissed.told).toEqual([]);
  });

  it('settles a rejected request, a missing overlay or a malformed list as could not be shown, and a list past the bounds as too large', async () => {
    const rejected = picker(() => new Error('the overlay page crashed'));
    expect(await rejected.ask('Pick', [{ id: '0', label: 'a' }])).toBeUndefined();
    expect(rejected.told).toEqual(['unavailable']);
    expect(rejected.lines).toEqual(['[quick pick] the overlay could not ask (the overlay page crashed)']);
    const none = picker(() => ({ kind: 'dismissed' }), false);
    expect(await none.ask('Pick', [{ id: '0', label: 'a' }])).toBeUndefined();
    expect(none.told).toEqual(['unavailable']);
    const malformed = picker(() => ({ kind: 'dismissed' }));
    expect(await malformed.ask('Pick', [{ id: '0', label: 'a', icon: 'rocket' }])).toBeUndefined();
    expect(malformed.told).toEqual(['unavailable']);
    const large = picker(() => ({ kind: 'dismissed' }));
    expect(await large.ask('Pick', Array.from({ length: MAX_QUICK_PICK_ITEMS + 1 }, (_, index) => ({ id: `${index}`, label: 'x' })))).toBeUndefined();
    expect(large.told).toEqual(['tooLarge']);
    expect(large.requests).toEqual([]);
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
    expect(parseOverlayAnswer({ kind: 'quickPick', itemId: 'red', query: 're' }, quickPick)).toEqual({ kind: 'quickPick', itemId: 'red', query: 're' });
    expect(parseOverlayAnswer({ kind: 'quickPick', itemId: 'blue', query: '' }, quickPick)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'quickPick', itemId: 7, query: '' }, quickPick)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'quickPick' }, quickPick)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'dismissed' }, quickPick)).toEqual({ kind: 'dismissed' });
  });

  it('carries the filter text in a quick pick answer only as a string within MAX_INPUT_VALUE_LENGTH', () => {
    expect(parseOverlayAnswer({ kind: 'quickPick', itemId: 'red', query: ' fix login ' }, quickPick)).toEqual({ kind: 'quickPick', itemId: 'red', query: ' fix login ' });
    expect(parseOverlayAnswer({ kind: 'quickPick', itemId: 'red', query: 'x'.repeat(MAX_INPUT_VALUE_LENGTH) }, quickPick)).toMatchObject({ itemId: 'red' });
    expect(parseOverlayAnswer({ kind: 'quickPick', itemId: 'red', query: 'x'.repeat(MAX_INPUT_VALUE_LENGTH + 1) }, quickPick)).toBeUndefined();
    for (const query of [undefined, null, 3, ['x'], { value: 'x' }]) expect(parseOverlayAnswer({ kind: 'quickPick', itemId: 'red', query }, quickPick), String(query)).toBeUndefined();
  });

  it('lets a menu item carry a disabled reason only while disabled, as non-empty text within MAX_OVERLAY_LABEL_LENGTH', () => {
    const menu = (item: Record<string, unknown>) => parseOverlayRequest({ kind: 'menu', label: 'Stash', anchor: grid, items: [{ kind: 'item', id: 'stashPopLatest', label: 'Pop Latest Stash', ...item }] });
    expect(menu({ disabled: true, disabledReason: 'No stashes' })).toMatchObject({ items: [{ disabled: true, disabledReason: 'No stashes' }] });
    expect(menu({ disabled: true, disabledReason: 'x'.repeat(MAX_OVERLAY_LABEL_LENGTH) })).toBeDefined();
    expect(menu({ disabled: true })).toEqual(expect.objectContaining({ items: [expect.not.objectContaining({ disabledReason: expect.anything() })] }));
    for (const item of [{ disabledReason: 'No stashes' }, { disabled: false, disabledReason: 'No stashes' }, { disabled: true, disabledReason: '' }, { disabled: true, disabledReason: 3 }, { disabled: true, disabledReason: 'x'.repeat(MAX_OVERLAY_LABEL_LENGTH + 1) }]) {
      expect(menu(item), JSON.stringify(item).slice(0, 60)).toBeUndefined();
    }
    // a submenu's items are checked the same way
    const nested = parseOverlayRequest({ kind: 'menu', label: 'More', anchor: grid, items: [{ kind: 'submenu', id: 'submenu:stash', label: 'Stash', items: [{ kind: 'item', id: 'stashPop', label: 'Pop Stash...', disabledReason: 'No stashes' }] }] });
    expect(nested).toBeUndefined();
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
      dismiss: () => undefined,
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

  it('sends a browse button as its tooltip alone and keeps its handler in main, never beside a password', async () => {
    const handlers: Array<InputBrowseHandler | undefined> = [];
    const requests: OverlayRequest[] = [];
    const host: InputOverlay = {
      dismiss: () => undefined,
      request: (request, _focus, _shown, browse) => {
        requests.push(request);
        handlers.push(browse);
        return Promise.resolve({ kind: 'dismissed' });
      },
    };
    const ask = createInputAsker({ overlay: () => host, focused: () => undefined, unavailable: () => undefined, log: () => undefined });
    const pick: InputBrowseHandler = async () => ({ value: '/x/y', valueSelection: [3, 4] });
    await ask({ prompt: 'Please provide a worktree path', value: '/a/b', browse: { tooltip: 'Select Worktree Destination', pick } });
    expect(requests[0]).toEqual({ kind: 'input', prompt: 'Please provide a worktree path', value: '/a/b', browse: { tooltip: 'Select Worktree Destination' } });
    expect(handlers[0]).toBe(pick);
    expect(parseInputRequest({ kind: 'input', prompt: 'p', password: true, browse: { tooltip: 't' } })).toBeUndefined();
    for (const browse of [{ tooltip: '' }, { tooltip: 'x'.repeat(MAX_OVERLAY_LABEL_LENGTH + 1) }, { tooltip: 't', pick: 'x' }, 't', null]) {
      expect(parseInputRequest({ kind: 'input', prompt: 'p', browse }), JSON.stringify(browse)).toBeUndefined();
    }
  });

  it('takes an input browse call only as exactly { value } within MAX_INPUT_VALUE_LENGTH', () => {
    expect(parseBrowseCall({ value: '/a/b' })).toBe('/a/b');
    expect(parseBrowseCall({ value: '' })).toBe('');
    for (const raw of [{ value: 3 }, { value: '/a', extra: 1 }, {}, null, '/a', { value: 'x'.repeat(MAX_INPUT_VALUE_LENGTH + 1) }]) expect(() => parseBrowseCall(raw), JSON.stringify(raw)).toThrow('Malformed');
  });

  describe('withdrawn by its signal', () => {
    function withdrawable() {
      const dismissed: string[] = [];
      const requests: OverlayRequest[] = [];
      let answer!: (value: OverlayAnswer) => void;
      const host: InputOverlay = {
        dismiss: (kind) => {
          dismissed.push(kind);
          answer({ kind: 'dismissed' });
        },
        request: (request) => {
          requests.push(request);
          return new Promise((resolve) => (answer = resolve));
        },
      };
      const ask = createInputAsker({ overlay: () => host, focused: () => undefined, unavailable: () => undefined, log: () => undefined });
      return { ask, dismissed, requests, answer: (value: OverlayAnswer) => answer(value) };
    }

    it('asks nothing once already withdrawn', async () => {
      const fake = withdrawable();
      const gone = new AbortController();
      gone.abort();
      expect(await fake.ask(branch, gone.signal)).toBeUndefined();
      expect(fake.requests).toEqual([]);
    });

    it('closes the open box once and resolves undefined', async () => {
      const fake = withdrawable();
      const withdrawn = new AbortController();
      const asked = fake.ask(branch, withdrawn.signal);
      await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
      withdrawn.abort();
      expect(await asked).toBeUndefined();
      expect(fake.dismissed).toEqual(['input']);
    });

    it('drops a value that arrives after the withdrawal', async () => {
      const withdrawn = new AbortController();
      const host: InputOverlay = { dismiss: () => undefined, request: () => new Promise((resolve) => queueMicrotask(() => { withdrawn.abort(); resolve({ kind: 'input', value: 'secret' }); })) };
      const ask = createInputAsker({ overlay: () => host, focused: () => undefined, unavailable: () => undefined, log: () => undefined });
      expect(await ask(branch, withdrawn.signal)).toBeUndefined();
    });

    it('stops listening once answered, so a later abort closes nothing', async () => {
      const fake = withdrawable();
      const withdrawn = new AbortController();
      const asked = fake.ask(branch, withdrawn.signal);
      await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
      fake.answer({ kind: 'input', value: 'me/fix' });
      expect(await asked).toBe('me/fix');
      withdrawn.abort();
      expect(fake.dismissed).toEqual([]);
    });
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
