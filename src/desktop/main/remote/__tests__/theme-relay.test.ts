import { describe, expect, it, vi } from 'vitest';
import {
  CLIENT_THEMES_OFF, MAX_COMPUTER_NAME_CHARS, MAX_RELAYED_THEME_PNG_BYTES, MAX_THEME_UPLOAD_BYTES, THEME_UPLOAD_CHUNK_BYTES, THEMES_FEATURE, USER_THEME_METHODS,
  type ThemeCommitAnswer, type ThemeShot, type ThemeShowEnded, type ThemeStageAnswer, type UserThemeCalls, type UserThemeMethod,
} from '../../../../shared/themes/relay';
import type { ThemeInstallCommitted, ThemeInstallPrepared, ThemeInstallPreview, ThemeInstallProgress } from '../../../../shared/themes/install';
import { SCREENSHOT_ANSWER_MS } from '../../../../shared/themes/agent';
import type { ThemeFile } from '../../../../shared/themes/schema';
import type { ThemeCaptureTaken } from '../../../core-protocol';
import { allowRelayedInstallFlash, CONSENT_FRESH_MS, RelayedConsents, RelayedInstalls, RelayedPreviews, relayTheme, type RelayPage, type ThemeRelayDeps } from '../theme-relay';

// A remote chat's theme tools on this computer (docs/invariants.md "Remote daemon and wire", user.theme): main refuses while
// the tools are off here, releases a screenshot, commits a card's change, installs and paints the window only on a press it
// saw its own page post, logs, and forwards to this computer's core with the host project the chat's folder maps to.

const AUTHORITY = 'ssh+prod-1';
const OTHER = 'ssh+other';
const signal = new AbortController().signal;
const CARD = { action: 'theme', themeName: 'Amber', looks: ['dark'], isNew: true, changes: [], contrast: [], planMode: false, canShowInWindow: true } as const;
const STAGED: ThemeStageAnswer = { kind: 'change', stageId: 'stage-1', onTheFly: false, details: { tool: 'ThemeSet' }, summary: { text: 'Draft d: Amber' }, card: CARD };

const INSTALL_ID = '7a9c3f00-1111-4222-8333-444455556666';
const PREVIEW = {
  installId: INSTALL_ID, source: { kind: 'agent', host: 'themes.example', fileName: 'a.damocles-theme' }, format: 'damocles', about: { name: 'Aurora' },
  theme: { schemaVersion: 1, id: 'aurora', name: 'Aurora', looks: {} }, wallpapers: [], fonts: [], css: [], arrangement: false, contrast: [], totalBytes: 10, warnings: [],
} as unknown as ThemeInstallPreview;
const SHOT: ThemeShot = { shotId: 'a'.repeat(32), url: `app://damocles/theme-shot/${'a'.repeat(32)}`, width: 1200, height: 800 };
const OWNER = { kind: 'main' };
const CHAT = { id: 'session-1', title: 'Warm' };
const DRAFT_THEME = { schemaVersion: 1, id: '7c9e6679-7425-40de-944b-e07fc1f90ae7', name: 'Draft', looks: {} };

const PAGE: RelayPage = { panelId: 'panel-1', authority: AUTHORITY };
const SECOND_PAGE: RelayPage = { panelId: 'panel-2', authority: AUTHORITY };
const OTHER_PAGE: RelayPage = { panelId: 'panel-9', authority: OTHER };

function installsWith(features: () => readonly string[] | undefined = () => [THEMES_FEATURE]) {
  const sendUpdated = vi.fn(async (_authority: string, _preview: ThemeInstallPreview) => undefined);
  const sendProgress = vi.fn(async (_authority: string, _progress: ThemeInstallProgress) => undefined);
  const sendExpired = vi.fn(async (_authority: string, _installId: string) => undefined);
  const log = vi.fn<(line: string) => void>();
  return { installs: new RelayedInstalls({ features, sendUpdated, sendProgress, sendExpired, log }), sendUpdated, sendProgress, sendExpired, log };
}

function deps(enabled = true, previews = new RelayedPreviews({ features: () => [THEMES_FEATURE], send: async () => undefined, log: () => undefined }), installs = installsWith().installs) {
  const log = vi.fn<(line: string) => void>();
  const clock = { now: 1_000_000 };
  const core = {
    'themes.relay.read': vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'read' }] })),
    'themes.relay.uploadStart': vi.fn(async () => ({ uploadId: 'up-1' })),
    'themes.relay.uploadChunk': vi.fn(async () => ({ received: 4, complete: true })),
    'themes.relay.stage': vi.fn(async (): Promise<ThemeStageAnswer> => STAGED),
    // as this computer's core answers a card's stage: applied on a press, refused without one
    'themes.relay.commit': vi.fn(async ({ pressed }: { readonly pressed?: boolean }): Promise<ThemeCommitAnswer> => (pressed === true ? { outcome: 'applied' } : { refused: 'Not applied' })),
    'themes.relay.discard': vi.fn(async () => undefined),
    'themes.relay.preview': vi.fn(async ({ on }: { readonly on: boolean }): Promise<UserThemeCalls['preview']['result']> => ({ showing: on })),
    'themes.relay.installPrepare': vi.fn(async (): Promise<ThemeInstallPrepared> => ({ preview: PREVIEW })),
    'themes.relay.installCommit': vi.fn(async (): Promise<ThemeInstallCommitted> => ({ installed: { themeId: 'aurora-2', name: 'Aurora', replaced: false } })),
    'themes.relay.installCancel': vi.fn(async () => undefined),
    'themes.relay.allowFlash': vi.fn(async () => ({ allowed: true })),
    'themes.relay.draftTheme': vi.fn(async (): Promise<{ readonly name: string; readonly theme: unknown } | { readonly refused: string }> => ({ name: 'Draft', theme: DRAFT_THEME })),
  };
  let taken = 0;
  const screenshots = {
    take: vi.fn(async (_ask: { readonly chat: { readonly id: string }; readonly theme?: unknown; readonly granted: boolean }): Promise<ThemeCaptureTaken> => {
      taken += 1;
      const shotId = String(taken).repeat(32).slice(0, 32);
      return { kind: 'shot', shot: taken === 1 ? SHOT : { shotId, url: `app://damocles/theme-shot/${shotId}`, width: 1200, height: 800 } };
    }),
    read: vi.fn(async (_shotId: string) => new Uint8Array([1])),
    drop: vi.fn(async (_shotId: string) => undefined),
  };
  const shotGone = vi.fn(async (_shotId: string) => undefined);
  const published: Array<[string, boolean]> = [];
  const served = new Map<string, unknown>();
  // the session each page shows; a page absent here has none yet
  const pageSessions = new Map<string, string>([[PAGE.panelId, CHAT.id], [SECOND_PAGE.panelId, CHAT.id]]);
  // main's check of a draft's theme before it paints or serves it
  const validated = vi.fn((theme: unknown) => theme as ThemeFile);
  const consents = new RelayedConsents({
    now: () => clock.now,
    publishGrant: (panelId, granted) => published.push([panelId, granted]),
    captureTheme: (captureId, theme) => (theme === undefined ? served.delete(captureId) : served.set(captureId, theme)),
    pageSession: (panelId) => pageSessions.get(panelId),
    log,
  });
  const relay: ThemeRelayDeps = {
    authority: AUTHORITY,
    enabled: () => enabled,
    computer: () => 'DESKTOP-7Q2',
    project: (folder) => (folder === '/srv/app' ? { key: `${AUTHORITY}|/srv/app`, name: 'app' } : undefined),
    core,
    validated,
    screenshots,
    shotGone,
    previews,
    installs,
    consents,
    log,
  };
  // a card message of the remote core on its way to a page: the JSON main delivers, parsed; undefined when main delivers none
  const show = (page: RelayPage, message: { readonly type: string; readonly [field: string]: unknown }): Record<string, unknown> | undefined => {
    const delivered = consents.card(page, message.type, JSON.stringify(message));
    return delivered === undefined ? undefined : JSON.parse(delivered) as Record<string, unknown>;
  };
  const press = (page: RelayPage, message: unknown, forwarded = true): void => consents.pressed(page, message, forwarded);
  return { relay, core, screenshots, shotGone, log, consents, clock, show, press, published, served, pageSessions, validated };
}

// a plain screenshot of the window for CHAT, which must be taken
async function takeShot(relay: ThemeRelayDeps): Promise<ThemeShot> {
  const taken = await relayTheme(relay, 'screenshotTake', { chat: CHAT }, signal);
  if (taken.kind !== 'shot') throw new Error(`no shot: ${taken.kind}`);
  return taken.shot;
}

const stageRequest = { tool: 'set' as const, input: {}, toolCallId: 'c', chat: { id: 's' }, planMode: false };
const changeCard = (promptId: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'requestThemeChange', promptId, toolUseId: 'tool-1', ...CARD, state: 'waiting', showInWindow: false, owner: OWNER, stageId: 'stage-1', ...extra });
const shotCard = (promptId: string, shot: ThemeShot = SHOT) => ({ type: 'requestThemeScreenshot', promptId, toolUseId: 'tool-1', url: shot.url, width: shot.width, height: shot.height, owner: OWNER });
const installCard = (promptId: string, preview: unknown = PREVIEW) => ({ type: 'requestThemeInstall', promptId, toolUseId: 'tool-1', preview, owner: OWNER });

