import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionOptions } from '../../session-types';
import { PiSession } from '../pi-session';
import { PiRuntime } from '../pi-runtime';
import { initPiLoader } from '../pi-loader';
import { installFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import { inGreek } from '../../../__mocks__/greek-locale';
import { englishText } from '../../../shared/localized-text';
import { assertFolderPresent, folderPresenceProbe, folderPresent, FolderMissingError, FolderUnavailableError } from '../folder-presence';
import type { WorktreeHostServices } from '../../worktrees/host';
import type { ChatWorktreeRecord } from '../../worktrees/registry';

vi.mock('../folder-presence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../folder-presence')>();
  return { ...actual, assertFolderPresent: vi.fn(actual.assertFolderPresent) };
});

const TARGET = '019a0000-0000-7000-8000-000000000001';

/** A chat whose folder is gone starts no session there, and says so in its own words on every path that would. */
describe('a chat in a missing folder', () => {
  const made: string[] = [];
  const sessions: PiSession[] = [];

  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };

  const chat = (platform: SessionOptions['platform'], cwd: string): PiSession => {
    const session = new PiSession({
      cwd,
      settingsFolder: undefined,
      projectScope: true,
      platform,
      permissionHandler: { getPermissionMode: () => 'default', turnPermissionMode: () => 'default', setPermissionRequiredNotifier: () => {}, setPlanContentResolver: () => {}, setPendingPromptsListener: () => {}, setPromptOwnerResolver: () => {}, pendingPrompts: () => [] } as unknown as SessionOptions['permissionHandler'],
      onMessage: () => {},
      resolveThinking: () => ({ thinkingDisabled: false, effort: null }),
    });
    sessions.push(session);
    return session;
  };

  const start = (session: PiSession): Promise<void> => (session as unknown as { ensureStarted(): Promise<void> }).ensureStarted();
  const boundSessionId = (session: PiSession): string | undefined => (session as unknown as { runtime: { session: { sessionId: string } } | null }).runtime?.session.sessionId;
  const errorsOf = (platform: FakePlatform): string[] => platform.notifications.calls.filter((call) => call.level === 'error').map((call) => call.message);
  const folderText = (folder: string): string => `The folder ${folder} was not found. It may have been moved, renamed or deleted.`;

  beforeAll(async () => {
    if (!(await initPiLoader())) throw new Error('pi failed to load');
  }, 60_000);

  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.dispose();
    await PiRuntime.disposeInstance();
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    vi.mocked(assertFolderPresent).mockClear();
  });

  it('refuses the start before any folder runtime is built, and tells a resume the folder error alone', async () => {
    const platform = installFakePlatform();
    PiRuntime.get(tempDir('damocles-presence-agent-'));
    const missing = path.join(tempDir('damocles-presence-parent-'), 'moved-away');
    const session = chat(platform, missing);
    session.setResumeSession(TARGET);

    const failure = await start(session).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(FolderMissingError);
    expect(failure).toMatchObject({ folder: missing });
    expect(PiRuntime.get().folders()).toHaveLength(0);
    expect(errorsOf(platform)).toEqual([folderText(missing)]);
    const notice = platform.notifications.calls[0]!.text;
    expect(inGreek(notice)).toBe(`Ο φάκελος ${missing} δεν βρέθηκε. Μπορεί να έχει μετακινηθεί, μετονομαστεί ή διαγραφεί.`);
  }, 60_000);

  it('maps a pi rejection to the folder error once the folder is gone, never pi\'s own text', async () => {
    const platform = installFakePlatform();
    PiRuntime.get(tempDir('damocles-presence-agent-'));
    const missing = path.join(tempDir('damocles-presence-parent-'), 'renamed');
    // the folder went between the check and pi's own
    vi.mocked(assertFolderPresent).mockResolvedValueOnce(undefined);
    const session = chat(platform, missing);

    const failure = await start(session).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(FolderMissingError);
    expect(englishText((failure as FolderMissingError).text)).toBe(folderText(missing));
  }, 60_000);

  it('refuses a resume switch and a reset once the folder of a started chat is gone, keeping the bound session', async () => {
    const platform = installFakePlatform();
    PiRuntime.get(tempDir('damocles-presence-agent-'));
    const workspace = tempDir('damocles-presence-ws-');
    const session = chat(platform, workspace);
    await start(session);
    const bound = boundSessionId(session);
    expect(bound).toBeDefined();
    fs.rmSync(workspace, { recursive: true, force: true });

    session.setResumeSession(TARGET);
    const outcome = await session.openResumeTarget(TARGET);
    expect(outcome).toMatchObject({ kind: 'failed', reason: { message: 'The folder {0} was not found. It may have been moved, renamed or deleted.', args: [workspace] } });
    expect(outcome.kind === 'failed' ? outcome.absent?.folder : undefined).toBe(workspace);
    expect(boundSessionId(session)).toBe(bound);

    session.reset();
    await expect(session.whenReplaced()).rejects.toBeInstanceOf(FolderMissingError);
    expect(boundSessionId(session)).toBe(bound);
    expect(errorsOf(platform)).toEqual([folderText(workspace), folderText(workspace)]);
  }, 60_000);

  it('offers Locate… for a gone project folder, never for a chat worktree\'s working folder or a folder whose volume does not answer', async () => {
    const base = installFakePlatform();
    PiRuntime.get(tempDir('damocles-presence-agent-'));
    const parent = tempDir('damocles-presence-parent-');
    const project = path.join(parent, 'moved-away');
    const worktreeRoot = path.join(parent, 'worktrees', 'acme-1');
    const working = path.join(worktreeRoot, 'acme');
    const record: ChatWorktreeRecord = { id: 'w1', kind: 'chat', worktreeRoot, workingFolder: working, projectPath: project, repositoryRoot: project, branch: 'damocles/w1', index: 1, baseCommit: 'a'.repeat(40), createdAt: 1 };
    const worktrees = {
      registry: { get: () => undefined, liveChatRecordAt: () => undefined, records: () => [record], liveChatRecords: () => [], onDidChange: () => ({ dispose: () => undefined }) },
      git: () => undefined,
      projectRepository: () => undefined,
      onDidChangeRefs: () => ({ dispose: () => undefined }),
      onDidChangeProjectRepository: () => ({ dispose: () => undefined }),
    } as unknown as WorktreeHostServices;
    const platform = { ...base, worktrees, capabilities: { ...base.capabilities, worktrees: true }, window: { ...base.window, locateProjectFolder: vi.fn() } };
    const unavailable = process.platform === 'win32' ? 'Q:\\work\\app' : '/media/me/USB/app';
    const volume = await folderPresenceProbe.volumeOf(unavailable);
    const real = fs.promises.stat;
    const stat = vi.spyOn(fs.promises, 'stat').mockImplementation(((target: fs.PathLike) => (target === volume ? Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })) : real(target))) as typeof fs.promises.stat);
    try {
      for (const folder of [project, working, unavailable]) {
        const session = chat(platform, folder);
        session.setResumeSession(TARGET);
        await start(session).catch(() => undefined);
      }
    } finally {
      stat.mockRestore();
    }
    expect(base.notifications.calls.map((call) => [call.message, call.actions])).toEqual([
      [folderText(project), ['Locate…']],
      [folderText(working), []],
      [`The folder ${unavailable} can't be reached: its drive, share or WSL distro does not answer.`, []],
    ]);
  }, 60_000);
});

describe('folder presence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('states a folder once for checks that run at the same time', async () => {
    const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-presence-once-')));
    const stat = vi.spyOn(fs.promises, 'stat');
    try {
      expect(await Promise.all(Array.from({ length: 5 }, () => folderPresent(folder)))).toEqual(Array(5).fill(true));
      expect(stat.mock.calls.filter(([target]) => target === folder)).toHaveLength(1);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('refuses a folder whose volume does not answer as unavailable, in the user\'s language', async () => {
    const folder = process.platform === 'win32' ? 'Q:\\work\\app' : '/media/me/USB/app';
    const volume = await folderPresenceProbe.volumeOf(folder);
    const real = fs.promises.stat;
    vi.spyOn(fs.promises, 'stat').mockImplementation(((target: fs.PathLike) => (target === volume ? Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })) : real(target))) as typeof fs.promises.stat);
    const failure = await assertFolderPresent(folder).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(FolderUnavailableError);
    expect(englishText((failure as FolderUnavailableError).text)).toBe(`The folder ${folder} can't be reached: its drive, share or WSL distro does not answer.`);
    expect(inGreek((failure as FolderUnavailableError).text)).not.toContain('can\'t be reached');
  });
});
