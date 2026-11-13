import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ WebContentsView: vi.fn(), session: {}, nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() }, protocol: {} }));

import { createForgeAccountAsker, forgeChooseAccountAnswer, parseForgeChooseAccountRequest, parseOverlayAnswer, parseOverlayRequest } from '../overlay';
import type { OverlayAnswer, OverlayRequest } from '../../preload/overlay-channels';
import type { ForgeChooseAccountDialog } from '../../preload/forge-channels';
import type { RepoAccountOption } from '../../../shared/forge/bindings';

const AVATAR = 'a'.repeat(64);
const ALEXIOS: RepoAccountOption = { id: 'gitlab.com|1', login: 'alexios-s', name: 'Alexios S.', avatarKey: AVATAR, needsSignIn: false, canPush: true, owner: true };
const WORK: RepoAccountOption = { id: 'gitlab.com|2', login: 'work-alexios', needsSignIn: false, checking: true };
const DIALOG: ForgeChooseAccountDialog = {
  requestId: 'ask-1',
  projectKey: 'C:/work/damocles',
  project: 'damocles',
  serverId: 'gitlab.com',
  server: 'gitlab.com',
  kind: 'gitlab',
  repoPath: 'alexios-s/damocles',
  operation: 'push',
  accounts: [ALEXIOS, WORK],
  checking: true,
  preselectId: ALEXIOS.id,
  where: { hostName: 'prod-1', color: 'warning' },
};

describe('the ask-once request', () => {
  it('keeps a request within bounds as it is', () => {
    expect(parseForgeChooseAccountRequest(DIALOG)).toEqual({ kind: 'forgeChooseAccount', dialog: DIALOG });
  });

  it('refuses a request past the bounds, so no git operation runs', () => {
    expect(parseForgeChooseAccountRequest({ ...DIALOG, preselectId: 'nobody' })).toBeUndefined();
    expect(parseForgeChooseAccountRequest({ ...DIALOG, accounts: [ALEXIOS, ALEXIOS] })).toBeUndefined();
    expect(parseForgeChooseAccountRequest({ ...DIALOG, accounts: [{ ...ALEXIOS, avatarKey: 'https://evil.test/a.png' }] })).toBeUndefined();
    expect(parseForgeChooseAccountRequest({ ...DIALOG, operation: 'rebase' as never })).toBeUndefined();
    expect(parseForgeChooseAccountRequest({ ...DIALOG, project: '' })).toBeUndefined();
    const { preselectId: _preselect, ...unselected } = DIALOG;
    expect(parseForgeChooseAccountRequest({ ...unselected, accounts: Array.from({ length: 101 }, (_, at) => ({ ...WORK, id: `id${at}` })) })).toBeUndefined();
  });

  it('opens and answers a clone, which asks before its project exists and so has no projectKey', async () => {
    const { projectKey: _projectKey, where: _where, ...clone } = { ...DIALOG, operation: 'clone' as const };
    expect(parseForgeChooseAccountRequest(clone)).toEqual({ kind: 'forgeChooseAccount', dialog: clone });
    expect(parseForgeChooseAccountRequest({ ...clone, projectKey: '' })).toBeUndefined();
    const overlay = { request: vi.fn(async (): Promise<OverlayAnswer> => ({ kind: 'forgeChooseAccount', accountId: WORK.id })), updateForgeChooseAccount: vi.fn() };
    const ask = createForgeAccountAsker({ overlay: () => overlay, focused: () => undefined, reveal: vi.fn(), log: vi.fn() });
    await expect(ask.chooseForgeAccount(clone, new AbortController().signal)).resolves.toEqual({ kind: 'account', accountId: WORK.id });
  });

  it('is never a request a renderer may open', () => {
    expect(parseOverlayRequest({ kind: 'forgeChooseAccount', dialog: DIALOG })).toBeUndefined();
  });

  it('takes an offered account, null for Git\'s own credentials, or signIn, and refuses any other account', () => {
    const request = parseForgeChooseAccountRequest(DIALOG)!;
    expect(parseOverlayAnswer({ kind: 'forgeChooseAccount', accountId: WORK.id }, request)).toEqual({ kind: 'forgeChooseAccount', accountId: WORK.id });
    expect(parseOverlayAnswer({ kind: 'forgeChooseAccount', accountId: null }, request)).toEqual({ kind: 'forgeChooseAccount', accountId: null });
    expect(parseOverlayAnswer({ kind: 'forgeChooseAccount', signIn: true }, request)).toEqual({ kind: 'forgeChooseAccount', signIn: true });
    expect(parseOverlayAnswer({ kind: 'forgeChooseAccount', accountId: 'gitlab.com|99' }, request)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'forgeChooseAccount', accountId: WORK.id, extra: 1 }, request)).toBeUndefined();
  });

  it('maps the overlay answer to forge-host\'s, dismissed cancelling', () => {
    expect(forgeChooseAccountAnswer({ kind: 'forgeChooseAccount', accountId: WORK.id })).toEqual({ kind: 'account', accountId: WORK.id });
    expect(forgeChooseAccountAnswer({ kind: 'forgeChooseAccount', accountId: null })).toEqual({ kind: 'account', accountId: null });
    expect(forgeChooseAccountAnswer({ kind: 'forgeChooseAccount', signIn: true })).toEqual({ kind: 'signInAnother' });
    expect(forgeChooseAccountAnswer({ kind: 'dismissed' })).toEqual({ kind: 'cancelled' });
  });
});

