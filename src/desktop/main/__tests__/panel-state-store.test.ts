import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_BROWSER_URL_LENGTH } from '../../../shared/typed-address';
import { NO_PAGES, PANEL_STATE_FILE, PanelStateStore } from '../panel-state-store';
import { flushAcrossHeldRename } from '../../../__mocks__/held-rename';

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
    expect(next.get('b')).toEqual({ panelId: 'b', state: { sessionId: 's2' }, browser: NO_PAGES });
    expect(next.selected()).toEqual({ projectKey: 'k1', panelId: 'a', sessionId: 's1' });
  });

  it('flush settles once every write started so far has landed, failed ones included', async () => {
    const store = new PanelStateStore(dir, log);
    store.set({ panelId: 'a', state: { sessionId: 's1' } });
    store.set({ panelId: 'a', state: { sessionId: 's2' } });
    await store.flush();
    expect(new PanelStateStore(dir, log).get('a')?.state).toEqual({ sessionId: 's2' });

    // A file where the folder was makes the next write fail.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, '');
    store.set({ panelId: 'a', state: { sessionId: 's3' } });
    await expect(store.flush()).resolves.toBeUndefined();
    expect(lines.some((line) => line.startsWith('[panels] failed to write'))).toBe(true);
    fs.rmSync(dir, { force: true });
    fs.mkdirSync(dir);
  });

  it('flush waits for a write in flight and for one queued while it waits', async () => {
    const store = new PanelStateStore(dir, log);
    const onDisk = await flushAcrossHeldRename(path.join(dir, PANEL_STATE_FILE), {
      first: () => store.set({ panelId: 'a', state: { sessionId: 's1' } }),
      flush: () => store.flush(),
      second: () => store.set({ panelId: 'a', state: { sessionId: 's2' } }),
      onDisk: () => new PanelStateStore(dir, log).get('a')?.state,
    });
    expect(onDisk).toEqual({ sessionId: 's2' });
  });

  it('writes version 2 with the selection and each chat flat', async () => {
    const store = new PanelStateStore(dir, log);
    store.set({ panelId: 'a', state: { sessionId: 's' } });
    store.setPages('a', { pages: ['https://a.example/'], activePage: 0 });
    store.select({ projectKey: 'k1', sessionId: 's', panelId: 'a' });
    await settled();
    expect(JSON.parse(fs.readFileSync(path.join(dir, PANEL_STATE_FILE), 'utf8'))).toEqual({
      version: 2,
      selected: { projectKey: 'k1', sessionId: 's', panelId: 'a' },
      chats: [{ panelId: 'a', state: { sessionId: 's' }, pages: ['https://a.example/'], activePage: 0 }],
    });
  });

  it('round-trips each chat\'s pages, and a state update keeps them', async () => {
    const store = new PanelStateStore(dir, log);
    store.set({ panelId: 'a', state: null });
    store.set({ panelId: 'b', state: null });
    store.setPages('a', { pages: ['https://a.example/', 'about:blank'], activePage: 1 });
    store.set({ panelId: 'a', state: { sessionId: 's' } });
    store.setPages('missing', { pages: ['https://x.example/'] });

    const next = await reopened();
    expect(next.get('a')?.browser).toEqual({ pages: ['https://a.example/', 'about:blank'], activePage: 1 });
    expect(next.get('a')?.state).toEqual({ sessionId: 's' });
    expect(next.get('b')?.browser).toEqual(NO_PAGES);
    expect(next.get('missing')).toBeUndefined();
  });

  it('reads a file that still carries the retired pane fields and writes it without them', async () => {
    writeFile({ version: 2, chats: [{ panelId: 'a', state: null, pages: ['https://a.example/'], activePage: 0, paneOpen: true, paneMaximized: true }], paneWidth: 612 });
    const store = new PanelStateStore(dir, log);
    expect(store.get('a')).toEqual({ panelId: 'a', state: null, browser: { pages: ['https://a.example/'], activePage: 0 } });
    expect(lines).toEqual([]);
    store.set({ panelId: 'a', state: { sessionId: 's' } });
    await settled();
    expect(JSON.parse(fs.readFileSync(path.join(dir, PANEL_STATE_FILE), 'utf8'))).toEqual({
      version: 2,
      chats: [{ panelId: 'a', state: { sessionId: 's' }, pages: ['https://a.example/'], activePage: 0 }],
    });
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
        { panelId: 'a', state: null, pages: ['https://ok.example/', 42, '', 'x'.repeat(MAX_BROWSER_URL_LENGTH + 1), 'https://two.example/'], activePage: 4, paneOpen: true },
        { panelId: '../evil', state: null },
        { panelId: 'b', state: 'not an object', pages: 'nonsense' },
        { panelId: 'a', state: null },
        'junk',
      ],
    });
    const store = new PanelStateStore(dir, log);
    expect(store.list().map((chat) => chat.panelId)).toEqual(['a', 'b']);
    expect(store.get('a')?.browser).toEqual({ pages: ['https://ok.example/', 'https://two.example/'], activePage: 1 });
    expect(store.get('b')).toEqual({ panelId: 'b', state: null, browser: NO_PAGES });
    expect(store.selected()).toEqual({ projectKey: 'k1' });
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
    fs.writeFileSync(path.join(dir, PANEL_STATE_FILE), '{"version":2,"chats":[{"panelId":"a","state":null,"__proto__":{"pages":["https://evil.example/"]}}]}');
    expect(new PanelStateStore(dir, log).get('a')?.browser).toEqual(NO_PAGES);
  });
});

describe('PanelStateStore across a quit or a window close', () => {
  it('keeps the chats and the selection from before the teardown while sealed, and writes again once unsealed', async () => {
    const store = new PanelStateStore(dir, log);
    store.set({ panelId: 'a', state: { sessionId: 's1' } });
    store.select({ projectKey: 'k1', panelId: 'a', sessionId: 's1' });
    await store.flush();
    const before = fs.readFileSync(path.join(dir, PANEL_STATE_FILE), 'utf8');

    store.seal();
    store.set({ panelId: 'new', state: null });
    store.setPages('a', { pages: ['https://a.example/'], activePage: 0 });
    store.select({ projectKey: 'k2', panelId: 'new' });
    store.delete('a');
    await store.flush();
    expect(store.list().map((chat) => chat.panelId)).toEqual(['a']);
    expect(store.get('a')?.browser).toEqual(NO_PAGES);
    expect(store.selected()).toEqual({ projectKey: 'k1', panelId: 'a', sessionId: 's1' });
    expect(fs.readFileSync(path.join(dir, PANEL_STATE_FILE), 'utf8')).toBe(before);

    store.unseal();
    store.select({ projectKey: 'k2', panelId: 'a' });
    expect((await reopened()).selected()).toEqual({ projectKey: 'k2', panelId: 'a' });
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
      { panelId: 'a', state: { workspaceFolderKey: 'k1' }, browser: { pages: ['https://a.example/'], activePage: 0 } },
      { panelId: 'b', state: { workspaceFolderKey: 'k2', sessionId: 's2' }, browser: NO_PAGES },
    ]);
    expect(store.selected()).toEqual({ projectKey: 'k2', panelId: 'b', sessionId: 's2' });
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
    expect(store.list()).toEqual([{ panelId: 'a', state: null, browser: NO_PAGES }]);
    expect(store.selected()).toBeUndefined();
    expect(lines.slice(0, 2)).toEqual(['[panels] dropping tab old: not a chat tab', '[panels] chat a: dropping a malformed browser pane']);
  });
});
