import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => (await import('./fake-overlay-electron')).fakeOverlayElectron());

import { OVERLAY_CHANNELS, type CloseRemoteRow } from '../../preload/overlay-channels';
import { closeRemoteResult, OverlayHost, parseCloseRemoteRequest, parseCloseRemoteRows, parseOverlayAnswer } from '../overlay';
import { OVERLAY_PAGE_URL } from '../protocol';
import { fakeOverlayWindow, type FakeOverlayView } from './fake-overlay-electron';
import { DESKTOP_CONFIGURATION, REMOTE_CLOSE_WITH_RUNNING_AGENTS_SETTING } from '../../local-services/desktop-configuration';
import schema from '../../../shared/generated/settings-schema.json';

const ROW: CloseRemoteRow = { hostId: 'h1', panelId: 'p1', title: 'Rotate logs', projectLabel: 'api', hostLabel: 'prod-1', status: 'running' };

let host: OverlayHost;
let lines: string[];
const view = (): FakeOverlayView => host.view as unknown as FakeOverlayView;
const own = () => ({ sender: view().webContents, senderFrame: { url: OVERLAY_PAGE_URL, parent: null } });
const sentOn = (channel: string) => view().webContents.send.mock.calls.filter(([sent]) => sent === channel).map(([, payload]) => payload);
const lastRequestId = (): string => (sentOn(OVERLAY_CHANNELS.request).at(-1) as { requestId: string }).requestId;

beforeEach(() => {
  vi.useFakeTimers();
  lines = [];
  host = new OverlayHost({
    window: fakeOverlayWindow() as never,
    preloadPath: 'preload-overlay.js',
    state: () => ({ locale: 'en', platform: 'win32', remoteEnabled: false }),
    focusOutside: () => {},
    awaitActivation: () => {},
    popupsClosed: () => {},
    canRasterize: () => {},
    log: (line) => lines.push(line),
  });
  host.load();
  view().webContents.emit('did-finish-load');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('closeRemote request', () => {
  it('takes rows within the bounds with unique panels, a token note naming a provider id and the linger flag', () => {
    const row = { ...ROW, tokenNote: { provider: 'anthropic', minutesLeft: 23 }, lingerWarning: true as const };
    expect(parseCloseRemoteRequest([row])).toEqual({ kind: 'closeRemote', rows: [row] });
    expect(parseCloseRemoteRequest([])).toBeUndefined();
    expect(parseCloseRemoteRequest([ROW, ROW])).toBeUndefined();
    expect(parseCloseRemoteRows([{ ...ROW, status: 'stopped' }])).toBeUndefined();
    expect(parseCloseRemoteRows([{ ...ROW, tokenNote: { provider: 'a b', minutesLeft: 3 } }])).toBeUndefined();
    expect(parseCloseRemoteRows([{ ...ROW, tokenNote: { provider: 'anthropic', minutesLeft: 2.5 } }])).toBeUndefined();
    expect(parseCloseRemoteRows([{ ...ROW, lingerWarning: false }])).toBeUndefined();
    expect(parseCloseRemoteRows([{ ...ROW, title: 'x'.repeat(201) }])).toBeUndefined();
  });

  it('answers keep or stop with Don\'t ask again, and cancel only without it; dismissed is Cancel', () => {
    const request = parseCloseRemoteRequest([ROW])!;
    expect(parseOverlayAnswer({ kind: 'closeRemote', choice: 'keep', dontAskAgain: true }, request)).toEqual({ kind: 'closeRemote', choice: 'keep', dontAskAgain: true });
    expect(parseOverlayAnswer({ kind: 'closeRemote', choice: 'stop', dontAskAgain: false }, request)).toEqual({ kind: 'closeRemote', choice: 'stop', dontAskAgain: false });
    expect(parseOverlayAnswer({ kind: 'closeRemote', choice: 'cancel', dontAskAgain: true }, request)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'closeRemote', choice: 'quit', dontAskAgain: false }, request)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'closeRemote', choice: 'keep', dontAskAgain: true, extra: 1 }, request)).toBeUndefined();
    expect(closeRemoteResult({ kind: 'dismissed' })).toEqual({ choice: 'cancel', dontAskAgain: false });
    expect(closeRemoteResult({ kind: 'closeRemote', choice: 'stop', dontAskAgain: true })).toEqual({ choice: 'stop', dontAskAgain: true });
  });

  it('resolves with the page\'s answer, stays open under a menu the shell asks for, and gets live rows only while open', async () => {
    const answer = host.request(parseCloseRemoteRequest([ROW])!, undefined);
    const id = lastRequestId();
    view().webContents.ipc.emit(OVERLAY_CHANNELS.ack, own(), id);
    const menu = host.request({ kind: 'menu', label: 'Actions', anchor: { x: 0, y: 0, width: 1, height: 1 }, items: [{ kind: 'item', id: 'a', label: 'A' }] }, undefined);
    expect(host.isOpen('closeRemote')).toBe(true);
    host.updateCloseRemote([{ ...ROW, status: 'signIn', tokenNote: { provider: 'anthropic', minutesLeft: 0 } }]);
    expect(sentOn(OVERLAY_CHANNELS.closeRemoteRows)).toEqual([[{ ...ROW, status: 'signIn', tokenNote: { provider: 'anthropic', minutesLeft: 0 } }]]);
    host.updateCloseRemote([ROW, ROW]);
    expect(sentOn(OVERLAY_CHANNELS.closeRemoteRows)).toHaveLength(1);
    expect(lines.at(-1)).toContain('close dialog rows exceed the overlay bounds');
    view().webContents.ipc.emit(OVERLAY_CHANNELS.answer, own(), id, { kind: 'closeRemote', choice: 'keep', dontAskAgain: true });
    await expect(answer).resolves.toEqual({ kind: 'closeRemote', choice: 'keep', dontAskAgain: true });
    host.updateCloseRemote([{ ...ROW, status: 'idle' }]);
    expect(sentOn(OVERLAY_CHANNELS.closeRemoteRows)).toHaveLength(1);
    void menu;
  });
});

describe('closeWithRunningAgents setting', () => {
  it('is ask, keep or stop from user settings, ask by default, and in the generated schema', () => {
    const setting = DESKTOP_CONFIGURATION[REMOTE_CLOSE_WITH_RUNNING_AGENTS_SETTING]!;
    expect(setting).toMatchObject({ type: 'string', enum: ['ask', 'keep', 'stop'], default: 'ask', scope: 'application' });
    expect(JSON.stringify(schema)).toContain(`"${REMOTE_CLOSE_WITH_RUNNING_AGENTS_SETTING}"`);
  });
});