const SAMPLE: { readonly [M in UserThemeMethod]: UserThemeCalls[M]['params'] } = {
  read: { request: {}, chat: 's' },
  uploadStart: { sessionId: 's', sha256: '0'.repeat(64), bytes: 1 },
  uploadChunk: { uploadId: 'up-1', offset: 0, data: new Uint8Array(1) },
  stage: stageRequest,
  commit: { stageId: 'stage-1' },
  discard: { stageId: 'stage-1' },
  preview: { stageId: 'stage-1', promptId: 'card-1', on: true },
  screenshotTake: { chat: CHAT },
  screenshotCapture: { captureId: 'capture-1' },
  screenshot: { shotId: SHOT.shotId },
  screenshotDrop: { shotId: SHOT.shotId },
  installPrepare: { url: 'https://themes.example/a.damocles-theme' },
  installCommit: { installId: INSTALL_ID, useArrangement: false, chat: { id: 's' } },
  installCancel: { installId: INSTALL_ID },
};

describe('the theme relay on this computer', () => {
  it('refuses every request while the theme tools are off here but those that only end something, and logs why', async () => {
    const { relay, core, screenshots, log } = deps(false);
    const ending: readonly UserThemeMethod[] = ['discard', 'screenshotDrop', 'installCancel'];
    for (const method of USER_THEME_METHODS.filter((candidate) => !ending.includes(candidate))) {
      await expect(relayTheme(relay, method, SAMPLE[method], signal), method).rejects.toThrow(CLIENT_THEMES_OFF);
      expect(log).toHaveBeenCalledWith(`[remote] user.theme.${method} refused for ${AUTHORITY}: the theme tools are off on this computer`);
    }
    for (const call of Object.values(core)) expect(call).not.toHaveBeenCalled();
    expect(screenshots.take).not.toHaveBeenCalled();
    expect(screenshots.read).not.toHaveBeenCalled();
    for (const method of ending) await relayTheme(relay, method, SAMPLE[method], signal);
    expect(core['themes.relay.discard']).toHaveBeenCalledWith({ authority: AUTHORITY, stageId: 'stage-1' }, signal);
    expect(core['themes.relay.installCancel']).toHaveBeenCalledWith({ authority: AUTHORITY, installId: INSTALL_ID }, signal);
    // the card's Change: the stage ends and its draft stays
    await relayTheme(relay, 'discard', { stageId: 'stage-1', keepDraft: true }, signal);
    expect(core['themes.relay.discard']).toHaveBeenLastCalledWith({ authority: AUTHORITY, stageId: 'stage-1', keepDraft: true }, signal);
  });

  // the notice names the chat from this computer's chat list, so a host never names another chat
  it("captures for the chat's id alone, whatever title the remote core put in the request", async () => {
    const { relay, screenshots } = deps();
    await relayTheme(relay, 'screenshotTake', { chat: { id: CHAT.id, title: 'Your bank chat' } } as UserThemeCalls['screenshotTake']['params'], signal);
    expect(screenshots.take).toHaveBeenCalledWith({ chat: { id: CHAT.id }, granted: false }, signal);
  });

  it("lets a preview's off through while the tools are off, so a proposal never stays painted", async () => {
    const { relay, core } = deps(false);
    await expect(relayTheme(relay, 'preview', { stageId: 'stage-1', promptId: 'card-1', on: false }, signal)).resolves.toEqual({ showing: false });
    expect(core['themes.relay.preview']).toHaveBeenCalledWith({ authority: AUTHORITY, stageId: 'stage-1', promptId: 'card-1', on: false }, signal);
  });

  it('forwards with the authority and the host project the folder maps to, never a folder of another project', async () => {
    const { relay, core } = deps();
    await relayTheme(relay, 'read', { request: { about: 'project' }, chat: 's', folder: '/srv/app' }, signal);
    expect(core['themes.relay.read']).toHaveBeenCalledWith({ authority: AUTHORITY, request: { about: 'project' }, chat: 's', project: { key: `${AUTHORITY}|/srv/app`, name: 'app' } }, signal);
    await relayTheme(relay, 'stage', { tool: 'set', input: { undo: true }, toolCallId: 'c', chat: { id: 's' }, planMode: false, folder: '/elsewhere' }, signal);
    expect(core['themes.relay.stage']).toHaveBeenCalledWith({ authority: AUTHORITY, request: { tool: 'set', input: { undo: true }, toolCallId: 'c', chat: { id: 's' }, planMode: false } }, signal);
  });

  it('bounds the sizes that reach this computer: an asset of at most 40 MB, chunks of at most 4 MB', async () => {
    const { relay, core } = deps();
    await expect(relayTheme(relay, 'uploadStart', { sessionId: 's', sha256: '0'.repeat(64), bytes: MAX_THEME_UPLOAD_BYTES + 1 }, signal)).rejects.toThrow(/at most 40 MB/);
    await expect(relayTheme(relay, 'uploadChunk', { uploadId: 'up-1', offset: 0, data: new Uint8Array(THEME_UPLOAD_CHUNK_BYTES + 1) }, signal)).rejects.toThrow(/at most 4 MB/);
    expect(core['themes.relay.uploadStart']).not.toHaveBeenCalled();
    expect(core['themes.relay.uploadChunk']).not.toHaveBeenCalled();
    await expect(relayTheme(relay, 'uploadChunk', { uploadId: 'up-1', offset: 0, data: new Uint8Array(THEME_UPLOAD_CHUNK_BYTES) }, signal)).resolves.toEqual({ received: 4, complete: true });
  });

  it('names this computer on a staged card, with the name bounded', async () => {
    const { relay, core } = deps();
    expect(await relayTheme(relay, 'stage', stageRequest, signal)).toMatchObject({ kind: 'change', computer: 'DESKTOP-7Q2' });
    const long = { ...deps().relay, core, computer: () => 'h'.repeat(200) };
    expect(await relayTheme(long, 'stage', stageRequest, signal)).toMatchObject({ computer: 'h'.repeat(MAX_COMPUTER_NAME_CHARS) });
  });

  it("answers a failure of this computer's core with a fixed sentence, a cancelled request's too, and keeps the original in this computer's log", async () => {
    const { relay, core, log } = deps();
    const leak = "EACCES: permission denied, open 'C:\\Users\\me\\.damocles\\themes\\drafts\\d.json'";
    core['themes.relay.stage'].mockRejectedValueOnce(new Error(leak));
    await expect(relayTheme(relay, 'stage', stageRequest, signal)).rejects.toThrow('The change could not be prepared on the computer that shows this chat.');
    expect(log).toHaveBeenCalledWith(`[remote] user.theme.stage for ${AUTHORITY} failed on this computer: ${leak}`);
    core['themes.relay.read'].mockRejectedValueOnce(new Error(leak));
    await expect(relayTheme(relay, 'read', { request: {}, chat: 's' }, signal)).rejects.toThrow('The theme could not be read on the computer that shows this chat.');
    const stopped = new AbortController();
    core['themes.relay.read'].mockImplementationOnce(async () => {
      stopped.abort();
      throw new Error(leak);
    });
    // the remote core cancels as it likes, so a cancel never buys the original
    await expect(relayTheme(relay, 'read', { request: {}, chat: 's' }, stopped.signal)).rejects.toThrow(/^The request was cancelled\.$/);
    expect(log).toHaveBeenLastCalledWith(`[remote] user.theme.read for ${AUTHORITY} failed on this computer: ${leak}`);
  });
});

