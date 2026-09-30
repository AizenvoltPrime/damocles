import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PANE_URL_LENGTH } from '../../preload/pane-channels';
import { EMPTY_PANE, PANEL_STATE_FILE, PanelStateStore } from '../panel-state-store';

let dir: string;
let lines: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-panels-'));
  lines = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const log = (line: string): void => {
  lines.push(line);
};

async function reopened(): Promise<PanelStateStore> {
  // Writes are queued through the cross-process writer; wait for the file to settle.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return new PanelStateStore(dir, log);
}

function writeFile(content: unknown): void {
  fs.writeFileSync(path.join(dir, PANEL_STATE_FILE), JSON.stringify(content));
}

describe('PanelStateStore', () => {
  it('keeps tab order, state and the selection across a reopen', async () => {
    const store = new PanelStateStore(dir, log);
    store.set({ panelId: 'a', state: { workspaceFolderKey: 'k1' } });
    store.set({ panelId: 'b', state: null });
    store.set({ panelId: 'c', state: null });
    store.reorder(['c', 'a']);
    store.select('a');
    store.set({ panelId: 'c', state: { sessionId: 's' } });

    const next = await reopened();
    expect(next.list().map((panel) => panel.panelId)).toEqual(['c', 'a', 'b']);
    expect(next.get('c')).toEqual({ panelId: 'c', kind: 'chat', state: { sessionId: 's' }, pane: EMPTY_PANE });
    expect(next.selected()).toBe('a');
  });

  it('round-trips each tab pane and the shared width, and a state update keeps the pane', async () => {
    const store = new PanelStateStore(dir, log);
    store.set({ panelId: 'a', state: null });
    store.set({ panelId: 'b', state: null });
    store.setPane('a', { open: true, maximized: true, pages: ['https://a.example/', 'about:blank'], activePage: 1 });
    store.set({ panelId: 'a', state: { sessionId: 's' } });
    store.setPaneWidth(612);
    store.setPane('missing', { open: true, maximized: false, pages: ['https://x.example/'] });

    const next = await reopened();
    expect(next.get('a')?.pane).toEqual({ open: true, maximized: true, pages: ['https://a.example/', 'about:blank'], activePage: 1 });
    expect(next.get('a')?.state).toEqual({ sessionId: 's' });
    expect(next.get('b')?.pane).toEqual(EMPTY_PANE);
    expect(next.get('missing')).toBeUndefined();
    expect(next.paneWidth()).toBe(612);
  });

  it('refuses a width that is not a finite in-range number', () => {
    const store = new PanelStateStore(dir, log);
    for (const width of [Number.NaN, Number.POSITIVE_INFINITY, -1, 100_001]) store.setPaneWidth(width);
    expect(store.paneWidth()).toBeUndefined();
  });

  it('drops the selection with its panel and ignores a selection of an unknown panel', async () => {
    const store = new PanelStateStore(dir, log);
    store.set({ panelId: 'a', state: null });
    store.select('missing');
    expect(store.selected()).toBeUndefined();
    store.select('a');
    store.delete('a');
    expect(store.selected()).toBeUndefined();
    expect((await reopened()).list()).toEqual([]);
  });

  it('ignores a persisted selection that names no persisted panel', () => {
    writeFile({ version: 1, panels: [{ panelId: 'a', kind: 'chat', state: null }], selectedPanelId: 'zz' });
    expect(new PanelStateStore(dir, log).selected()).toBeUndefined();
  });

  it('drops a non-chat entry, a malformed page address and a malformed width with a log line', () => {
    writeFile({
      version: 1,
      panels: [
        { panelId: 'old', kind: 'browser', state: { url: 'https://example.com/' } },
        { panelId: 'a', kind: 'chat', state: null, pane: { open: true, pages: ['https://ok.example/', 42, '', 'x'.repeat(MAX_PANE_URL_LENGTH + 1), 'https://two.example/'], activePage: 4 } },
        { panelId: 'b', kind: 'chat', state: null, pane: 'nonsense' },
        { panelId: 'c', kind: 'chat', state: null, pane: { open: true, pages: ['https://c.example/'], activePage: 7 } },
      ],
      paneWidth: 'wide',
    });
    const store = new PanelStateStore(dir, log);
    expect(store.list().map((panel) => panel.panelId)).toEqual(['a', 'b', 'c']);
    expect(store.get('a')?.pane).toEqual({ open: true, maximized: false, pages: ['https://ok.example/', 'https://two.example/'], activePage: 1 });
    expect(store.get('b')?.pane).toEqual(EMPTY_PANE);
    expect(store.get('c')?.pane).toEqual({ open: true, maximized: false, pages: ['https://c.example/'] });
    expect(store.paneWidth()).toBeUndefined();
    expect(lines).toEqual([
      '[panels] dropping tab old: not a chat tab',
      '[panels] tab a: dropping a browser page with a malformed address',
      '[panels] tab a: dropping a browser page with a malformed address',
      '[panels] tab a: dropping a browser page with a malformed address',
      '[panels] tab b: dropping a malformed browser pane',
      '[panels] ignoring a malformed browser pane width',
    ]);
  });
});