describe('createForgeAccountAsker', () => {
  function asker(answer: Promise<OverlayAnswer> | undefined) {
    const overlay = answer === undefined ? undefined : { request: vi.fn((_request: OverlayRequest) => answer), updateForgeChooseAccount: vi.fn() };
    const deps = { overlay: () => overlay, focused: () => undefined, reveal: vi.fn(), log: vi.fn() };
    return { ask: createForgeAccountAsker(deps), overlay, deps };
  }

  it('reveals the window, asks, and answers the choice', async () => {
    const { ask, overlay, deps } = asker(Promise.resolve({ kind: 'forgeChooseAccount', accountId: WORK.id }));
    const signal = new AbortController().signal;
    await expect(ask.chooseForgeAccount(DIALOG, signal)).resolves.toEqual({ kind: 'account', accountId: WORK.id });
    expect(deps.reveal).toHaveBeenCalled();
    expect(overlay!.request).toHaveBeenCalledWith({ kind: 'forgeChooseAccount', dialog: DIALOG }, undefined, undefined, undefined, signal);
  });

  it('cancels when it cannot ask: no overlay, a request past the bounds, or a failed page', async () => {
    const signal = new AbortController().signal;
    await expect(asker(undefined).ask.chooseForgeAccount(DIALOG, signal)).resolves.toEqual({ kind: 'cancelled' });
    const bounded = asker(Promise.resolve({ kind: 'dismissed' }));
    await expect(bounded.ask.chooseForgeAccount({ ...DIALOG, project: '' }, signal)).resolves.toEqual({ kind: 'cancelled' });
    expect(bounded.overlay!.request).not.toHaveBeenCalled();
    const failed = asker(Promise.reject(new Error('The overlay is not available')));
    await expect(failed.ask.chooseForgeAccount(DIALOG, signal)).resolves.toEqual({ kind: 'cancelled' });
    expect(failed.deps.log).toHaveBeenCalled();
  });

  it('forwards later rows to the overlay', () => {
    const { ask, overlay } = asker(Promise.resolve({ kind: 'dismissed' }));
    const rows = { requestId: 'ask-1', accounts: [ALEXIOS], checking: false };
    ask.pushForgeChooseAccountRows(rows);
    expect(overlay!.updateForgeChooseAccount).toHaveBeenCalledWith(rows);
  });
});

describe('menu item avatars', () => {
  const menu = (avatar: unknown): unknown => ({ kind: 'menu', label: 'Accounts for damocles', anchor: { x: 0, y: 0, width: 10, height: 10 }, items: [{ kind: 'item', id: 'pick:0:0', label: 'alexios-s', avatar, checked: true, radio: true }] });

  it('keeps a login and a sha-256 key, and refuses anything else', () => {
    const parsed = parseOverlayRequest(menu({ login: 'alexios-s', key: AVATAR }));
    expect(parsed?.kind === 'menu' && parsed.items[0]).toMatchObject({ avatar: { login: 'alexios-s', key: AVATAR } });
    expect(parseOverlayRequest(menu({ login: 'alexios-s' }))).toBeDefined();
    expect(parseOverlayRequest(menu({ login: 'alexios-s', key: 'https://evil.test/a.png' }))).toBeUndefined();
    expect(parseOverlayRequest(menu({ login: '' }))).toBeUndefined();
    expect(parseOverlayRequest(menu({ login: 'alexios-s', src: 'x' }))).toBeUndefined();
  });
});