// The window's screenshot leaves only for the authority that asked for it, once, after an Allow main saw on its own page.
describe("a remote chat's screenshot of this window", () => {
  const allowed = async () => {
    const made = deps();
    const shot = await takeShot(made.relay);
    expect(made.show(PAGE, shotCard('shot-card'))).toEqual(shotCard('shot-card'));
    return { ...made, shot };
  };
  const NOT_ALLOWED = 'The screenshot was not sent: nobody allowed it on the computer that shows this chat.';

  it('sends it once after the Allow pressed on a page of that host, then drops it', async () => {
    const { relay, screenshots, press, shot } = await allowed();
    expect(shot).toEqual(SHOT);
    press(PAGE, { type: 'resolveThemeScreenshot', promptId: 'shot-card', choice: 'allow' });
    await expect(relayTheme(relay, 'screenshot', { shotId: SHOT.shotId }, signal)).resolves.toEqual({ png: new Uint8Array([1]) });
    expect(screenshots.read).toHaveBeenCalledWith(SHOT.shotId, signal);
    expect(screenshots.drop).toHaveBeenCalledWith(SHOT.shotId);
    await expect(relayTheme(relay, 'screenshot', { shotId: SHOT.shotId }, signal)).rejects.toThrow(NOT_ALLOWED);
    expect(screenshots.read).toHaveBeenCalledTimes(1);
  });

  it('refuses it with no Allow, after Deny, and for an Allow that only the remote core reports', async () => {
    const { relay, screenshots, press } = await allowed();
    await expect(relayTheme(relay, 'screenshot', { shotId: SHOT.shotId }, signal)).rejects.toThrow(NOT_ALLOWED);
    press(PAGE, { type: 'resolveThemeScreenshot', promptId: 'shot-card', choice: 'allow' });
    press(PAGE, { type: 'resolveThemeScreenshot', promptId: 'shot-card', choice: 'deny' });
    await expect(relayTheme(relay, 'screenshot', { shotId: SHOT.shotId, allowed: true } as never, signal)).rejects.toThrow(NOT_ALLOWED);
    expect(screenshots.read).not.toHaveBeenCalled();
  });

  it("refuses another host's shot, and ignores an Allow from a page of another host or of another kind of card", async () => {
    const { relay, screenshots, press, show } = await allowed();
    const other = { ...relay, authority: OTHER };
    press(PAGE, { type: 'resolveThemeScreenshot', promptId: 'shot-card', choice: 'allow' });
    await expect(relayTheme(other, 'screenshot', { shotId: SHOT.shotId }, signal)).rejects.toThrow(NOT_ALLOWED);
    await relayTheme(other, 'screenshotDrop', { shotId: SHOT.shotId }, signal);
    expect(screenshots.drop).not.toHaveBeenCalled();
    await expect(relayTheme(relay, 'screenshot', { shotId: SHOT.shotId }, signal)).resolves.toEqual({ png: new Uint8Array([1]) });

    const again = await takeShot(relay);
    // the other host's page is shown a card that names this host's shot: it binds nothing there and is not delivered
    expect(show(OTHER_PAGE, shotCard('shot-card-2', again))).toBeUndefined();
    press(OTHER_PAGE, { type: 'resolveThemeScreenshot', promptId: 'shot-card-2', choice: 'allow' });
    expect(show(PAGE, shotCard('shot-card-2', again))).toBeDefined();
    press(PAGE, { type: 'resolveThemeChange', promptId: 'shot-card-2', choice: 'apply' });
    press(PAGE, { type: 'resolveThemeScreenshot', promptId: 'no-such-card', choice: 'allow' });
    await expect(relayTheme(relay, 'screenshot', { shotId: again.shotId }, signal)).rejects.toThrow(NOT_ALLOWED);
  });

  it('releases one of two reads in flight on one Allow', async () => {
    const { relay, press } = await allowed();
    press(PAGE, { type: 'resolveThemeScreenshot', promptId: 'shot-card', choice: 'allow' });
    const both = await Promise.allSettled([relayTheme(relay, 'screenshot', { shotId: SHOT.shotId }, signal), relayTheme(relay, 'screenshot', { shotId: SHOT.shotId }, signal)]);
    expect(both.map((read) => read.status)).toEqual(['fulfilled', 'rejected']);
  });

  it('refuses a PNG above 16 MiB, and the shot is gone', async () => {
    const { relay, screenshots, press } = await allowed();
    screenshots.read.mockResolvedValueOnce(new Uint8Array(MAX_RELAYED_THEME_PNG_BYTES + 1));
    press(PAGE, { type: 'resolveThemeScreenshot', promptId: 'shot-card', choice: 'allow' });
    await expect(relayTheme(relay, 'screenshot', { shotId: SHOT.shotId }, signal)).rejects.toThrow('The screenshot was not sent: it is larger than 16 MB.');
    expect(screenshots.drop).toHaveBeenCalledWith(SHOT.shotId);
  });

  it('never delivers a screenshot card that names no shot of that host, nor a card posted again for another shot', async () => {
    const { relay, screenshots, press, show } = deps();
    const harmless = { ...SHOT, url: 'app://damocles/theme-shot/00000000000000000000000000000000' };
    expect(show(PAGE, shotCard('p', harmless))).toBeUndefined();
    const first = await takeShot(relay);
    const second = await takeShot(relay);
    expect(show(PAGE, shotCard('p', first))).toEqual(shotCard('p', first));
    // the page keeps showing the first image under this prompt id, so the second shot never takes its Allow
    expect(show(PAGE, shotCard('p', second))).toBeUndefined();
    press(PAGE, { type: 'resolveThemeScreenshot', promptId: 'p', choice: 'allow' });
    await expect(relayTheme(relay, 'screenshot', { shotId: second.shotId }, signal)).rejects.toThrow(/nobody allowed it/);
    await expect(relayTheme(relay, 'screenshot', { shotId: first.shotId }, signal)).resolves.toEqual({ png: new Uint8Array([1]) });
    expect(screenshots.read).toHaveBeenCalledTimes(1);
  });

  it("shows the card with this computer's record of the shot, whatever size the remote core wrote", async () => {
    const { relay, show } = deps();
    await takeShot(relay);
    expect(show(PAGE, { ...shotCard('p'), width: 1, height: 1, extra: 'x' } as never)).toEqual(shotCard('p'));
  });

  it("keeps two shots per host, drops an evicted one from the store and tells the host's core, whose card still shows it, and drops only the caller's own", async () => {
    const { relay, screenshots, shotGone } = deps();
    const first = await takeShot(relay);
    const second = await takeShot(relay);
    expect(screenshots.drop).not.toHaveBeenCalled();
    await takeShot(relay);
    expect(screenshots.drop.mock.calls).toEqual([[first.shotId]]);
    expect(shotGone.mock.calls).toEqual([[first.shotId]]);
    await relayTheme(relay, 'screenshotDrop', { shotId: 'f'.repeat(32) }, signal);
    await relayTheme(relay, 'screenshotDrop', { shotId: first.shotId }, signal);
    expect(screenshots.drop).toHaveBeenCalledTimes(1);
    await relayTheme(relay, 'screenshotDrop', { shotId: second.shotId }, signal);
    expect(screenshots.drop).toHaveBeenLastCalledWith(second.shotId);
    expect(shotGone).toHaveBeenCalledTimes(1);
  });

  it("names the host whose shot the window's store let go of, once, and no host for a shot of this computer's own chat", async () => {
    const { relay, consents, press, show } = deps();
    const shot = await takeShot(relay);
    show(PAGE, shotCard('shot-card'));
    press(PAGE, { type: 'resolveThemeScreenshot', promptId: 'shot-card', choice: 'allow' });
    expect(consents.shotGone('f'.repeat(32))).toBeUndefined();
    expect(consents.shotGone(shot.shotId)).toBe(AUTHORITY);
    expect(consents.shotGone(shot.shotId)).toBeUndefined();
    await expect(relayTheme(relay, 'screenshot', { shotId: shot.shotId }, signal)).rejects.toThrow(NOT_ALLOWED);
  });
});

