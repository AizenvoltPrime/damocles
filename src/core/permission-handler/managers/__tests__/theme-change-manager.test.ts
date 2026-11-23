import { describe, expect, it, vi } from 'vitest';
import { ThemeChangeManager, type ThemeChangeAsk } from '../theme-change-manager';
import { ThemeScreenshotManager, type ThemeScreenshotAsk } from '../theme-screenshot-manager';
import { PermissionState } from '../../state';
import { PermissionHandler } from '../..';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import type { ExtensionToWebviewMessage } from '../../../../shared/types/messages';
import { getPiCodingAgent } from '../../../pi-session/pi-loader';

const ASK: ThemeChangeAsk = {
  toolUseId: 'call-1',
  action: 'theme',
  theme: { schemaVersion: 1, id: '0a1b2c3d-1111-4222-8333-444455556666', name: 'Amber Night', looks: { dark: { colors: { background: '#1a1410', panel: '#221a14', text: '#f4ede4', accent: '#f59e0b', success: '#22c55e', warning: '#eab308', danger: '#ef4444', info: '#3b82f6' } } } },
  themeName: 'Amber Night',
  looks: ['dark'],
  isNew: true,
  changes: [{ kind: 'color', look: 'dark', seed: 'accent', hex: '#f59e0b' }],
  contrast: [],
  state: 'waiting',
  planMode: false,
  canShowInWindow: true,
};

const SHOT: ThemeScreenshotAsk = { toolUseId: 'call-2', url: 'app://damocles/theme-shot/0123456789abcdef0123456789abcdef', width: 1600, height: 1000 };

function setup(attached = true) {
  const state = new PermissionState();
  const posted: ExtensionToWebviewMessage[] = [];
  let changes = 0;
  state.onPendingChanged = () => changes++;
  const post = (): ((m: ExtensionToWebviewMessage) => void) | null => (attached ? (m) => posted.push(m) : null);
  return { state, posted, manager: new ThemeChangeManager(state, post), shots: new ThemeScreenshotManager(state, post), changes: () => changes };
}

type Request = Extract<ExtensionToWebviewMessage, { type: 'requestThemeChange' }>;
const request = (posted: ExtensionToWebviewMessage[]): Request => posted.find((m): m is Request => m.type === 'requestThemeChange')!;
const closed = (posted: ExtensionToWebviewMessage[]) => posted.filter((m) => m.type === 'themeChangeClosed');

