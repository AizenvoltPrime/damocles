import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ WebContentsView: vi.fn(), session: {}, nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() }, protocol: {} }));

import { parseOverlayAnswer, parseOverlayRequest } from '../overlay';
import { dialogText, parseForkRequest, parseOwners, parseProtectedBranchRequest, parsePublishRequest } from '../forge/publish-dialogs';
import type { ForkDialog, PublishDialog } from '../../../shared/forge/publish';
import type { ProtectedBranchDialog } from '../../../shared/forge/protected-push';

// The Publish, fork and protected-branch dialogs within the overlay's bounds: server and git text as text, unique Owner
// values, and the answers each may give.

const PUBLISH: PublishDialog = {
  requestId: 'publish-1',
  project: 'damocles',
  branch: 'main',
  accounts: [
    { accountId: 'gitlab.com|2001', serverName: 'gitlab.com', login: 'alexios-s', kind: 'gitlab', personal: { value: 'gitlab.com|alexios-s|personal', kind: 'personal', path: 'alexios-s', internal: true } },
    { accountId: 'github.com|1001', serverName: 'github.com', login: 'astefanopoulos\u202E', kind: 'github', personal: { value: 'github.com|astefanopoulos|personal', kind: 'personal', path: 'astefanopoulos', internal: false } },
  ],
  defaultOwner: 'gitlab.com|alexios-s|personal',
  defaultName: 'damocles',
};

const PROTECTED: ProtectedBranchDialog = { requestId: 'protected-1', branch: 'main', serverName: 'gitlab.com', kind: 'gitlab', login: 'alexios-s', remote: 'origin', localBranch: 'main', unpushedCount: 2, suggestedName: 'alexios-s/main' };

const FORK: ForkDialog = { requestId: 'fork-1', serverName: 'gitlab.indigital.gr', kind: 'gitlab', path: 'grp/damocles', login: 'astefanopoulos', branch: 'fix/token-refresh', remote: 'origin', upstreamName: 'upstream-2', upstreamExists: true };

describe('the Publish and fork requests', () => {
  it('keep a request within bounds, escaping hidden characters in server text', () => {
    const parsed = parsePublishRequest(PUBLISH);
    expect(parsed?.dialog.accounts[0]).toEqual(PUBLISH.accounts[0]);
    expect(parsed?.dialog.accounts[1]?.login).not.toContain('\u202E');
    expect(parseOwners([{ value: 'gitlab.com|alexios-s|grp', kind: 'group', path: 'grp\u202E', internal: true }])?.[0]?.path).not.toContain('\u202E');
    expect(parseProtectedBranchRequest(PROTECTED)).toEqual({ kind: 'forgeProtectedBranch', dialog: PROTECTED });
    expect(parseForkRequest(FORK)).toEqual({ kind: 'forgeFork', dialog: FORK });
    expect(dialogText('x'.repeat(5000))).toHaveLength(2000);
  });

  it('cut a dialog line between whole characters, never inside an escape or a surrogate pair, and keep its line breaks', () => {
    // 1997 characters, then an escape of 8 that would end past the bound
    expect(dialogText(`${'x'.repeat(1997)}\u202Eyz`)).toBe('x'.repeat(1997));
    expect(dialogText(`${'x'.repeat(1999)}😀`)).toBe('x'.repeat(1999));
    expect(dialogText('first\r\nsecond')).toBe('first\nsecond');
  });

  it('refuse duplicate owner values, a default that is not listed, an account without namespaces and an unknown kind', () => {
    const first = PUBLISH.accounts[0]!;
    expect(parsePublishRequest({ ...PUBLISH, accounts: [first, first] })).toBeUndefined();
    expect(parsePublishRequest({ ...PUBLISH, defaultOwner: 'gitlab.com|alexios-s|elsewhere' })).toBeUndefined();
    expect(parsePublishRequest({ ...PUBLISH, accounts: [{ ...first, personal: { ...first.personal, kind: 'group' } }] })).toBeUndefined();
    expect(parseOwners([{ value: 'gitlab.com|alexios-s|personal', kind: 'personal', path: 'alexios-s', internal: true }])).toBeUndefined();
    expect(parseOwners(Array.from({ length: 1001 }, (_, index) => ({ value: `v${index}`, kind: 'group' as const, path: `g${index}`, internal: true })))).toBeUndefined();
    expect(parseProtectedBranchRequest({ ...PROTECTED, unpushedCount: -1 })).toBeUndefined();
    expect(parseProtectedBranchRequest({ ...PROTECTED, branch: '' })).toBeUndefined();
    expect(parsePublishRequest({ ...PUBLISH, accounts: [] })).toBeUndefined();
    expect(parseForkRequest({ ...FORK, kind: 'bitbucket' as 'gitlab' })).toBeUndefined();
    expect(parseForkRequest({ ...FORK, branch: '' })).toBeUndefined();
  });

  it('are main\'s own: the shell cannot open them', () => {
    expect(parseOverlayRequest({ kind: 'forgePublish', dialog: PUBLISH })).toBeUndefined();
    expect(parseOverlayRequest({ kind: 'forgeFork', dialog: FORK })).toBeUndefined();
    expect(parseOverlayRequest({ kind: 'forgeProtectedBranch', dialog: PROTECTED })).toBeUndefined();
  });

  it('answer dismissed, and the fork dialog its Open Merge Request alone', () => {
    const publish = parsePublishRequest(PUBLISH)!;
    const fork = parseForkRequest(FORK)!;
    expect(parseOverlayAnswer({ kind: 'dismissed' }, publish)).toEqual({ kind: 'dismissed' });
    expect(parseOverlayAnswer({ kind: 'forgePublish', owner: 'x' }, publish)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'forgeFork', openMergeRequest: true }, fork)).toEqual({ kind: 'forgeFork', openMergeRequest: true });
    expect(parseOverlayAnswer({ kind: 'forgeFork', openMergeRequest: true, url: 'https://evil.test' }, fork)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'forgeFork', openMergeRequest: false }, fork)).toBeUndefined();
    const protectedBranch = parseProtectedBranchRequest(PROTECTED)!;
    expect(parseOverlayAnswer({ kind: 'forgeProtectedBranch', openMergeRequest: true }, protectedBranch)).toEqual({ kind: 'forgeProtectedBranch', openMergeRequest: true });
    expect(parseOverlayAnswer({ kind: 'forgeProtectedBranch', openMergeRequest: true, name: 'x' }, protectedBranch)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'dismissed' }, protectedBranch)).toEqual({ kind: 'dismissed' });
  });
});