// docs/invariants.md "Desktop themes", the screenshot grant: this computer holds a remote chat's grant, set only by the Allow
// for this chat main saw pressed on its own page.
describe("a remote chat's screenshot grant on this computer", () => {
  const NOT_ALLOWED = 'The screenshot was not sent: nobody allowed it on the computer that shows this chat.';
  const CAPTURE_GONE = 'The draft was not captured: the computer that shows this chat no longer holds it. Ask for a new screenshot if it is still needed.';
  const draftCard = (promptId: string, captureId: string) => ({ type: 'requestThemeScreenshot', promptId, toolUseId: 'tool-1', draft: { name: 'Forged', theme: { id: 'x' } }, captureId, owner: OWNER });
  const allowChat = (promptId: string) => ({ type: 'resolveThemeScreenshot', promptId, choice: 'allowChat' });
  // a shot of CHAT whose card the page shows
  const shown = async (made: ReturnType<typeof deps>, promptId = 'shot-card') => {
    const shot = await takeShot(made.relay);
    made.show(PAGE, shotCard(promptId, shot));
    return shot;
  };

  it('is set only by a forwarded Allow for this chat on a card bound to a shot of that host, and then covers the next screenshot with no card', async () => {
    const made = deps();
    const { relay, consents, press, published, screenshots } = made;
    const first = await shown(made);
    press(PAGE, allowChat('shot-card'), false);
    press(OTHER_PAGE, allowChat('shot-card'));
    press(PAGE, allowChat('no-such-card'));
    press(PAGE, { type: 'resolveThemeScreenshot', promptId: 'shot-card', choice: 'allow' });
    expect(consents.granted(AUTHORITY, CHAT.id)).toBe(false);
    expect(published).toEqual([]);
    press(PAGE, allowChat('shot-card'));
    expect(consents.granted(AUTHORITY, CHAT.id)).toBe(true);
    expect(consents.granted(OTHER, CHAT.id)).toBe(false);
    expect(consents.granted(AUTHORITY, 'session-2')).toBe(false);
    expect(published).toEqual([[PAGE.panelId, true]]);
    // the press that granted also allows its own shot
    await expect(relayTheme(relay, 'screenshot', { shotId: first.shotId }, signal)).resolves.toEqual({ png: new Uint8Array([1]) });
    const next = await relayTheme(relay, 'screenshotTake', { chat: CHAT }, signal);
    expect(next).toMatchObject({ kind: 'shot', granted: true });
    expect(screenshots.take).toHaveBeenLastCalledWith({ chat: { id: CHAT.id }, granted: true }, signal);
    await expect(relayTheme(relay, 'screenshot', { shotId: next.kind === 'shot' ? next.shot.shotId : '' }, signal)).resolves.toEqual({ png: new Uint8Array([1]) });
    // another chat of the host is not covered
    expect(await relayTheme(relay, 'screenshotTake', { chat: { id: 'session-2' } }, signal)).toMatchObject({ kind: 'shot', granted: false });
  });

  it('grants only the chat the page shows: a shot the daemon named for another chat of the host is allowed once', async () => {
    const made = deps();
    const { relay, consents, press, published, pageSessions } = made;
    pageSessions.set(PAGE.panelId, 'session-2');
    const shot = await shown(made);
    press(PAGE, allowChat('shot-card'));
    expect(consents.granted(AUTHORITY, CHAT.id)).toBe(false);
    expect(published).toEqual([]);
    await expect(relayTheme(relay, 'screenshot', { shotId: shot.shotId }, signal)).resolves.toEqual({ png: new Uint8Array([1]) });
    pageSessions.set(PAGE.panelId, CHAT.id);
    await shown(made, 'shot-card-2');
    press(PAGE, allowChat('shot-card-2'));
    expect(consents.granted(AUTHORITY, CHAT.id)).toBe(true);
  });

  it("ends when the page closes, its chat gets another session, the page's strip or the notice revokes it, or the host is forgotten", async () => {
    const made = deps();
    const { relay, consents, press, published } = made;
    const grant = async (promptId: string): Promise<void> => {
      await shown(made, promptId);
      press(PAGE, allowChat(promptId));
      expect(consents.granted(AUTHORITY, CHAT.id)).toBe(true);
    };
    await grant('card-1');
    consents.pageClosed(PAGE.panelId);
    expect(consents.granted(AUTHORITY, CHAT.id)).toBe(false);
    await grant('card-2');
    consents.pageSession(PAGE, CHAT.id);
    expect(consents.granted(AUTHORITY, CHAT.id)).toBe(true);
    consents.pageSession(PAGE, 'session-2');
    expect(consents.granted(AUTHORITY, CHAT.id)).toBe(false);
    expect(published.at(-1)).toEqual([PAGE.panelId, false]);
    await grant('card-3');
    // a strip that outlived its grant here still hears it ended
    consents.revokePage(SECOND_PAGE);
    expect(consents.granted(AUTHORITY, CHAT.id)).toBe(true);
    expect(published.at(-1)).toEqual([SECOND_PAGE.panelId, false]);
    published.length = 0;
    consents.revokePage(PAGE);
    expect(consents.granted(AUTHORITY, CHAT.id)).toBe(false);
    expect(published).toEqual([[PAGE.panelId, false]]);
    await grant('card-4');
    consents.revoke(OTHER, CHAT.id);
    consents.revoke(AUTHORITY, CHAT.id);
    expect(consents.granted(AUTHORITY, CHAT.id)).toBe(false);
    expect(published.at(-1)).toEqual([PAGE.panelId, false]);
    await grant('card-5');
    published.length = 0;
    consents.forgetAuthority(AUTHORITY);
    expect(consents.granted(AUTHORITY, CHAT.id)).toBe(false);
    expect(published).toEqual([[PAGE.panelId, false]]);
    // a shot taken under a grant that ended no longer leaves without a press
    await grant('card-6');
    const taken = await relayTheme(relay, 'screenshotTake', { chat: CHAT }, signal);
    consents.revoke(AUTHORITY, CHAT.id);
    await expect(relayTheme(relay, 'screenshot', { shotId: taken.kind === 'shot' ? taken.shot.shotId : '' }, signal)).rejects.toThrow(NOT_ALLOWED);
  });

  it('records no grant for a page whose chat session main does not know, and counts its Allow for this chat once', async () => {
    const made = deps();
    const { relay, consents, press, published, pageSessions, log } = made;
    pageSessions.delete(PAGE.panelId);
    const shot = await shown(made);
    press(PAGE, allowChat('shot-card'));
    expect(consents.granted(AUTHORITY, CHAT.id)).toBe(false);
    expect(consents.pageGranted(PAGE.panelId)).toBe(false);
    expect(published).toEqual([]);
    expect(log).toHaveBeenLastCalledWith(`[remote] an Allow for this chat on ${AUTHORITY} counted once: this computer knows no chat session of the page`);
    await expect(relayTheme(relay, 'screenshot', { shotId: shot.shotId }, signal)).resolves.toEqual({ png: new Uint8Array([1]) });
  });

  it('tells a reloaded page whether it granted its chat, until the grant ends', async () => {
    const made = deps();
    const { consents, press } = made;
    expect(consents.pageGranted(PAGE.panelId)).toBe(false);
    await shown(made);
    press(PAGE, allowChat('shot-card'));
    expect(consents.pageGranted(PAGE.panelId)).toBe(true);
    expect(consents.pageGranted(SECOND_PAGE.panelId)).toBe(false);
    consents.revoke(AUTHORITY, CHAT.id);
    expect(consents.pageGranted(PAGE.panelId)).toBe(false);
  });

  it("keeps a chat's grant while another page that granted it is open, with that page's strip, and ends it with the last", async () => {
    const made = deps();
    const { relay, consents, show, press, published } = made;
    await shown(made, 'card-1');
    press(PAGE, allowChat('card-1'));
    const second = await takeShot(relay);
    show(SECOND_PAGE, shotCard('card-2', second));
    press(SECOND_PAGE, allowChat('card-2'));
    expect(published).toEqual([[PAGE.panelId, true], [SECOND_PAGE.panelId, true]]);
    consents.pageClosed(PAGE.panelId);
    expect(consents.granted(AUTHORITY, CHAT.id)).toBe(true);
    expect(consents.pageGranted(SECOND_PAGE.panelId)).toBe(true);
    expect(published).toEqual([[PAGE.panelId, true], [SECOND_PAGE.panelId, true]]);
    consents.pageClosed(SECOND_PAGE.panelId);
    expect(consents.granted(AUTHORITY, CHAT.id)).toBe(false);
  });

  it('sends a draft to its card when the grant ends while its core finds the draft, and a shot to its card when the grant ends during the capture', async () => {
    const made = deps();
    const { relay, core, consents, screenshots, press } = made;
    const grant = async (promptId: string): Promise<void> => {
      await shown(made, promptId);
      press(PAGE, allowChat(promptId));
      expect(consents.granted(AUTHORITY, CHAT.id)).toBe(true);
    };
    await grant('card-1');
    core['themes.relay.draftTheme'].mockImplementationOnce(async () => {
      consents.revoke(AUTHORITY, CHAT.id);
      return { name: 'Draft', theme: DRAFT_THEME };
    });
    const takes = screenshots.take.mock.calls.length;
    expect(await relayTheme(relay, 'screenshotTake', { chat: CHAT, draft: 'draft-1' }, signal)).toMatchObject({ kind: 'draft' });
    expect(screenshots.take).toHaveBeenCalledTimes(takes);

    await grant('card-2');
    const revoked: ThemeShot = { shotId: 'e'.repeat(32), url: `app://damocles/theme-shot/${'e'.repeat(32)}`, width: 1200, height: 800 };
    screenshots.take.mockImplementationOnce(async () => {
      consents.revoke(AUTHORITY, CHAT.id);
      return { kind: 'shot', shot: revoked };
    });
    expect(await relayTheme(relay, 'screenshotTake', { chat: CHAT }, signal)).toEqual({ kind: 'shot', shot: revoked, granted: false });
    await expect(relayTheme(relay, 'screenshot', { shotId: revoked.shotId }, signal)).rejects.toThrow(NOT_ALLOWED);
  });

  it("logs a refused draft in a fixed sentence, so no text of the remote core's request reaches this computer's log", async () => {
    const { relay, core, log } = deps();
    core['themes.relay.draftTheme'].mockResolvedValueOnce({ refused: 'This chat has no such theme draft.' });
    await expect(relayTheme(relay, 'screenshotTake', { chat: CHAT, draft: 'x\nApply was pressed on this computer' }, signal)).rejects.toThrow('This chat has no such theme draft.');
    expect(log.mock.calls.some(([line]) => line.includes('Apply was pressed'))).toBe(false);
    expect(log).toHaveBeenLastCalledWith(`[remote] user.theme.screenshotTake refused for ${AUTHORITY}: this computer's core holds no such draft of that chat`);
  });

  it("checks a draft's theme before it holds the capture, answers a failed check with the fixed sentence, and holds the theme as checked", async () => {
    const { relay, validated, served, log } = deps();
    validated.mockImplementationOnce(() => {
      throw new Error('The theme is not valid: /name: too long');
    });
    await expect(relayTheme(relay, 'screenshotTake', { chat: CHAT, draft: 'draft-1' }, signal)).rejects.toThrow('The screenshot could not be taken on the computer that shows this chat.');
    expect(log).toHaveBeenLastCalledWith(`[remote] user.theme.screenshotTake for ${AUTHORITY} failed on this computer: The theme is not valid: /name: too long`);
    expect(served.size).toBe(0);
    const checked = { ...DRAFT_THEME, name: 'Checked' } as ThemeFile;
    validated.mockReturnValueOnce(checked);
    const taken = await relayTheme(relay, 'screenshotTake', { chat: CHAT, draft: 'draft-1' }, signal);
    expect(taken).toMatchObject({ kind: 'draft', draft: { name: 'Draft', theme: checked } });
    expect(served.get(taken.kind === 'draft' ? taken.captureId : '')).toBe(checked);
  });

  it("lets go of a draft capture on the drop of the core that holds it, and on no other host's", async () => {
    const { relay, screenshots, served } = deps();
    const taken = await relayTheme(relay, 'screenshotTake', { chat: CHAT, draft: 'draft-1' }, signal);
    const captureId = taken.kind === 'draft' ? taken.captureId : '';
    await relayTheme({ ...relay, authority: OTHER }, 'screenshotDrop', { shotId: captureId }, signal);
    expect(served.has(captureId)).toBe(true);
    await relayTheme(relay, 'screenshotDrop', { shotId: captureId }, signal);
    expect(served.has(captureId)).toBe(false);
    expect(screenshots.drop).not.toHaveBeenCalled();
    await expect(relayTheme(relay, 'screenshotCapture', { captureId }, signal)).rejects.toThrow(CAPTURE_GONE);
  });

  it("keeps two captures per host, tells the host's core of the one a third evicted, and answers its press that it is gone", async () => {
    const { relay, shotGone, served, show, press } = deps();
    const take = async (): Promise<string> => {
      const taken = await relayTheme(relay, 'screenshotTake', { chat: CHAT, draft: 'draft-1' }, signal);
      return taken.kind === 'draft' ? taken.captureId : '';
    };
    const first = await take();
    show(PAGE, draftCard('draft-card', first));
    press(PAGE, { type: 'resolveThemeScreenshot', promptId: 'draft-card', choice: 'allow' });
    await take();
    expect(shotGone).not.toHaveBeenCalled();
    await take();
    expect(shotGone.mock.calls).toEqual([[first]]);
    expect(served.has(first)).toBe(false);
    await expect(relayTheme(relay, 'screenshotCapture', { captureId: first }, signal)).rejects.toThrow(CAPTURE_GONE);
  });

  it("holds a capture past its card's wait by a press's freshness, tells its core when one expires, and refuses a stale press", async () => {
    const { relay, shotGone, show, press, clock } = deps();
    const take = async (): Promise<string> => {
      const taken = await relayTheme(relay, 'screenshotTake', { chat: CHAT, draft: 'draft-1' }, signal);
      return taken.kind === 'draft' ? taken.captureId : '';
    };
    const late = await take();
    show(PAGE, draftCard('late-card', late));
    clock.now += SCREENSHOT_ANSWER_MS + 1000;
    press(PAGE, { type: 'resolveThemeScreenshot', promptId: 'late-card', choice: 'allow' });
    expect(await relayTheme(relay, 'screenshotCapture', { captureId: late }, signal)).toMatchObject({ kind: 'shot', granted: false });

    const expiring = await take();
    clock.now += SCREENSHOT_ANSWER_MS + CONSENT_FRESH_MS + 1;
    await take();
    expect(shotGone.mock.calls).toEqual([[expiring]]);
    await expect(relayTheme(relay, 'screenshotCapture', { captureId: expiring }, signal)).rejects.toThrow(CAPTURE_GONE);

    const stale = await take();
    show(PAGE, draftCard('stale-card', stale));
    press(PAGE, { type: 'resolveThemeScreenshot', promptId: 'stale-card', choice: 'allow' });
    clock.now += CONSENT_FRESH_MS + 1;
    await expect(relayTheme(relay, 'screenshotCapture', { captureId: stale }, signal)).rejects.toThrow(NOT_ALLOWED);
  });

  it('ends the captures of a page that closed and of a host that was forgotten', async () => {
    const { relay, consents, served, show } = deps();
    const take = async (): Promise<string> => {
      const taken = await relayTheme(relay, 'screenshotTake', { chat: CHAT, draft: 'draft-1' }, signal);
      return taken.kind === 'draft' ? taken.captureId : '';
    };
    const onPage = await take();
    show(PAGE, draftCard('draft-card', onPage));
    const unshown = await take();
    consents.pageClosed(PAGE.panelId);
    expect(served.has(onPage)).toBe(false);
    expect(served.has(unshown)).toBe(true);
    consents.forgetAuthority(AUTHORITY);
    expect(served.size).toBe(0);
    await expect(relayTheme(relay, 'screenshotCapture', { captureId: unshown }, signal)).rejects.toThrow(CAPTURE_GONE);
  });

  it("holds a draft for its card's press, builds the card from this computer's record, and captures it once after the press", async () => {
    const { relay, core, screenshots, show, press, served } = deps();
    const taken = await relayTheme(relay, 'screenshotTake', { chat: CHAT, draft: 'draft-1' }, signal);
    expect(core['themes.relay.draftTheme']).toHaveBeenCalledWith({ authority: AUTHORITY, chat: CHAT.id, draft: 'draft-1' }, signal);
    expect(taken).toEqual({ kind: 'draft', captureId: expect.any(String), draft: { name: 'Draft', theme: DRAFT_THEME } });
    expect(screenshots.take).not.toHaveBeenCalled();
    const captureId = taken.kind === 'draft' ? taken.captureId : '';
    // the miniature's blobs are served while the capture is held
    expect(served.get(captureId)).toEqual(DRAFT_THEME);
    await expect(relayTheme(relay, 'screenshotCapture', { captureId }, signal)).rejects.toThrow(NOT_ALLOWED);
    expect(served.has(captureId)).toBe(false);

    const again = await relayTheme(relay, 'screenshotTake', { chat: CHAT, draft: 'draft-1' }, signal);
    const held = again.kind === 'draft' ? again.captureId : '';
    expect(show(OTHER_PAGE, draftCard('draft-card', held))).toBeUndefined();
    expect(show(PAGE, draftCard('draft-card', 'not-held'))).toBeUndefined();
    expect(show(PAGE, draftCard('draft-card-2', held))).toEqual({ type: 'requestThemeScreenshot', promptId: 'draft-card-2', toolUseId: 'tool-1', draft: { name: 'Draft', theme: DRAFT_THEME }, owner: OWNER });
    press(PAGE, { type: 'resolveThemeScreenshot', promptId: 'draft-card-2', choice: 'allow' });
    // the card closes before the capture is asked for; the press keeps it
    show(PAGE, { type: 'themeScreenshotClosed', promptId: 'draft-card-2' });
    expect(await relayTheme(relay, 'screenshotCapture', { captureId: held }, signal)).toMatchObject({ kind: 'shot', granted: false });
    expect(screenshots.take).toHaveBeenLastCalledWith({ chat: { id: CHAT.id }, theme: DRAFT_THEME, granted: false }, signal);
    await expect(relayTheme(relay, 'screenshotCapture', { captureId: held }, signal)).rejects.toThrow(CAPTURE_GONE);
    // the press that captured the draft also releases its shot
    await expect(relayTheme(relay, 'screenshot', { shotId: SHOT.shotId }, signal)).resolves.toEqual({ png: new Uint8Array([1]) });
  });

  it("drops a draft whose card closed unpressed, and captures a draft at once under the chat's grant", async () => {
    const made = deps();
    const { relay, core, screenshots, show, press, served } = made;
    const unpressed = await relayTheme(relay, 'screenshotTake', { chat: CHAT, draft: 'draft-1' }, signal);
    const captureId = unpressed.kind === 'draft' ? unpressed.captureId : '';
    show(PAGE, draftCard('draft-card', captureId));
    show(PAGE, { type: 'themeScreenshotClosed', promptId: 'draft-card' });
    expect(served.has(captureId)).toBe(false);

    const granting = await relayTheme(relay, 'screenshotTake', { chat: CHAT, draft: 'draft-1' }, signal);
    show(PAGE, draftCard('granting-card', granting.kind === 'draft' ? granting.captureId : ''));
    press(PAGE, allowChat('granting-card'));
    expect(made.consents.granted(AUTHORITY, CHAT.id)).toBe(true);
    expect(await relayTheme(relay, 'screenshotTake', { chat: CHAT, draft: 'draft-2' }, signal)).toMatchObject({ kind: 'shot', granted: true });
    expect(screenshots.take).toHaveBeenLastCalledWith({ chat: { id: CHAT.id }, theme: DRAFT_THEME, granted: true }, signal);

    core['themes.relay.draftTheme'].mockResolvedValueOnce({ refused: "That draft is not this chat's." });
    await expect(relayTheme(relay, 'screenshotTake', { chat: CHAT, draft: 'someone-else' }, signal)).rejects.toThrow("That draft is not this chat's.");
  });

  it("answers this window's refusal as it is, and holds no shot for it", async () => {
    const { relay, screenshots, consents } = deps();
    screenshots.take.mockResolvedValueOnce({ kind: 'refused', reason: 'windowHidden' });
    expect(await relayTheme(relay, 'screenshotTake', { chat: CHAT }, signal)).toEqual({ kind: 'refused', reason: 'windowHidden' });
    expect(consents.forgetAuthority(AUTHORITY)).toEqual([]);
  });
});

