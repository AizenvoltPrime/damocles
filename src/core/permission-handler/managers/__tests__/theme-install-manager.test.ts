import { describe, expect, it } from 'vitest';
import { ThemeInstallManager, type ThemeInstallAsk } from '../theme-install-manager';
import { PermissionState } from '../../state';
import { PermissionHandler } from '../..';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import type { ExtensionToWebviewMessage } from '../../../../shared/types/messages';
import type { ThemeInstallPreview } from '../../../../shared/themes/install';
import { getPiCodingAgent } from '../../../pi-session/pi-loader';
import { pendingPromptDescriber } from '../../../pi-session/pending-prompts';

const PREVIEW: ThemeInstallPreview = {
  installId: '7a9c3f00-1111-4222-8333-444455556666',
  source: { kind: 'agent', host: 'themes.example', fileName: 'aurora.damocles-theme' },
  format: 'damocles',
  about: { name: 'Aurora Borealis' },
  theme: { schemaVersion: 1, id: '0a1b2c3d-1111-4222-8333-444455556666', name: 'Aurora Borealis', looks: { dark: { colors: { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' } } } },
  wallpapers: [],
  fonts: [],
  css: [],
  arrangement: true,
  contrast: [],
  totalBytes: 1234,
  warnings: [],
};
const CLASH = { themeId: '1b2c3d4e-1111-4222-8333-444455556666', name: 'Aurora Borealis', keepBothName: 'Aurora Borealis 2', replaceable: true, keepsCopy: false };
const ASK: ThemeInstallAsk = { toolUseId: 'call-1', preview: PREVIEW };
const noAllow = (): void => undefined;
const SHA = 'a'.repeat(64);
const WALLPAPER: ThemeInstallPreview['wallpapers'][number] = {
  sha256: SHA, kind: 'animated', mime: 'image/gif', bytes: 900, width: 64, height: 64, frames: 40, placements: [{ look: 'dark', panels: ['chat'], span: false }], flash: 'flagged', atMs: 1200, thumb: 'data:image/webp;base64,AAAA',
};

function setup(attached = true) {
  const state = new PermissionState();
  const posted: ExtensionToWebviewMessage[] = [];
  let changes = 0;
  state.onPendingChanged = () => changes++;
  const post = (): ((m: ExtensionToWebviewMessage) => void) | null => (attached ? (m) => posted.push(m) : null);
  return { state, posted, manager: new ThemeInstallManager(state, post), changes: () => changes };
}

type Request = Extract<ExtensionToWebviewMessage, { type: 'requestThemeInstall' }>;
const request = (posted: ExtensionToWebviewMessage[]): Request => posted.find((m): m is Request => m.type === 'requestThemeInstall')!;
const closed = (posted: ExtensionToWebviewMessage[]) => posted.filter((m) => m.type === 'themeInstallClosed');

describe('ThemeInstallManager', () => {
  it('raises a themeInstall card with the preview and the chat as owner; Install closes it on every view', async () => {
    const { state, posted, manager } = setup();
    const card = manager.open(ASK, new AbortController().signal, noAllow);
    const sent = request(posted);
    expect(sent).toEqual({ type: 'requestThemeInstall', promptId: card.promptId, toolUseId: 'call-1', preview: PREVIEW, owner: { kind: 'main' } });
    expect(state.pendingPrompts()).toEqual([{ id: card.promptId, kind: 'themeInstall', request: sent }]);
    const answer = card.answer();
    manager.resolveThemeInstall(card.promptId, { choice: 'install', useArrangement: true });
    expect(await answer).toEqual({ choice: 'install', useArrangement: true });
    expect(state.pendingPrompts()).toEqual([]);
    expect(closed(posted)).toEqual([{ type: 'themeInstallClosed', promptId: card.promptId }]);
  });

  it('answers Cancel, and ignores a later answer', async () => {
    const { manager } = setup();
    const card = manager.open(ASK, new AbortController().signal, noAllow);
    const answer = card.answer();
    manager.resolveThemeInstall(card.promptId, { choice: 'cancel' });
    manager.resolveThemeInstall(card.promptId, { choice: 'install', useArrangement: false });
    expect(await answer).toEqual({ choice: 'cancel' });
  });

  it('on a name clash takes Install only with Keep both or Replace, and never Replace of a built-in', async () => {
    const { state, manager } = setup();
    const card = manager.open({ ...ASK, preview: { ...PREVIEW, clash: CLASH } }, new AbortController().signal, noAllow);
    const answer = card.answer();
    manager.resolveThemeInstall(card.promptId, { choice: 'install', useArrangement: false });
    expect(state.pendingPrompts()).toHaveLength(1);
    manager.resolveThemeInstall(card.promptId, { choice: 'install', onClash: 'replace', useArrangement: false });
    expect(await answer).toEqual({ choice: 'install', onClash: 'replace', useArrangement: false });

    const builtin = manager.open({ ...ASK, preview: { ...PREVIEW, clash: { ...CLASH, replaceable: false } } }, new AbortController().signal, noAllow);
    const second = builtin.answer();
    manager.resolveThemeInstall(builtin.promptId, { choice: 'install', onClash: 'replace', useArrangement: false });
    expect(state.pendingPrompts()).toHaveLength(1);
    manager.resolveThemeInstall(builtin.promptId, { choice: 'install', onClash: 'keepBoth', useArrangement: false });
    expect(await second).toEqual({ choice: 'install', onClash: 'keepBoth', useArrangement: false });
  });

  it('answers an Install it does not take with the card as it stands, so a clash that arrived under the press shows and Cancel still works', async () => {
    const { state, posted, manager } = setup();
    const card = manager.open(ASK, new AbortController().signal, noAllow);
    const answer = card.answer();
    const clashing = { ...PREVIEW, clash: CLASH };
    card.update(clashing);
    posted.length = 0;
    manager.resolveThemeInstall(card.promptId, { choice: 'install', useArrangement: false });
    expect(posted).toEqual([{ type: 'requestThemeInstall', promptId: card.promptId, toolUseId: 'call-1', preview: clashing, owner: { kind: 'main' } }]);
    card.update({ ...clashing, clash: { ...CLASH, replaceable: false } });
    manager.resolveThemeInstall(card.promptId, { choice: 'install', onClash: 'replace', useArrangement: false });
    expect(posted.at(-1)).toMatchObject({ type: 'requestThemeInstall', preview: { clash: { replaceable: false } } });
    expect(state.pendingPrompts()).toHaveLength(1);
    manager.resolveThemeInstall(card.promptId, { choice: 'cancel' });
    expect(await answer).toEqual({ choice: 'cancel' });
    expect(closed(posted)).toHaveLength(1);
    // an answer for a card no longer open is answered with the close
    manager.resolveThemeInstall(card.promptId, { choice: 'install', onClash: 'keepBoth', useArrangement: false });
    expect(closed(posted)).toHaveLength(2);
  });

  it('drops a clash choice the preview has no clash for, and the arrangement switch when the theme has no arrangement', async () => {
    const { manager } = setup();
    const card = manager.open({ ...ASK, preview: { ...PREVIEW, arrangement: false } }, new AbortController().signal, noAllow);
    const answer = card.answer();
    manager.resolveThemeInstall(card.promptId, { choice: 'install', onClash: 'replace', useArrangement: true });
    expect(await answer).toEqual({ choice: 'install', useArrangement: false });
  });

  it('sends a new preview of the same install to every view and keeps it for a returning webview', () => {
    const { state, posted, manager } = setup();
    const card = manager.open(ASK, new AbortController().signal, noAllow);
    const next = { ...PREVIEW, totalBytes: 99 };
    card.update(next);
    card.update({ ...PREVIEW, installId: 'another' });
    expect(posted.filter((m) => m.type === 'themeInstallUpdated')).toEqual([{ type: 'themeInstallUpdated', promptId: card.promptId, preview: next }]);
    expect(state.pendingPrompts()[0]!.request).toMatchObject({ preview: { totalBytes: 99 } });
  });

  it('closes on every view when its signal ends, ending the wait with undefined', async () => {
    const { state, posted, manager } = setup();
    const controller = new AbortController();
    const card = manager.open(ASK, controller.signal, noAllow);
    const answer = card.answer();
    controller.abort();
    expect(await answer).toBeUndefined();
    expect(state.pendingPrompts()).toEqual([]);
    expect(closed(posted)).toHaveLength(1);
    manager.resolveThemeInstall(card.promptId, { choice: 'install', useArrangement: false });
    expect(await card.answer()).toBeUndefined();
  });

  it('raises nothing on a signal that already ended', async () => {
    const { state, posted, manager } = setup();
    const controller = new AbortController();
    controller.abort();
    const card = manager.open(ASK, controller.signal, noAllow);
    expect(await card.answer()).toBeUndefined();
    expect(state.pendingPrompts()).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('waits with no webview attached, and every add and remove reaches the session-state publisher', () => {
    const { state, posted, manager, changes } = setup(false);
    const card = manager.open(ASK, new AbortController().signal, noAllow);
    expect(posted).toEqual([]);
    expect(state.pendingPrompts()).toHaveLength(1);
    card.close();
    expect(state.pendingPrompts()).toEqual([]);
    expect(changes()).toBe(2);
  });

  it('runs Allow flashing for this file only for a wallpaper the card lists as flagged and not yet allowed, and posts each check\'s progress', () => {
    const { posted, manager } = setup();
    const allowed: string[] = [];
    const pending = { ...WALLPAPER, sha256: 'b'.repeat(64), flash: 'pending' as const };
    const card = manager.open({ ...ASK, preview: { ...PREVIEW, wallpapers: [WALLPAPER, pending] } }, new AbortController().signal, (sha) => allowed.push(sha));
    manager.allowFlash(card.promptId, 'b'.repeat(64));
    manager.allowFlash(card.promptId, 'c'.repeat(64));
    manager.allowFlash('themeinstall-gone', SHA);
    expect(allowed).toEqual([]);
    manager.allowFlash(card.promptId, SHA);
    expect(allowed).toEqual([SHA]);
    card.update({ ...PREVIEW, wallpapers: [{ ...WALLPAPER, allowed: true }, pending] });
    manager.allowFlash(card.promptId, SHA);
    expect(allowed).toEqual([SHA]);
    card.progress('b'.repeat(64), 0.4);
    expect(posted.at(-1)).toEqual({ type: 'themeInstallProgress', promptId: card.promptId, sha256: 'b'.repeat(64), fraction: 0.4 });
    card.close();
    card.progress('b'.repeat(64), 0.6);
    expect(posted.filter((m) => m.type === 'themeInstallProgress')).toHaveLength(1);
  });

  it("on a daemon's core, which holds no Allow, a press from the device the install lands on allows nothing", () => {
    const state = new PermissionState();
    state.postToDevices = () => undefined;
    const manager = new ThemeInstallManager(state, () => () => undefined, () => 'pinned');
    const card = manager.open({ ...ASK, preview: { ...PREVIEW, wallpapers: [WALLPAPER] }, device: { clientId: 'pinned', computer: 'laptop' } }, new AbortController().signal, undefined);
    expect(() => manager.allowFlash(card.promptId, SHA)).not.toThrow();
    expect(state.pendingThemeInstalls.get(card.promptId)).not.toHaveProperty('allowFlash');
    card.close();
  });

  it('a remote chat\'s card: the device it lands on gets it whole; another device gets it without images, naming the computer, and its Install and Allow do not count', async () => {
    const state = new PermissionState();
    const perDevice: Array<(clientId: string | undefined) => ExtensionToWebviewMessage | undefined> = [];
    state.postToDevices = (message) => perDevice.push(message);
    let actor: string | undefined = 'other';
    const allowed: string[] = [];
    const manager = new ThemeInstallManager(state, () => () => undefined, () => actor);
    const card = manager.open({ ...ASK, preview: { ...PREVIEW, wallpapers: [WALLPAPER] }, device: { clientId: 'pinned', computer: 'laptop' } }, new AbortController().signal, (sha) => allowed.push(sha));
    const mine = perDevice[0]!('pinned') as Request;
    const theirs = perDevice[0]!('other') as Request;
    expect(mine.preview.wallpapers[0]!.thumb).toBe(WALLPAPER.thumb);
    expect(mine.otherDevice).toBeUndefined();
    expect(theirs.preview.wallpapers[0]).not.toHaveProperty('thumb');
    expect(theirs.otherDevice).toEqual({ computer: 'laptop' });
    const answer = card.answer();
    manager.allowFlash(card.promptId, SHA);
    manager.resolveThemeInstall(card.promptId, { choice: 'install', useArrangement: false });
    expect(allowed).toEqual([]);
    expect(state.pendingPrompts()).toHaveLength(1);
    // the Install that did not count is answered with each device's own card
    expect(perDevice[1]!('other')).toEqual(theirs);
    expect(perDevice[1]!('pinned')).toEqual(mine);
    card.update({ ...PREVIEW, wallpapers: [{ ...WALLPAPER, allowed: true }] });
    expect((perDevice[2]!('other') as Extract<ExtensionToWebviewMessage, { type: 'themeInstallUpdated' }>).preview.wallpapers[0]).not.toHaveProperty('thumb');
    expect((perDevice[2]!('pinned') as Extract<ExtensionToWebviewMessage, { type: 'themeInstallUpdated' }>).preview.wallpapers[0]).toMatchObject({ thumb: WALLPAPER.thumb, allowed: true });
    actor = 'pinned';
    manager.resolveThemeInstall(card.promptId, { choice: 'install', useArrangement: false });
    expect(await answer).toEqual({ choice: 'install', useArrangement: false });
  });

  it('summarizes the card for a notification by the theme\'s cleaned name', () => {
    const { state, manager } = setup();
    manager.open(ASK, new AbortController().signal, noAllow);
    expect(pendingPromptDescriber('/work')(state.pendingPrompts())).toEqual([expect.objectContaining({ kind: 'themeInstall', summary: { message: 'install the theme {0}', args: ['Aurora Borealis'] } })]);
  });
});

describe('PermissionHandler and the install card', () => {
  it('asks with YOLO on, no mode change answers it, a returning webview gets it again and dispose closes it', async () => {
    const handler = new PermissionHandler(createFakePlatform(), getPiCodingAgent);
    const posted: ExtensionToWebviewMessage[] = [];
    handler.setPostMessage((m) => posted.push(m));
    expect(handler.setDangerouslySkipPermissions(true)).toBe(true);
    const card = handler.openThemeInstall(ASK, new AbortController().signal, noAllow);
    const answer = card.answer();
    handler.setPermissionMode('plan');
    handler.setPermissionMode('acceptEdits');
    expect(handler.pendingPrompts().map((p) => p.kind)).toEqual(['themeInstall']);
    posted.length = 0;
    handler.repostPendingPrompts();
    expect(posted.map((m) => m.type)).toEqual(['requestThemeInstall']);
    await handler.dispose();
    expect(await answer).toBeUndefined();
    expect(handler.pendingPrompts()).toEqual([]);
    expect(posted.map((m) => m.type)).toContain('themeInstallClosed');
  });

  it('passes the answer from any view', async () => {
    const handler = new PermissionHandler(createFakePlatform(), getPiCodingAgent);
    const card = handler.openThemeInstall(ASK, new AbortController().signal, noAllow);
    const answer = card.answer();
    handler.resolveThemeInstall(card.promptId, { choice: 'cancel' });
    expect(await answer).toEqual({ choice: 'cancel' });
  });
});
