import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../local-services/confine';
import { RETRY_AFTER_MS, RETRY_WAIT_MS, RootSpellings } from '../root-spellings';

const LOCAL = { authority: 'local', os: 'win32' } as const;
const SHARE = '\\\\server\\share\\proj';

const root = (fsPath: string, key: string = fsPath.toLowerCase()): Project => ({ key, fsPath, name: 'proj' });

// realpaths: each folder's realpath, an Error it throws, or undefined for a missing folder; changed by the test as a remap would
function spellingsOver(realpaths: Map<string, string | Error | undefined>) {
  const asked: string[] = [];
  const lines: string[] = [];
  const spellings = new RootSpellings({
    os: 'win32',
    realpath: async (folder) => {
      asked.push(folder);
      const real = realpaths.get(folder);
      if (real instanceof Error) throw real;
      return real;
    },
    log: (line) => lines.push(line),
  });
  return { spellings, asked, lines };
}

describe('RootSpellings', () => {
  const project = root('Z:\\proj');
  const worktree = root('Z:\\proj\\.damocles\\worktrees\\wt', 'z:\\proj\u0000wt');

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers the deepest root across every spelling, with the spelling that matched; the open path wins a tie', async () => {
    const { spellings } = spellingsOver(new Map([[project.fsPath, SHARE], [worktree.fsPath, `${SHARE}\\.damocles\\worktrees\\wt`]]));
    await spellings.retain([project, worktree]);
    expect(spellings.holding(LOCAL, [project, worktree], `${SHARE}\\.damocles\\worktrees\\wt\\src\\a.ts`)).toEqual({ root: worktree, relativePath: 'src/a.ts', spelling: `${SHARE}\\.damocles\\worktrees\\wt`, computed: true });
    expect(spellings.holding(LOCAL, [worktree, project], '\\\\SERVER\\share\\proj\\src\\a.ts')).toEqual({ root: project, relativePath: 'src/a.ts', spelling: SHARE, computed: true });
    expect(spellings.holding(LOCAL, [project, worktree], 'Z:\\proj\\src\\a.ts')).toEqual({ root: project, relativePath: 'src/a.ts', spelling: 'Z:\\proj', computed: false });
    // the same folder opened as a project at its share path holds it as written
    const onShare = root(SHARE);
    expect(spellings.holding(LOCAL, [project, onShare], `${SHARE}\\src\\a.ts`)).toMatchObject({ root: onShare, computed: false });
    for (const outside of [`${SHARE}`, '\\\\server\\share\\other\\a.ts', `${SHARE}\\src\\..\\a.ts`, 'Z:\\projx\\a.ts']) {
      expect(spellings.holding(LOCAL, [project, worktree], outside), outside).toBeUndefined();
    }
  });

  it('matches the \\\\wsl$ and \\\\wsl.localhost alias of a spelling both ways, ignoring case, before any realpath', () => {
    const { spellings, asked } = spellingsOver(new Map());
    const localhost = root('\\\\wsl.localhost\\Ubuntu\\home\\me');
    const dollar = root('\\\\wsl$\\Ubuntu\\srv');
    expect(spellings.holding(LOCAL, [localhost, dollar], '\\\\wsl$\\Ubuntu\\home\\me\\a.ts')).toEqual({ root: localhost, relativePath: 'a.ts', spelling: '\\\\wsl$\\Ubuntu\\home\\me', computed: false });
    expect(spellings.holding(LOCAL, [localhost, dollar], '\\\\WSL$\\ubuntu\\HOME\\me\\a.ts')).toMatchObject({ root: localhost, relativePath: 'a.ts' });
    expect(spellings.holding(LOCAL, [localhost, dollar], '\\\\Wsl.LocalHost\\Ubuntu\\srv\\x\\b.ts')).toMatchObject({ root: dollar, relativePath: 'x/b.ts', computed: false });
    expect(spellings.holding(LOCAL, [localhost], '\\\\wsl$\\Debian\\home\\me\\a.ts')).toBeUndefined();
    // a POSIX computer has no WSL alias
    expect(spellings.holding({ authority: 'local', os: 'linux' }, [root('/srv/wsl.localhost/x')], '/srv/wsl$/x/a')).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('matches the WSL alias of a realpath as a computed spelling', async () => {
    const subst = root('S:\\');
    const { spellings } = spellingsOver(new Map([['S:\\', '\\\\wsl.localhost\\Ubuntu\\home']]));
    await spellings.retain([subst]);
    expect(spellings.holding(LOCAL, [subst], '\\\\wsl$\\Ubuntu\\home\\a.ts')).toEqual({ root: subst, relativePath: 'a.ts', spelling: '\\\\wsl$\\Ubuntu\\home', computed: true });
  });

  it('contains the root itself in any spelling, and what it holds, and nothing else', async () => {
    const { spellings } = spellingsOver(new Map([[project.fsPath, SHARE]]));
    await spellings.retain([project]);
    for (const inside of ['Z:\\proj', 'z:\\PROJ\\', SHARE, `${SHARE}\\`, `${SHARE}\\src\\a.ts`, '//server/share/proj/src']) {
      expect(spellings.contains(LOCAL, [project], inside), inside).toBe(true);
    }
    for (const outside of ['\\\\server\\share', '\\\\server\\share\\other', `${SHARE}\\..\\other`, `${SHARE}\\.`, 'Z:\\', 'proj', '\\proj']) {
      expect(spellings.contains(LOCAL, [project], outside), outside).toBe(false);
    }
    const wsl = root('\\\\wsl.localhost\\Ubuntu\\home\\me');
    expect(spellings.contains(LOCAL, [wsl], '\\\\wsl$\\Ubuntu\\home\\me')).toBe(true);
  });

  it('drops the spellings of a root that left, takes each realpath once, and retries one that failed at most every RETRY_AFTER_MS', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const other = root('Y:\\other');
    const offline = root('X:\\offline');
    const realpaths = new Map<string, string | Error | undefined>([[project.fsPath, SHARE], [other.fsPath, '\\\\server\\share\\other'], [offline.fsPath, new Error('The network name cannot be found')]]);
    const { spellings, asked, lines } = spellingsOver(realpaths);
    await spellings.retain([project, other, offline]);
    expect(asked).toEqual([project.fsPath, other.fsPath, offline.fsPath]);
    expect(lines).toEqual(['[spellings] could not resolve X:\\offline: The network name cannot be found; its open path and alias stand until the next try']);
    expect(spellings.holding(LOCAL, [project, other, offline], '\\\\server\\share\\other\\a.ts')).toMatchObject({ root: other });
    // the root that failed keeps its open path
    expect(spellings.holding(LOCAL, [offline], 'X:\\offline\\a.ts')).toMatchObject({ root: offline, computed: false });

    realpaths.set(offline.fsPath, '\\\\nas\\offline');
    // a change soon after the failure takes no realpath again, as each would hold a pool thread while the share is offline
    await spellings.retain([project, offline]);
    expect(asked).toHaveLength(3);
    expect(spellings.holding(LOCAL, [project, other, offline], '\\\\server\\share\\other\\a.ts')).toBeUndefined();
    vi.advanceTimersByTime(RETRY_AFTER_MS);
    await spellings.retain([project, offline]);
    expect(asked.slice(3)).toEqual([offline.fsPath]);
    expect(spellings.holding(LOCAL, [offline], '\\\\nas\\offline\\a.ts')).toMatchObject({ root: offline, computed: true });
    // a root that comes back is resolved again; a missing folder is tried again too
    realpaths.set(other.fsPath, undefined);
    await spellings.retain([project, offline, other]);
    expect(asked.slice(4)).toEqual([other.fsPath]);
    await spellings.retain([project, offline, other]);
    expect(asked).toHaveLength(5);
    vi.advanceTimersByTime(RETRY_AFTER_MS);
    await spellings.retain([project, offline, other]);
    expect(asked.slice(5)).toEqual([other.fsPath]);
    expect(lines.at(-1)).toBe('[spellings] Y:\\other is missing; its open path and alias stand until the next try');
  });

  it('confirms a computed match only while the confined path lies under its spelling, and otherwise resolves the root again', async () => {
    const realpaths = new Map<string, string | Error | undefined>([[project.fsPath, SHARE]]);
    const { spellings, asked, lines } = spellingsOver(realpaths);
    await spellings.retain([project]);
    const match = spellings.holding(LOCAL, [project], `${SHARE}\\src\\a.ts`)!;
    expect(spellings.confirms(match, `${SHARE}\\src\\a.ts`)).toBe(true);
    // the drive was remapped: confinement now resolves under another share
    realpaths.set(project.fsPath, '\\\\other\\share\\proj');
    expect(spellings.confirms(match, '\\\\other\\share\\proj\\src\\a.ts')).toBe(false);
    expect(lines).toEqual([`[spellings] \\\\other\\share\\proj\\src\\a.ts lies outside ${SHARE}, the realpath Z:\\proj had; resolving it again`]);
    expect(asked).toEqual([project.fsPath, project.fsPath]);
    expect(spellings.holding(LOCAL, [project], `${SHARE}\\src\\a.ts`)).toBeUndefined();
    await vi.waitFor(() => expect(spellings.holding(LOCAL, [project], '\\\\other\\share\\proj\\src\\a.ts')).toMatchObject({ root: project, computed: true }));
    // a match through the open path needs no check
    expect(spellings.confirms(spellings.holding(LOCAL, [project], 'Z:\\proj\\src\\a.ts')!, 'C:\\anywhere\\a.ts')).toBe(true);
  });

  describe('match', () => {
    it('take a failed realpath again for a share path only a computed spelling could match, at most every RETRY_AFTER_MS', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const realpaths = new Map<string, string | Error | undefined>([[project.fsPath, new Error('The network name cannot be found')]]);
      const { spellings, asked } = spellingsOver(realpaths);
      await spellings.retain([project]);
      expect(await spellings.match(LOCAL, [project], `${SHARE}\\src\\a.ts`)).toBeUndefined();
      // the attempt at retain is too recent
      expect(asked).toEqual([project.fsPath]);
      realpaths.set(project.fsPath, SHARE);
      vi.advanceTimersByTime(RETRY_AFTER_MS);
      expect(await spellings.match(LOCAL, [project], `${SHARE}\\src\\a.ts`)).toMatchObject({ root: project, relativePath: 'src/a.ts', computed: true });
      expect(asked).toEqual([project.fsPath, project.fsPath]);
      expect(spellings.contains(LOCAL, [project], SHARE)).toBe(true);
      expect(asked).toHaveLength(2);
    });

    it('take no realpath for a drive path or a remote authority', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const failed = root('X:\\offline');
      const { spellings, asked } = spellingsOver(new Map<string, string | Error | undefined>([[project.fsPath, SHARE], [failed.fsPath, new Error('offline')]]));
      await spellings.retain([project, failed]);
      vi.advanceTimersByTime(RETRY_AFTER_MS);
      expect(await spellings.match(LOCAL, [project, failed], 'Y:\\elsewhere\\a.ts')).toBeUndefined();
      expect(await spellings.match({ authority: 'ssh+h1', os: 'win32' }, [project, failed], '\\\\nas\\x\\a.ts')).toBeUndefined();
      expect(await spellings.match({ authority: 'local', os: 'linux' }, [project, failed], '\\\\nas\\x\\a.ts')).toBeUndefined();
      expect(asked).toEqual([project.fsPath, failed.fsPath]);
    });

    it('take a resolved root\'s realpath again for a share path no spelling holds, at most every RETRY_AFTER_MS, so a remapped drive is found', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const realpaths = new Map<string, string | Error | undefined>([[project.fsPath, SHARE]]);
      const { spellings, asked } = spellingsOver(realpaths);
      await spellings.retain([project]);
      realpaths.set(project.fsPath, '\\\\other\\share\\proj');
      expect(await spellings.match(LOCAL, [project], '\\\\other\\share\\proj\\a.ts')).toBeUndefined();
      expect(asked).toEqual([project.fsPath]);
      vi.advanceTimersByTime(RETRY_AFTER_MS);
      expect(await spellings.match(LOCAL, [project], '\\\\other\\share\\proj\\a.ts')).toMatchObject({ root: project, relativePath: 'a.ts', computed: true });
      expect(asked).toEqual([project.fsPath, project.fsPath]);
      // a share path a fresh computed spelling holds takes none
      expect(await spellings.match(LOCAL, [project], '\\\\other\\share\\proj\\b.ts')).toMatchObject({ root: project });
      expect(asked).toHaveLength(2);
    });

    it('confirm a computed spelling again once it is RETRY_AFTER_MS old, so a path on the server a remapped drive left is refused', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const realpaths = new Map<string, string | Error | undefined>([[project.fsPath, SHARE]]);
      const { spellings, asked } = spellingsOver(realpaths);
      await spellings.retain([project]);
      realpaths.set(project.fsPath, '\\\\other\\share\\proj');
      // within RETRY_AFTER_MS the spelling stands as last resolved
      expect(await spellings.match(LOCAL, [project], `${SHARE}\\a.ts`)).toMatchObject({ root: project, computed: true });
      expect(asked).toEqual([project.fsPath]);
      vi.advanceTimersByTime(RETRY_AFTER_MS);
      expect(await spellings.match(LOCAL, [project], `${SHARE}\\a.ts`)).toBeUndefined();
      expect(asked).toEqual([project.fsPath, project.fsPath]);
      expect(spellings.holding(LOCAL, [project], '\\\\other\\share\\proj\\a.ts')).toMatchObject({ root: project, computed: true });
    });

    it('keep a root\'s computed spelling while its realpath is taken again, and take none again for a root whose realpath is its open path', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const local = root('C:\\work');
      let hang = false;
      const asked: string[] = [];
      const spellings = new RootSpellings({
        os: 'win32',
        realpath: (folder) => {
          asked.push(folder);
          if (hang) return new Promise<string>(() => undefined);
          return Promise.resolve(folder === project.fsPath ? SHARE : folder);
        },
        log: () => undefined,
      });
      await spellings.retain([project, local]);
      hang = true;
      vi.advanceTimersByTime(RETRY_AFTER_MS);
      const looked = spellings.match(LOCAL, [project, local], `${SHARE}\\a.ts`);
      expect(spellings.holding(LOCAL, [project, local], `${SHARE}\\b.ts`)).toMatchObject({ root: project, computed: true });
      await vi.advanceTimersByTimeAsync(RETRY_WAIT_MS);
      expect(await looked).toMatchObject({ root: project, computed: true });
      expect(asked).toEqual([project.fsPath, local.fsPath, project.fsPath]);
    });

    it('answer with a root that resolved while another root\'s realpath hangs past RETRY_WAIT_MS', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const hung = root('X:\\offline');
      let online = false;
      const spellings = new RootSpellings({
        os: 'win32',
        realpath: (folder) => {
          if (!online) return Promise.reject(new Error(`${folder} offline`));
          return folder === project.fsPath ? Promise.resolve(SHARE) : new Promise<string>(() => undefined);
        },
        log: () => undefined,
      });
      await spellings.retain([project, hung]);
      online = true;
      vi.advanceTimersByTime(RETRY_AFTER_MS);
      const looked = spellings.match(LOCAL, [project, hung], `${SHARE}\\a.ts`);
      await vi.advanceTimersByTimeAsync(RETRY_WAIT_MS);
      expect(await looked).toMatchObject({ root: project, computed: true });
    });

    it('start one realpath for lookups made together, clear their wait timer once it settles, and refuse while it fails again', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const { spellings, asked } = spellingsOver(new Map<string, string | Error | undefined>([[project.fsPath, new Error('offline')]]));
      await spellings.retain([project]);
      vi.advanceTimersByTime(RETRY_AFTER_MS);
      const both = await Promise.all([spellings.match(LOCAL, [project], `${SHARE}\\a.ts`), spellings.match(LOCAL, [project], `${SHARE}\\b.ts`)]);
      expect(both).toEqual([undefined, undefined]);
      expect(asked).toEqual([project.fsPath, project.fsPath]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('answer with the spellings known once RETRY_WAIT_MS passes, and the realpath that settles later counts for the next lookup', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      let answer: ((real: string) => void) | undefined;
      let calls = 0;
      const spellings = new RootSpellings({
        os: 'win32',
        realpath: (folder) => {
          calls++;
          return calls === 1 ? Promise.reject(new Error(`${folder} offline`)) : new Promise<string>((resolve) => (answer = resolve));
        },
        log: () => undefined,
      });
      await spellings.retain([project]);
      vi.advanceTimersByTime(RETRY_AFTER_MS);
      const looked = spellings.match(LOCAL, [project], `${SHARE}\\a.ts`);
      await vi.advanceTimersByTimeAsync(RETRY_WAIT_MS);
      expect(await looked).toBeUndefined();
      // an attempt hung for RETRY_WAIT_MS holds no later lookup, and is never started again
      expect(await spellings.match(LOCAL, [project], `${SHARE}\\a.ts`)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      answer!(SHARE);
      await vi.waitFor(async () => expect(await spellings.match(LOCAL, [project], `${SHARE}\\a.ts`)).toMatchObject({ root: project, computed: true }));
      expect(calls).toBe(2);
    });

    it('join the realpath still under way for a root that left and came back', async () => {
      const answers: Array<(real: string) => void> = [];
      const spellings = new RootSpellings({ os: 'win32', realpath: () => new Promise<string>((resolve) => answers.push(resolve)), log: () => undefined });
      void spellings.retain([project]);
      void spellings.retain([]);
      const back = spellings.retain([project]);
      expect(answers).toHaveLength(1);
      answers[0]!(SHARE);
      await back;
      expect(spellings.holding(LOCAL, [project], `${SHARE}\\a.ts`)).toMatchObject({ root: project, computed: true });
    });

    it('wait at most RETRY_WAIT_MS for a new root\'s first realpath before answering a path no root holds, on any OS', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const answers: Array<(real: string) => void> = [];
      const spellings = new RootSpellings({ os: 'linux', realpath: () => new Promise<string>((resolve) => answers.push(resolve)), log: () => undefined });
      const linux = { authority: 'local', os: 'linux' } as const;
      const tmp = root('/tmp/proj');
      void spellings.retain([tmp]);
      // the open path needs no realpath
      expect(await spellings.match(linux, [tmp], '/tmp/proj/a.ts')).toMatchObject({ root: tmp, computed: false });
      const looked = spellings.match(linux, [tmp], '/private/tmp/proj/a.ts');
      answers[0]!('/private/tmp/proj');
      expect(await looked).toMatchObject({ root: tmp, relativePath: 'a.ts', computed: true });
      const hung = root('/mnt/nas/proj');
      void spellings.retain([tmp, hung]);
      expect(answers).toHaveLength(2);
      const late = spellings.match(linux, [tmp, hung], '/elsewhere/a.ts');
      await vi.advanceTimersByTimeAsync(RETRY_WAIT_MS);
      expect(await late).toBeUndefined();
      // a first realpath hung for RETRY_WAIT_MS holds no later lookup
      expect(await spellings.match(linux, [tmp, hung], '/elsewhere/a.ts')).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      expect(answers).toHaveLength(2);
    });

    it('never start a second realpath for a root while one is under way, however long it hangs', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const answers: Array<(real: string) => void> = [];
      const spellings = new RootSpellings({ os: 'win32', realpath: () => new Promise<string>((resolve) => answers.push(resolve)), log: () => undefined });
      void spellings.retain([project]);
      vi.advanceTimersByTime(RETRY_AFTER_MS * 3);
      expect(await spellings.match(LOCAL, [project], `${SHARE}\\a.ts`)).toBeUndefined();
      void spellings.retain([project]);
      expect(answers).toHaveLength(1);
      answers[0]!(SHARE);
      await vi.waitFor(async () => expect(await spellings.match(LOCAL, [project], `${SHARE}\\a.ts`)).toMatchObject({ root: project, computed: true }));
    });
  });

  it('gives a remote root no spelling but its open path, and takes no realpath for it', async () => {
    const remote = root('\\\\wsl.localhost\\Ubuntu\\x', 'ssh+h1|\\\\wsl.localhost\\ubuntu\\x');
    const { spellings, asked } = spellingsOver(new Map([[remote.fsPath, '\\\\server\\share\\x']]));
    await spellings.retain([remote]);
    expect(asked).toEqual([]);
    const host = { authority: 'ssh+h1', os: 'win32' } as const;
    expect(spellings.holding(host, [remote], '\\\\wsl.localhost\\Ubuntu\\x\\a.ts')).toEqual({ root: remote, relativePath: 'a.ts', spelling: remote.fsPath, computed: false });
    expect(spellings.holding(host, [remote], '\\\\wsl$\\Ubuntu\\x\\a.ts')).toBeUndefined();
    expect(spellings.holding(host, [remote], '\\\\server\\share\\x\\a.ts')).toBeUndefined();
  });
});