// A card's Apply and Show in window count only as main saw them pressed on its own page, on a card it filled from its own record.
describe("a remote chat's theme card on this computer", () => {
  const staged = async () => {
    const made = deps();
    await relayTheme(made.relay, 'stage', stageRequest, signal);
    return made;
  };
  const apply = { type: 'resolveThemeChange', promptId: 'card-1', choice: 'apply' };
  const committedWith = (core: ReturnType<typeof deps>['core']): unknown => core['themes.relay.commit'].mock.lastCall;

  it('tells its core the Apply was pressed only when its own page posted it for the card of that stage, and once', async () => {
    const { relay, core, show, press } = await staged();
    await relayTheme(relay, 'commit', { stageId: 'stage-1' }, signal);
    expect(committedWith(core)).toEqual([{ authority: AUTHORITY, stageId: 'stage-1', pressed: false }, signal]);
    show(PAGE, changeCard('card-1'));
    press(PAGE, apply);
    await relayTheme(relay, 'commit', { stageId: 'stage-1' }, signal);
    expect(committedWith(core)).toEqual([{ authority: AUTHORITY, stageId: 'stage-1', pressed: true }, signal]);
  });

  it('keeps the stage after a refused ask with no press, and spends one press on one of two asks in flight', async () => {
    const { relay, core, show, press } = await staged();
    await relayTheme(relay, 'commit', { stageId: 'stage-1' }, signal);
    expect(show(PAGE, changeCard('card-1'))).toMatchObject({ themeName: 'Amber' });
    press(PAGE, apply);
    core['themes.relay.commit'].mockResolvedValue({ outcome: 'outdated' });
    await Promise.all([relayTheme(relay, 'commit', { stageId: 'stage-1' }, signal), relayTheme(relay, 'commit', { stageId: 'stage-1' }, signal)]);
    expect(core['themes.relay.commit'].mock.calls.map(([params]) => (params as { pressed: boolean }).pressed)).toEqual([false, true, false]);
  });

  it('never reads pressed from the request', async () => {
    const { relay, core } = await staged();
    await relayTheme(relay, 'commit', { stageId: 'stage-1', pressed: true } as never, signal);
    expect(committedWith(core)).toEqual([{ authority: AUTHORITY, stageId: 'stage-1', pressed: false }, signal]);
  });

  it("delivers the card as this computer's core staged it: only the prompt's own fields come from the remote core", async () => {
    const { show } = await staged();
    const remote = changeCard('card-1', { themeName: 'Harmless', theme: { id: 'x' }, changes: [{ kind: 'wallpapersOff' }], droppedCss: [{ part: 'x' }], otherDevice: { computer: 'elsewhere' }, showNote: 'takenOver', extra: 1 });
    expect(show(PAGE, remote)).toEqual({ type: 'requestThemeChange', promptId: 'card-1', toolUseId: 'tool-1', ...CARD, state: 'waiting', showInWindow: false, showNote: 'takenOver', owner: OWNER });
  });

  it('delivers each note the page has a sentence for, and leaves out any other', async () => {
    const { show } = await staged();
    expect(show(PAGE, changeCard('card-1', { showNote: 'forcedColors' }))).toMatchObject({ showNote: 'forcedColors' });
    expect(show(PAGE, changeCard('card-1', { showNote: 'safeStart' }))).toMatchObject({ showNote: 'safeStart' });
    expect(show(PAGE, changeCard('card-1', { showNote: 'constructor' }))).not.toHaveProperty('showNote');
    expect(show(PAGE, changeCard('card-1', { showNote: { toString: 1 } }))).not.toHaveProperty('showNote');
  });

  it('counts no press from a second page of the host that was shown other content under the same prompt id', async () => {
    const { relay, core, show, press } = await staged();
    show(PAGE, changeCard('card-1'));
    const { stageId: _stageId, ...unbound } = changeCard('card-1', { themeName: 'Harmless' });
    expect(show(SECOND_PAGE, unbound)).toMatchObject({ themeName: 'Harmless', otherDevice: {} });
    press(SECOND_PAGE, apply);
    await relayTheme(relay, 'commit', { stageId: 'stage-1' }, signal);
    expect(committedWith(core)).toMatchObject([{ pressed: false }, signal]);
  });

  it('delivers no card posted again under a prompt id for another stage, or without one, until that card closed on the page', async () => {
    const { relay, core, show, press } = await staged();
    core['themes.relay.stage'].mockResolvedValueOnce({ ...STAGED, stageId: 'stage-2', card: { ...CARD, themeName: 'Second' } });
    await relayTheme(relay, 'stage', stageRequest, signal);
    expect(show(PAGE, changeCard('card-1'))).toMatchObject({ themeName: 'Amber' });
    expect(show(PAGE, changeCard('card-1', { stageId: 'stage-2' }))).toBeUndefined();
    const { stageId: _stageId, ...unbound } = changeCard('card-1');
    expect(show(PAGE, unbound)).toBeUndefined();
    expect(show(PAGE, installCard('card-1'))).toBeUndefined();
    // the same card again (a reload) is delivered again
    expect(show(PAGE, changeCard('card-1', { state: 'outdated' }))).toMatchObject({ themeName: 'Amber', state: 'outdated' });
    press(PAGE, apply);
    await relayTheme(relay, 'commit', { stageId: 'stage-2' }, signal);
    expect(committedWith(core)).toMatchObject([{ stageId: 'stage-2', pressed: false }, signal]);
    expect(show(PAGE, { type: 'themeChangeClosed', promptId: 'card-1' })).toEqual({ type: 'themeChangeClosed', promptId: 'card-1' });
    expect(show(PAGE, changeCard('card-1', { stageId: 'stage-2' }))).toMatchObject({ themeName: 'Second' });
  });

  it('gives a card that names no stage this computer holds Discard only, and counts no press on it: another device\'s card', async () => {
    const { relay, core, show, press } = await staged();
    const { stageId: _stageId, ...elsewhere } = changeCard('card-1', { otherDevice: { computer: 'LAPTOP-2' }, canShowInWindow: false });
    expect(show(PAGE, elsewhere)).toEqual(elsewhere);
    expect(show(SECOND_PAGE, changeCard('card-2', { stageId: 'a-stage-of-another-device' }))).toMatchObject({ otherDevice: {} });
    press(PAGE, apply);
    press(SECOND_PAGE, { ...apply, promptId: 'card-2' });
    await relayTheme(relay, 'commit', { stageId: 'stage-1' }, signal);
    expect(committedWith(core)).toMatchObject([{ pressed: false }, signal]);
    await relayTheme(relay, 'commit', { stageId: 'a-stage-of-another-device' }, signal);
    expect(committedWith(core)).toMatchObject([{ pressed: false }, signal]);
  });

  it('withdraws an Apply the remote core did not act on when the user then discards or asks for changes', async () => {
    for (const choice of ['discard', 'change']) {
      const { relay, core, show, press } = await staged();
      show(PAGE, changeCard('card-1'));
      press(PAGE, apply);
      press(PAGE, { type: 'resolveThemeChange', promptId: 'card-1', choice, note: 'warmer' });
      await relayTheme(relay, 'commit', { stageId: 'stage-1' }, signal);
      expect(committedWith(core), choice).toMatchObject([{ pressed: false }, signal]);
    }
  });

  it('counts no press main does not forward (the host is away), none older than a minute, and none after the stage was discarded', async () => {
    const { relay, core, show, press, clock } = await staged();
    show(PAGE, changeCard('card-1'));
    press(PAGE, apply, false);
    await relayTheme(relay, 'commit', { stageId: 'stage-1' }, signal);
    expect(committedWith(core)).toMatchObject([{ pressed: false }, signal]);
    press(PAGE, apply);
    clock.now += CONSENT_FRESH_MS + 1;
    await relayTheme(relay, 'commit', { stageId: 'stage-1' }, signal);
    expect(committedWith(core)).toMatchObject([{ pressed: false }, signal]);
    press(PAGE, apply);
    await relayTheme(relay, 'discard', { stageId: 'stage-1' }, signal);
    await relayTheme(relay, 'commit', { stageId: 'stage-1' }, signal);
    expect(committedWith(core)).toMatchObject([{ pressed: false }, signal]);
  });

  it('forgets everything of a host on Forget host, and of a page when it closes', async () => {
    const { relay, core, screenshots, consents, show, press } = await staged();
    show(PAGE, changeCard('card-1'));
    consents.pageClosed(PAGE.panelId);
    press(PAGE, apply);
    await relayTheme(relay, 'commit', { stageId: 'stage-1' }, signal);
    expect(committedWith(core)).toMatchObject([{ pressed: false }, signal]);

    await takeShot(relay);
    show(PAGE, changeCard('card-2'));
    press(PAGE, { ...apply, promptId: 'card-2' });
    expect(consents.forgetAuthority(AUTHORITY)).toEqual([SHOT.shotId]);
    await relayTheme(relay, 'commit', { stageId: 'stage-1' }, signal);
    expect(committedWith(core)).toMatchObject([{ pressed: false }, signal]);
    await expect(relayTheme(relay, 'screenshot', { shotId: SHOT.shotId }, signal)).rejects.toThrow(/nobody allowed it/);
    expect(screenshots.read).not.toHaveBeenCalled();
  });

  describe('Show in window', () => {
    const on = { stageId: 'stage-1', promptId: 'card-1', on: true };
    const toggle = { type: 'setThemeShowInWindow', promptId: 'card-1', on: true };

    it('paints the window only after the toggle was pressed on the page whose card shows that stage, once per press', async () => {
      const { relay, core, show, press } = await staged();
      await expect(relayTheme(relay, 'preview', on, signal)).resolves.toEqual({ showing: false });
      expect(core['themes.relay.preview']).not.toHaveBeenCalled();
      show(PAGE, changeCard('card-1'));
      press(SECOND_PAGE, toggle);
      await expect(relayTheme(relay, 'preview', on, signal)).resolves.toEqual({ showing: false });
      press(PAGE, toggle);
      await expect(relayTheme(relay, 'preview', { ...on, promptId: 'another-card' }, signal)).resolves.toEqual({ showing: false });
      expect(core['themes.relay.preview']).not.toHaveBeenCalled();
      await expect(relayTheme(relay, 'preview', on, signal)).resolves.toEqual({ showing: true });
      expect(core['themes.relay.preview']).toHaveBeenCalledWith({ authority: AUTHORITY, stageId: 'stage-1', promptId: 'card-1', on: true }, signal);
      await expect(relayTheme(relay, 'preview', on, signal)).resolves.toEqual({ showing: false });
      expect(core['themes.relay.preview']).toHaveBeenCalledTimes(1);
    });

    it("answers why this computer's window refused the proposal, and holds no preview for it", async () => {
      const { relay, core, show, press } = await staged();
      show(PAGE, changeCard('card-1'));
      press(PAGE, toggle);
      core['themes.relay.preview'].mockResolvedValueOnce({ showing: false, refused: 'forcedColors' });
      await expect(relayTheme(relay, 'preview', on, signal)).resolves.toEqual({ showing: false, refused: 'forcedColors' });
      expect(relay.previews.shows('card-1')).toBe(false);
    });

    it('withdraws the toggle when the user turns it off again before the remote core asked', async () => {
      const { relay, core, show, press } = await staged();
      show(PAGE, changeCard('card-1'));
      press(PAGE, toggle);
      press(PAGE, { ...toggle, on: false });
      await expect(relayTheme(relay, 'preview', on, signal)).resolves.toEqual({ showing: false });
      expect(core['themes.relay.preview']).not.toHaveBeenCalled();
    });
  });
});

