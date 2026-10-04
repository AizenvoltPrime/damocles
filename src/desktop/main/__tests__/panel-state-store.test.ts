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

async function settled(): Promise<void> {
  // Writes are queued through the cross-process writer; wait for the file to settle.
  await new Promise((resolve) => setTimeout(resolve, 200));
}

async function reopened(): Promise<PanelStateStore> {
  await settled();
  return new PanelStateStore(dir, log);
}

function writeFile(content: unknown): void {
  fs.writeFileSync(path.join(dir, PANEL_STATE_FILE), JSON.stringify(content));
}

describe('PanelStateStore v2', () => {
  it('keeps the loaded chats, their states and the selection across a reopen', async () => {
    const store = new PanelStateStore(dir, log);
    store.set({ panelId: 'a', state: { workspaceFolderKey: 'k1' } });
    store.set({ panelId: 'b', state: null });
    store.select({ projectKey: 'k1', panelId: 'a', sessionId: 's1' });
    store.set({ panelId: 'b', state: { sessionId: 's2' } });

    const next = await reopened();
    expect(next.list().map((chat) => chat.panelId)).toEqual(['a', 'b']);
    expect(next.get('b')).toEqual({ panelId: 'b', state: { sessionId: 's2' }, pane: EMPTY_PANE });
    expect(next.selected()).toEqual({ projectKey: 'k1', panelId: 'a', sessionId: 's1' });
  });

  it('writes version 2 with the selection and each chat flat', async () => {
    const store = new PanelStateStore(dir, log);
    store.set({ panelId: 'a', state: { sessionId: 's' } });
    store.setPane('a', { open: true, maximized: false, pages: ['https://a.example/'], activePage: 0 });
    store.select({ projectKey: 'k1', sessionId: 's', panelId: 'a' });
    await settled();
    expect(JSON.parse(fs.readFileSync(path.join(dir, PANEL_STATE_FILE), 'utf8'))).toEqual({
      version: 2,
      selected: { projectKey: 'k1', sessionId: 's', panelId: 'a' },
      chats: [{ panelId: 'a', state: { sessionId: 's' }, pages: ['https://a.example/'], activePage: 0, paneOpen: true, paneMaximized: false }],
    });
  });

  it('round-trips each chat pane and the shared width, and a state update keeps the pane', async () => {
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

  it('keeps the selected project and session when the selected chat unloads', async () => {
    const store = new PanelStateStore(dir, log);
    store.set({ panelId: 'a', state: null });
    store.select({ projectKey: 'k1', panelId: 'a', sessionId: 's' });
    store.delete('a');
    expect(store.selected()).toEqual({ projectKey: 'k1', sessionId: 's' });
    const next = await reopened();
    expect(next.list()).toEqual([]);
    expect(next.selected()).toEqual({ projectKey: 'k1', sessionId: 's' });
  });

  it('drops a selected panel that is not saved, a malformed selection and malformed chats with a log line', () => {
    writeFile({
      version: 2,
      selected: { projectKey: 'k1', panelId: 'zz', sessionId: 7 },
      chats: [
        { panelId: 'a', state: null, pages: ['https://ok.example/', 42, '', 'x'.repeat(MAX_PANE_URL_LENGTH + 1), 'https://two.example/'], activePage: 4, paneOpen: true },
        { panelId: '../evil', state: null },
        { panelId: 'b', state: 'not an object', pages: 'nonsense' },
        { panelId: 'a', state: null },
        'junk',
      ],
      paneWidth: 'wide',
    });
    const store = new PanelStateStore(dir, log);
    expect(store.list().map((chat) => chat.panelId)).toEqual(['a', 'b']);
    expect(store.get('a')?.pane).toEqual({ open: true, maximized: false, pages: ['https://ok.example/', 'https://two.example/'], activePage: 1 });
    expect(store.get('b')).toEqual({ panelId: 'b', state: null, pane: EMPTY_PANE });
    expect(store.selected()).toEqual({ projectKey: 'k1' });
    expect(store.paneWidth()).toBeUndefined();
    expect(lines).toEqual([
      '[panels] chat a: dropping a browser page with a malformed address',
      '[panels] chat a: dropping a browser page with a malformed address',
      '[panels] chat a: dropping a browser page with a malformed address',
      '[panels] dropping a chat with a malformed panel id',
      '[panels] chat b: dropping malformed browser pages',
      '[panels] chat b: dropping a malformed webview state',
      '[panels] dropping a malformed chat',
      '[panels] ignoring a malformed selected session id',
      '[panels] ignoring a selected chat that is not saved',
      '[panels] ignoring a malformed browser pane width',
    ]);
  });

  it('ignores a file of an unknown schema and one whose selection has no project', () => {
    writeFile({ version: 3, chats: [] });
    expect(new PanelStateStore(dir, log).list()).toEqual([]);
    writeFile({ version: 2, selected: { sessionId: 's' }, chats: [] });
    expect(new PanelStateStore(dir, log).selected()).toBeUndefined();
    expect(lines).toEqual([`[panels] ignoring ${PANEL_STATE_FILE}: unknown schema`, '[panels] ignoring a malformed selection']);
  });

  it('reads a __proto__ key as data, never as the prototype', () => {
    fs.writeFileSync(path.join(dir, PANEL_STATE_FILE), '{"version":2,"chats":[{"panelId":"a","state":null,"__proto__":{"paneOpen":true}}]}');
    expect(new PanelStateStore(dir, log).get('a')?.pane.open).toBe(false);
  });
});

describe('PanelStateStore v1 migration', () => {
  it('turns tabs into chats and the selected tab into the selected chat with its project and session', async () => {
    writeFile({
      version: 1,
      panels: [
        { panelId: 'a', kind: 'chat', state: { workspaceFolderKey: 'k1' }, pane: { open: true, maximized: true, pages: ['https://a.example/'], activePage: 0 } },
        { panelId: 'b', kind: 'chat', state: { workspaceFolderKey: 'k2', sessionId: 's2' } },
      ],
      selectedPanelId: 'b',
      paneWidth: 500,
    });
    const store = new PanelStateStore(dir, log);
    expect(store.list()).toEqual([
      { panelId: 'a', state: { workspaceFolderKey: 'k1' }, pane: { open: true, maximized: true, pages: ['https://a.example/'], activePage: 0 } },
      { panelId: 'b', state: { workspaceFolderKey: 'k2', sessionId: 's2' }, pane: EMPTY_PANE },
    ]);
    expect(store.selected()).toEqual({ projectKey: 'k2', panelId: 'b', sessionId: 's2' });
    expect(store.paneWidth()).toBe(500);
    expect(lines).toEqual([`[panels] migrated ${PANEL_STATE_FILE} from version 1 (2 chats)`]);

    store.set({ panelId: 'a', state: { workspaceFolderKey: 'k1' } });
    await settled();
    expect(JSON.parse(fs.readFileSync(path.join(dir, PANEL_STATE_FILE), 'utf8')).version).toBe(2);
  });

  it('drops a non-chat tab and a malformed pane, and selects nothing for a selected tab with no project', () => {
    writeFile({
      version: 1,
      panels: [
        { panelId: 'old', kind: 'browser', state: { url: 'https://example.com/' } },
        { panelId: 'a', kind: 'chat', state: null, pane: 'nonsense' },
      ],
      selectedPanelId: 'a',
    });
    const store = new PanelStateStore(dir, log);
    expect(store.list()).toEqual([{ panelId: 'a', state: null, pane: EMPTY_PANE }]);
    expect(store.selected()).toBeUndefined();
    expect(lines.slice(0, 2)).toEqual(['[panels] dropping tab old: not a chat tab', '[panels] chat a: dropping a malformed browser pane']);
  });
});