describe('ThemeChangeManager', () => {
  it('raises a themeChange card with the whole ask, the chat as owner and Show in window off, and hands the tool each answer', async () => {
    const { state, posted, manager } = setup();
    const card = manager.open(ASK, new AbortController().signal, () => undefined);
    const sent = request(posted);
    expect(sent).toEqual({ type: 'requestThemeChange', promptId: card.promptId, ...ASK, showInWindow: false, owner: { kind: 'main' } });
    expect(state.pendingPrompts()).toEqual([{ id: card.promptId, kind: 'themeChange', request: sent }]);
    const first = card.answer();
    manager.resolveThemeChange(card.promptId, 'apply', undefined);
    expect(await first).toEqual({ choice: 'apply' });
    // the card stays until its tool closes it, so an Apply that found the theme changed can turn it Outdated
    expect(state.pendingPrompts()).toHaveLength(1);
    card.close();
    expect(state.pendingPrompts()).toEqual([]);
    expect(closed(posted)).toEqual([{ type: 'themeChangeClosed', promptId: card.promptId }]);
  });

  it('keeps the card open for Change with a blank note, and passes a note on trimmed', async () => {
    const { manager } = setup();
    const card = manager.open(ASK, new AbortController().signal, () => undefined);
    const answer = card.answer();
    manager.resolveThemeChange(card.promptId, 'change', '   ');
    manager.resolveThemeChange(card.promptId, 'change', undefined);
    manager.resolveThemeChange(card.promptId, 'change', '  Warmer panels. ');
    expect(await answer).toEqual({ choice: 'change', note: 'Warmer panels.' });
  });

  it('an outdated card takes Discard only, and a returning webview gets the card in its current state', async () => {
    const { state, posted, manager } = setup();
    const card = manager.open(ASK, new AbortController().signal, () => undefined);
    card.update({ state: 'outdated' });
    expect(posted.at(-1)).toEqual({ type: 'themeChangeUpdated', promptId: card.promptId, state: 'outdated' });
    expect(state.pendingPrompts()[0]?.request).toMatchObject({ state: 'outdated' });
    const answer = card.answer();
    manager.resolveThemeChange(card.promptId, 'apply', undefined);
    manager.resolveThemeChange(card.promptId, 'change', 'again');
    manager.resolveThemeChange(card.promptId, 'discard', undefined);
    expect(await answer).toEqual({ choice: 'discard' });
  });

  it('runs the Show in window toggle through its tool, which reports the state, and a takeover note goes with the next on', () => {
    const { state, posted, manager } = setup();
    const toggle = vi.fn();
    const card = manager.open(ASK, new AbortController().signal, toggle);
    manager.setShowInWindow(card.promptId, true);
    expect(toggle).toHaveBeenCalledWith(true);
    card.update({ showInWindow: true });
    card.update({ showInWindow: false, showNote: 'takenOver' });
    expect(state.pendingPrompts()[0]?.request).toMatchObject({ showInWindow: false, showNote: 'takenOver' });
    card.update({ showInWindow: true });
    expect(state.pendingPrompts()[0]?.request).not.toHaveProperty('showNote');
    expect(posted.filter((m) => m.type === 'themeChangeUpdated')).toHaveLength(3);
    // a stop with no note takes the note away too, on the stored card a returning view gets as on a live one
    card.update({ showInWindow: false, showNote: 'forcedColors' });
    card.update({ showInWindow: false });
    expect(state.pendingPrompts()[0]?.request).toMatchObject({ showInWindow: false });
    expect(state.pendingPrompts()[0]?.request).not.toHaveProperty('showNote');
  });

  it('ignores Show in window on a card that cannot show, and an answer for a card it never raised', () => {
    const { manager } = setup();
    const toggle = vi.fn();
    const card = manager.open({ ...ASK, action: 'schedule', canShowInWindow: false }, new AbortController().signal, toggle);
    manager.setShowInWindow(card.promptId, true);
    manager.setShowInWindow('themechange-unknown', true);
    manager.resolveThemeChange('themechange-unknown', 'apply', undefined);
    expect(toggle).not.toHaveBeenCalled();
  });

  it('closes on every view when its signal ends, ending the wait with undefined; a later answer is answered with the close', async () => {
    const { state, posted, manager } = setup();
    const stop = new AbortController();
    const card = manager.open(ASK, stop.signal, () => undefined);
    const answer = card.answer();
    stop.abort();
    expect(await answer).toBeUndefined();
    expect(await card.answer()).toBeUndefined();
    expect(state.pendingPrompts()).toEqual([]);
    expect(closed(posted)).toHaveLength(1);
    manager.resolveThemeChange(card.promptId, 'apply', undefined);
    expect(closed(posted)).toHaveLength(2);
    card.close();
    expect(closed(posted)).toHaveLength(2);
  });

  it('says applying on every view from the Apply it took, takes no answer until its tool waits again, and answers each one with the card as it stands', async () => {
    const { state, posted, manager } = setup();
    const toggle = vi.fn();
    const card = manager.open(ASK, new AbortController().signal, toggle);
    const first = card.answer();
    manager.resolveThemeChange(card.promptId, 'apply', undefined);
    expect(await first).toEqual({ choice: 'apply' });
    expect(posted.at(-1)).toEqual({ type: 'themeChangeUpdated', promptId: card.promptId, state: 'applying' });
    expect(state.pendingPrompts()[0]?.request).toMatchObject({ state: 'applying' });

    const raised = request(posted);
    posted.length = 0;
    manager.resolveThemeChange(card.promptId, 'discard', undefined);
    manager.setShowInWindow(card.promptId, true);
    expect(toggle).not.toHaveBeenCalled();
    expect(posted).toEqual([{ ...raised, state: 'applying' }]);

    // the Discard sent during the Apply was not kept for the next wait
    let settled = false;
    const second = card.answer().then((answer) => {
      settled = true;
      return answer;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(posted.at(-1)).toEqual({ type: 'themeChangeUpdated', promptId: card.promptId, state: 'waiting' });
    manager.resolveThemeChange(card.promptId, 'discard', undefined);
    expect(await second).toEqual({ choice: 'discard' });
  });

  it('answers an answer it does not take with the card as it stands, and one for a card it does not hold with the close', () => {
    const { posted, manager } = setup();
    const card = manager.open(ASK, new AbortController().signal, () => undefined);
    void card.answer();
    card.update({ state: 'outdated' });
    posted.length = 0;
    manager.resolveThemeChange(card.promptId, 'apply', undefined);
    manager.resolveThemeChange(card.promptId, 'change', '  ');
    expect(posted).toHaveLength(2);
    for (const message of posted) expect(message).toMatchObject({ type: 'requestThemeChange', promptId: card.promptId, state: 'outdated' });
    manager.resolveThemeChange('themechange-unknown', 'discard', undefined);
    expect(posted.at(-1)).toEqual({ type: 'themeChangeClosed', promptId: 'themechange-unknown' });
  });

  it("a remote chat's card: another device is sent a new state alone, never Show in window, and its Apply is answered with its own card", async () => {
    const state = new PermissionState();
    let actor: string | undefined = 'device-a';
    const byDevice: Record<string, ExtensionToWebviewMessage[]> = { 'device-a': [], 'device-b': [] };
    state.postMessageToWebview = () => undefined;
    state.postToDevices = (messageFor) => {
      for (const device of ['device-a', 'device-b']) {
        const message = messageFor(device);
        if (message) byDevice[device]!.push(message);
      }
    };
    const manager = new ThemeChangeManager(state, () => state.postMessageToWebview, () => actor);
    const card = manager.open({ ...ASK, device: { clientId: 'device-a', computer: 'laptop' }, stageId: 'stage-1' }, new AbortController().signal, () => undefined);
    expect(byDevice['device-b']).toEqual([expect.objectContaining({ type: 'requestThemeChange', canShowInWindow: false, otherDevice: { computer: 'laptop' } })]);
    expect(byDevice['device-b']![0]).not.toHaveProperty('theme');

    card.update({ showInWindow: true });
    card.update({ showInWindow: false, showNote: 'takenOver' });
    expect(byDevice['device-a']!.slice(1)).toEqual([
      { type: 'themeChangeUpdated', promptId: card.promptId, showInWindow: true },
      { type: 'themeChangeUpdated', promptId: card.promptId, showInWindow: false, showNote: 'takenOver' },
    ]);
    expect(byDevice['device-b']).toHaveLength(1);

    const answer = card.answer();
    actor = 'device-b';
    manager.resolveThemeChange(card.promptId, 'apply', undefined);
    expect(byDevice['device-b']!.at(-1)).toMatchObject({ type: 'requestThemeChange', state: 'waiting', showInWindow: false, otherDevice: { computer: 'laptop' } });
    actor = 'device-a';
    manager.resolveThemeChange(card.promptId, 'apply', undefined);
    expect(await answer).toEqual({ choice: 'apply' });
    card.update({ state: 'outdated' });
    for (const device of ['device-a', 'device-b']) {
      expect(byDevice[device]!.slice(-2), device).toEqual([
        { type: 'themeChangeUpdated', promptId: card.promptId, state: 'applying' },
        { type: 'themeChangeUpdated', promptId: card.promptId, state: 'outdated' },
      ]);
    }
  });

  it('raises nothing on a signal that already ended', async () => {
    const { state, posted, manager } = setup();
    const stop = new AbortController();
    stop.abort();
    const card = manager.open(ASK, stop.signal, () => undefined);
    expect(await card.answer()).toBeUndefined();
    expect(state.pendingPrompts()).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('waits with no webview attached, and every add and remove reaches the session-state publisher', () => {
    const { state, manager, changes } = setup(false);
    const card = manager.open(ASK, new AbortController().signal, () => undefined);
    expect(state.pendingPrompts().map((p) => p.kind)).toEqual(['themeChange']);
    expect(changes()).toBe(1);
    card.close();
    expect(changes()).toBe(2);
  });
});

describe('ThemeScreenshotManager', () => {
  it('raises a themeScreenshot card and resolves with Allow or Deny; every view drops it', async () => {
    const { state, posted, shots } = setup();
    const allow = shots.requestThemeScreenshot(SHOT, new AbortController().signal);
    const sent = posted.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'requestThemeScreenshot' }> => m.type === 'requestThemeScreenshot')!;
    expect(sent).toEqual({ type: 'requestThemeScreenshot', promptId: sent.promptId, ...SHOT, owner: { kind: 'main' } });
    expect(state.pendingPrompts().map((p) => p.kind)).toEqual(['themeScreenshot']);
    shots.resolveThemeScreenshot(sent.promptId, 'allow');
    expect(await allow).toBe('allow');
    expect(posted.filter((m) => m.type === 'themeScreenshotClosed')).toHaveLength(1);
    // an answer for a card no longer open is answered with the close
    shots.resolveThemeScreenshot(sent.promptId, 'deny');
    expect(posted.filter((m) => m.type === 'themeScreenshotClosed')).toHaveLength(2);
  });

  it("a remote chat's card shows on the device whose window it shows alone, and only that device answers it, a reload included", async () => {
    const state = new PermissionState();
    let actor: string | undefined;
    const byDevice: Record<string, ExtensionToWebviewMessage[]> = { 'device-a': [], 'device-b': [] };
    state.postMessageToWebview = () => undefined;
    state.postToDevices = (messageFor) => {
      for (const device of ['device-a', 'device-b']) {
        const message = messageFor(device);
        if (message) byDevice[device]!.push(message);
      }
    };
    const shots = new ThemeScreenshotManager(state, () => state.postMessageToWebview, () => actor);
    const answer = shots.requestThemeScreenshot({ ...SHOT, device: { clientId: 'device-a' } }, new AbortController().signal);
    expect(byDevice['device-a']!.map((m) => m.type)).toEqual(['requestThemeScreenshot']);
    expect(byDevice['device-b']).toEqual([]);
    const [request] = state.pendingPromptRequests;
    state.postPrompt(request![0], request![1]);
    expect(byDevice['device-a']).toHaveLength(2);
    expect(byDevice['device-b']).toEqual([]);

    const sent = byDevice['device-a']![0] as Extract<ExtensionToWebviewMessage, { type: 'requestThemeScreenshot' }>;
    actor = 'device-b';
    shots.resolveThemeScreenshot(sent.promptId, 'allow');
    expect(state.pendingPrompts()).toHaveLength(1);
    actor = 'device-a';
    shots.resolveThemeScreenshot(sent.promptId, 'deny');
    expect(await answer).toBe('deny');
  });

  it("forgets how a remote chat's card is posted per device when the panel's prompts are cleared", async () => {
    const state = new PermissionState();
    state.postToDevices = () => undefined;
    const shots = new ThemeScreenshotManager(state, () => null, () => 'device-a');
    const answer = shots.requestThemeScreenshot({ ...SHOT, device: { clientId: 'device-a' } }, new AbortController().signal);
    expect(state.devicePrompts.size).toBe(1);
    state.clearAll();
    expect(await answer).toBeUndefined();
    expect(state.devicePrompts.size).toBe(0);
  });

  it('closes unanswered on abort', async () => {
    const { state, shots } = setup();
    const stop = new AbortController();
    const answer = shots.requestThemeScreenshot(SHOT, stop.signal);
    stop.abort();
    expect(await answer).toBeUndefined();
    expect(state.pendingPrompts()).toEqual([]);
  });
});

describe('PermissionHandler and the theme cards', () => {
  function handlerWith() {
    const handler = new PermissionHandler(createFakePlatform(), getPiCodingAgent);
    const posted: ExtensionToWebviewMessage[] = [];
    handler.setPostMessage((m) => posted.push(m));
    return { handler, posted };
  }

  it('ask with YOLO on, and no mode or YOLO change answers them', async () => {
    const { handler, posted } = handlerWith();
    expect(handler.setDangerouslySkipPermissions(true)).toBe(true);
    const card = handler.openThemeChange(ASK, new AbortController().signal, () => undefined);
    const shot = handler.requestThemeScreenshot(SHOT, new AbortController().signal);
    const answer = card.answer();
    handler.setPermissionMode('plan');
    handler.setPermissionMode('acceptEdits');
    handler.setDangerouslySkipPermissions(false);
    handler.setDangerouslySkipPermissions(true);
    expect(handler.pendingPrompts().map((p) => p.kind)).toEqual(['themeChange', 'themeScreenshot']);
    expect(posted.filter((m) => m.type === 'themeChangeClosed' || m.type === 'themeScreenshotClosed' || m.type === 'permissionAutoResolved')).toEqual([]);
    handler.resolveThemeChange(card.promptId, 'discard', undefined);
    expect(await answer).toEqual({ choice: 'discard' });
    const promptId = handler.pendingPrompts().find((p) => p.kind === 'themeScreenshot')!.id;
    handler.resolveThemeScreenshot(promptId, 'deny');
    expect(await shot).toBe('deny');
  });

  it('reposts the open cards to a webview that came back, and closes them on every view on dispose', async () => {
    const { handler, posted } = handlerWith();
    const card = handler.openThemeChange(ASK, new AbortController().signal, () => undefined);
    const shot = handler.requestThemeScreenshot(SHOT, new AbortController().signal);
    card.update({ state: 'outdated' });
    const sent = posted.filter((m) => m.type === 'requestThemeChange' || m.type === 'requestThemeScreenshot');
    posted.length = 0;
    handler.repostPendingPrompts();
    expect(posted.map((m) => m.type)).toEqual(['requestThemeChange', 'requestThemeScreenshot']);
    expect(posted[0]).toMatchObject({ state: 'outdated' });
    expect(posted[1]).toEqual(sent[1]);
    const answer = card.answer();
    await handler.dispose();
    expect(await answer).toBeUndefined();
    expect(await shot).toBeUndefined();
    expect(handler.pendingPrompts()).toEqual([]);
    expect(posted.map((m) => m.type)).toEqual(expect.arrayContaining(['themeChangeClosed', 'themeScreenshotClosed']));
  });
});