// A remote chat's ThemeSet install: this computer downloads, stages and commits it, and tells the remote core of each update.
describe("a remote chat's theme install on this computer", () => {
  const prepared = async (installs = installsWith().installs) => {
    const made = deps(true, undefined, installs);
    await relayTheme(made.relay, 'installPrepare', { url: 'https://themes.example/a.damocles-theme' }, signal);
    return made;
  };
  const NOT_PRESSED = { refused: { message: 'Nobody pressed Install for this theme on the computer that shows this chat, so nothing was installed.' } };

  it('refuses to allow flashing while the tools are off here', async () => {
    const { relay, core } = deps(false);
    expect(await allowRelayedInstallFlash(relay, { type: 'allowThemeInstallFlash', promptId: 'p', installId: INSTALL_ID, sha256: 'a'.repeat(64) }, signal)).toBe(false);
    expect(core['themes.relay.allowFlash']).not.toHaveBeenCalled();
  });

  it("forwards with the authority, names this computer on the preview, and sends the install's updates and progress to that core until it ends", async () => {
    const { installs, sendUpdated, sendProgress } = installsWith();
    const { relay, core, show, press } = deps(true, undefined, installs);
    const answer = await relayTheme(relay, 'installPrepare', { url: 'https://themes.example/a.damocles-theme' }, signal);
    expect(answer).toEqual({ preview: PREVIEW, computer: 'DESKTOP-7Q2' });
    expect(core['themes.relay.installPrepare']).toHaveBeenCalledWith({ authority: AUTHORITY, url: 'https://themes.example/a.damocles-theme' }, signal);
    expect(installs.updated({ ...PREVIEW, installId: 'a-local-install' })).toBeUndefined();
    await installs.updated(PREVIEW);
    await installs.progress({ installId: INSTALL_ID, sha256: 'a'.repeat(64), fraction: 0.5 });
    expect(sendUpdated).toHaveBeenCalledWith(AUTHORITY, PREVIEW);
    expect(sendProgress).toHaveBeenCalledWith(AUTHORITY, { installId: INSTALL_ID, sha256: 'a'.repeat(64), fraction: 0.5 });
    show(PAGE, installCard('install-card'));
    press(PAGE, { type: 'resolveThemeInstall', promptId: 'install-card', choice: 'install', useArrangement: true });
    await relayTheme(relay, 'installCommit', { installId: INSTALL_ID, useArrangement: true, chat: { id: 's', title: 'Make it warm' } }, signal);
    expect(core['themes.relay.installCommit']).toHaveBeenCalledWith({ authority: AUTHORITY, installId: INSTALL_ID, useArrangement: true, chat: { id: 's', title: 'Make it warm' } }, signal);
    expect(installs.updated(PREVIEW)).toBeUndefined();
  });

  it('tells the core that asked when its staged install expired, then forgets the install; one of this computer is not its to tell', async () => {
    const { installs, sendExpired, sendUpdated } = installsWith();
    const { relay } = deps(true, undefined, installs);
    await relayTheme(relay, 'installPrepare', { url: 'https://themes.example/a.damocles-theme' }, signal);
    expect(installs.expired('a-local-install')).toBeUndefined();
    expect(installs.expired(INSTALL_ID)).toBe(AUTHORITY);
    expect(sendExpired).toHaveBeenCalledWith(AUTHORITY, INSTALL_ID);
    expect(installs.updated(PREVIEW)).toBeUndefined();
    expect(sendUpdated).not.toHaveBeenCalled();
  });

  // the remote ThemeSet waits on the expiry alone, so one its host could not take is sent when the host is back
  it('sends an expiry its host missed once the host connects again, once, and never after Forget host', async () => {
    let features: readonly string[] = [];
    const { installs, sendExpired, log } = installsWith(() => features);
    installs.add(INSTALL_ID, AUTHORITY);
    installs.add('second-install', AUTHORITY);
    installs.add('other-install', OTHER);
    expect(installs.expired(INSTALL_ID)).toBe(AUTHORITY);
    expect(installs.expired('other-install')).toBe(OTHER);
    expect(sendExpired).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(`[remote] a theme install's expiry was not sent to ${AUTHORITY}: its server does not list ${THEMES_FEATURE} or is not connected; it is sent when the host connects`);
    features = [THEMES_FEATURE];
    sendExpired.mockRejectedValueOnce(new Error(`${AUTHORITY} is not connected`));
    await installs.connected(AUTHORITY);
    expect(sendExpired.mock.calls).toEqual([[AUTHORITY, INSTALL_ID]]);
    await installs.connected(AUTHORITY);
    expect(sendExpired.mock.calls).toEqual([[AUTHORITY, INSTALL_ID], [AUTHORITY, INSTALL_ID]]);
    await installs.connected(AUTHORITY);
    expect(sendExpired).toHaveBeenCalledTimes(2);
    installs.forgetAuthority(OTHER);
    await installs.connected(OTHER);
    expect(sendExpired).toHaveBeenCalledTimes(2);
  });

  it('installs nothing with no Install pressed on its own page, after Cancel, or on a second ask', async () => {
    const { relay, core, show, press } = await prepared();
    const commit = { installId: INSTALL_ID, onClash: 'replace' as const, useArrangement: true, chat: { id: 's' } };
    expect(await relayTheme(relay, 'installCommit', commit, signal)).toEqual(NOT_PRESSED);
    show(PAGE, installCard('install-card'));
    press(PAGE, { type: 'resolveThemeInstall', promptId: 'install-card', choice: 'install', useArrangement: false });
    press(PAGE, { type: 'resolveThemeInstall', promptId: 'install-card', choice: 'cancel' });
    expect(await relayTheme(relay, 'installCommit', commit, signal)).toEqual(NOT_PRESSED);
    press(SECOND_PAGE, { type: 'resolveThemeInstall', promptId: 'install-card', choice: 'install', useArrangement: false });
    press(PAGE, { type: 'resolveThemeInstall', promptId: 'install-card', choice: 'install', onClash: 'everything', useArrangement: false });
    press(PAGE, { type: 'resolveThemeInstall', promptId: 'install-card', choice: 'install', useArrangement: 'yes' });
    expect(await relayTheme(relay, 'installCommit', commit, signal)).toEqual(NOT_PRESSED);
    expect(core['themes.relay.installCommit']).not.toHaveBeenCalled();
    core['themes.relay.installCommit'].mockResolvedValueOnce({ refused: { message: 'The name is taken.' }, preview: { ...PREVIEW, totalBytes: 11 } });
    press(PAGE, { type: 'resolveThemeInstall', promptId: 'install-card', choice: 'install', useArrangement: false });
    expect(await relayTheme(relay, 'installCommit', commit, signal)).toMatchObject({ refused: { message: 'The name is taken.' } });
    expect(await relayTheme(relay, 'installCommit', commit, signal)).toEqual(NOT_PRESSED);
  });

  it("installs with the options of the press, never the request's", async () => {
    const { relay, core, show, press } = await prepared();
    show(PAGE, installCard('install-card'));
    press(PAGE, { type: 'resolveThemeInstall', promptId: 'install-card', choice: 'install', onClash: 'keepBoth', useArrangement: false });
    const answer = await relayTheme(relay, 'installCommit', { installId: INSTALL_ID, onClash: 'replace', useArrangement: true, chat: { id: 's', title: 'T' }, pressed: true } as never, signal);
    expect(answer).toMatchObject({ installed: { name: 'Aurora' } });
    expect(core['themes.relay.installCommit'].mock.calls).toEqual([[{ authority: AUTHORITY, installId: INSTALL_ID, onClash: 'keepBoth', useArrangement: false, chat: { id: 's', title: 'T' } }, signal]]);
  });

  it("shows the install card with this computer's latest preview, on the card and on each update, and Cancel only on one it does not hold", async () => {
    const { relay, consents, show } = await prepared();
    const forged = { ...PREVIEW, about: { name: 'Harmless' } };
    expect(show(PAGE, { ...installCard('install-card', forged), otherDevice: { computer: 'x' } } as never)).toEqual(installCard('install-card'));
    const latest = { ...PREVIEW, totalBytes: 12 } as ThemeInstallPreview;
    consents.installUpdated(latest);
    expect(show(PAGE, { type: 'themeInstallUpdated', promptId: 'install-card', preview: forged })).toEqual({ type: 'themeInstallUpdated', promptId: 'install-card', preview: latest });
    const elsewhere = { ...PREVIEW, installId: 'an-install-of-another-device' };
    expect(show(SECOND_PAGE, installCard('install-card-2', elsewhere))).toEqual({ ...installCard('install-card-2', elsewhere), otherDevice: {} });
    expect(show(PAGE, installCard('install-card', elsewhere))).toBeUndefined();
    await relayTheme(relay, 'installCancel', { installId: INSTALL_ID }, signal);
    expect(show(SECOND_PAGE, installCard('install-card-3'))).toMatchObject({ otherDevice: {} });
  });

  it("asks this computer's core to cancel first, and ends only the caller's own install", async () => {
    const { installs, sendUpdated } = installsWith();
    const { relay, core } = await prepared(installs);
    const other = { ...relay, authority: OTHER };
    await relayTheme(other, 'installCancel', { installId: INSTALL_ID }, signal);
    expect(core['themes.relay.installCancel']).toHaveBeenCalledWith({ authority: OTHER, installId: INSTALL_ID }, signal);
    await installs.updated(PREVIEW);
    expect(sendUpdated).toHaveBeenCalledWith(AUTHORITY, PREVIEW);
    core['themes.relay.installCancel'].mockRejectedValueOnce(new Error('The engine stopped'));
    await expect(relayTheme(relay, 'installCancel', { installId: INSTALL_ID }, signal)).rejects.toThrow('The install could not be cancelled on the computer that shows this chat.');
    expect(installs.updated(PREVIEW)).toBeDefined();
    await relayTheme(relay, 'installCancel', { installId: INSTALL_ID }, signal);
    expect(installs.updated(PREVIEW)).toBeUndefined();
  });

  it("sends the chat page's Allow flashing to this computer's core with the page's own authority, and drops a malformed one", async () => {
    const { relay, core, log } = deps();
    const press = { type: 'allowThemeInstallFlash', promptId: 'p', installId: INSTALL_ID, sha256: 'a'.repeat(64) };
    expect(await allowRelayedInstallFlash(relay, press, signal)).toBe(true);
    expect(core['themes.relay.allowFlash']).toHaveBeenCalledWith({ authority: AUTHORITY, installId: INSTALL_ID, sha256: 'a'.repeat(64) }, signal);
    core['themes.relay.allowFlash'].mockResolvedValueOnce({ allowed: false });
    expect(await allowRelayedInstallFlash(relay, press, signal)).toBe(false);
    expect(log).toHaveBeenLastCalledWith(`[remote] Allow flashing of ${'a'.repeat(64)} from a chat on ${AUTHORITY}: refused, no install of that host lists it as flagged`);
    for (const malformed of [{ ...press, sha256: 'A'.repeat(64) }, { ...press, installId: '../x' }, { ...press, installId: 7 }, null]) {
      expect(await allowRelayedInstallFlash(relay, malformed, signal)).toBe(false);
    }
    expect(core['themes.relay.allowFlash']).toHaveBeenCalledTimes(2);
  });

  it('passes a refusal through, and sends no update to a daemon without the feature', async () => {
    const { installs, sendUpdated, sendProgress, log } = installsWith(() => []);
    const { relay, core } = deps(true, undefined, installs);
    core['themes.relay.installPrepare'].mockResolvedValueOnce({ refused: { message: 'No.' } as never });
    expect(await relayTheme(relay, 'installPrepare', { url: 'https://themes.example/a.damocles-theme' }, signal)).toEqual({ refused: { message: 'No.' } });
    await relayTheme(relay, 'installPrepare', { url: 'https://themes.example/a.damocles-theme' }, signal);
    await installs.updated(PREVIEW);
    await installs.progress({ installId: INSTALL_ID, sha256: 'a'.repeat(64), fraction: 0.5 });
    expect(sendUpdated).not.toHaveBeenCalled();
    expect(sendProgress).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("logs a host that cannot take an install's progress once, not every tick, and again once a send reached it and then failed", async () => {
    let features: readonly string[] = [];
    const { installs, sendProgress, log } = installsWith(() => features);
    installs.add(INSTALL_ID, AUTHORITY);
    const tick = { installId: INSTALL_ID, sha256: 'a'.repeat(64), fraction: 0.5 };
    for (let i = 0; i < 20; i++) await installs.progress(tick);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith(`[remote] a theme install's progress was not sent to ${AUTHORITY}: its server does not list ${THEMES_FEATURE} or is not connected`);
    features = [THEMES_FEATURE];
    await installs.progress(tick);
    expect(sendProgress).toHaveBeenCalledTimes(1);
    sendProgress.mockRejectedValue(new Error(`${AUTHORITY} is not connected`));
    for (let i = 0; i < 20; i++) await installs.progress(tick);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith(`[remote] a theme install's progress did not reach ${AUTHORITY}: ${AUTHORITY} is not connected`);
  });
});

// The window shows one transient preview; when it ends a remote card's, user.theme.showEnded tells the core that raised it.
describe('the end of a remote card\'s Show in window', () => {
  function previewsWith(features: () => readonly string[] | undefined = () => [THEMES_FEATURE]) {
    const send = vi.fn(async (_authority: string, _ended: ThemeShowEnded) => undefined);
    const log = vi.fn<(line: string) => void>();
    const previews = new RelayedPreviews({ features, send, log });
    const made = deps(true, previews);
    // each start is one the user pressed on the page showing the stage's card
    const start = async (relay = made.relay): Promise<{ readonly showing: boolean }> => {
      if (made.show(PAGE, changeCard('card-1')) === undefined) throw new Error('the card was not delivered');
      made.press(PAGE, { type: 'setThemeShowInWindow', promptId: 'card-1', on: true });
      return relayTheme(relay, 'preview', on, signal);
    };
    return { ...made, previews, send, previewLog: log, start };
  }
  const on = { stageId: 'stage-1', promptId: 'card-1', on: true };
  const stagedPreviews = async (features?: () => readonly string[] | undefined) => {
    const made = previewsWith(features);
    await relayTheme(made.relay, 'stage', stageRequest, signal);
    return made;
  };

  it('reaches the core of the card the window showed, once, and leaves a card of this computer to its own core', async () => {
    const { previews, send, start } = await stagedPreviews();
    await start();
    expect(previews.ended('local-card', 'takenOver')).toBeUndefined();
    await previews.ended('card-1', 'takenOver');
    expect(send).toHaveBeenCalledWith(AUTHORITY, { stageId: 'stage-1', promptId: 'card-1', reason: 'takenOver' });
    expect(previews.ended('card-1', 'stopped')).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('tells nothing for a card that turned it off itself, a preview the window did not show, or one that failed', async () => {
    const { previews, send, relay, core, start } = await stagedPreviews();
    await start();
    await relayTheme(relay, 'preview', { ...on, on: false }, signal);
    expect(previews.ended('card-1', 'stopped')).toBeUndefined();
    core['themes.relay.preview'].mockResolvedValueOnce({ showing: false });
    await start();
    expect(previews.ended('card-1', 'stopped')).toBeUndefined();
    core['themes.relay.preview'].mockRejectedValueOnce(new Error('The engine stopped'));
    await expect(start()).rejects.toThrow('Show in window could not be changed on the computer that shows this chat.');
    expect(previews.ended('card-1', 'stopped')).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('records the card before the window shows it, so an end that overtakes the answer reaches its core, and answers that it does not show', async () => {
    const { previews, send, core, start } = await stagedPreviews();
    core['themes.relay.preview'].mockImplementationOnce(async () => {
      await previews.ended('card-1', 'takenOver');
      return { showing: true };
    });
    await expect(start()).resolves.toEqual({ showing: false });
    expect(send).toHaveBeenCalledWith(AUTHORITY, { stageId: 'stage-1', promptId: 'card-1', reason: 'takenOver' });
  });

  it("leaves another host's preview in place: its off, its failed start and its prompt id change nothing of this host's", async () => {
    const { previews, send, relay, core, start } = await stagedPreviews();
    await start();
    const other = { ...relay, authority: OTHER };
    await relayTheme(other, 'preview', { ...on, on: false }, signal);
    expect(previews.shows('card-1')).toBe(true);
    // the other host's own stage and card, under the prompt id this host's preview holds
    core['themes.relay.stage'].mockResolvedValueOnce({ ...STAGED, stageId: 'stage-9' });
    await relayTheme(other, 'stage', stageRequest, signal);
    relay.consents.card(OTHER_PAGE, 'requestThemeChange', JSON.stringify(changeCard('card-1', { stageId: 'stage-9' })));
    relay.consents.pressed(OTHER_PAGE, { type: 'setThemeShowInWindow', promptId: 'card-1', on: true }, true);
    core['themes.relay.preview'].mockClear();
    await expect(relayTheme(other, 'preview', { stageId: 'stage-9', promptId: 'card-1', on: true }, signal)).resolves.toEqual({ showing: false });
    expect(core['themes.relay.preview']).not.toHaveBeenCalled();
    await previews.ended('card-1', 'stopped');
    expect(send).toHaveBeenCalledWith(AUTHORITY, { stageId: 'stage-1', promptId: 'card-1', reason: 'stopped' });
  });

  it('sends nothing to a daemon without the feature or a host not connected, and logs a send that failed', async () => {
    let features: readonly string[] | undefined = [];
    const { previews, send, previewLog, start } = await stagedPreviews(() => features);
    await start();
    await previews.ended('card-1', 'takenOver');
    features = undefined;
    await start();
    await previews.ended('card-1', 'stopped');
    expect(send).not.toHaveBeenCalled();
    expect(previewLog).toHaveBeenCalledTimes(2);

    features = [THEMES_FEATURE];
    send.mockRejectedValueOnce(new Error('ssh+prod-1 is not connected'));
    await start();
    await expect(previews.ended('card-1', 'stopped')).resolves.toBeUndefined();
    expect(previewLog).toHaveBeenLastCalledWith(`[remote] the end of a theme card's Show in window did not reach ${AUTHORITY}: ssh+prod-1 is not connected`);
  });
});
