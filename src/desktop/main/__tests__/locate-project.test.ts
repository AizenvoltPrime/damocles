import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Coded, PreflightAnswer, PreflightRequest } from '../../../core/project-relocation/types';
import { InterruptedLocates, locateOnce, locateProject, locateShown, nearestExistingAncestor, preparedMove, relocationText, type LocateConfirm, type LocatePrepared, type LocateProjectDeps } from '../locate-project';

const t = (message: string, ...args: string[]): string => message.replace(/\{(\d+)\}/g, (_, index: string) => args[Number(index)] ?? '');

const OLD = path.resolve('/work/acme');
const NEW = path.resolve('/moved/acme');

interface World {
  presence: 'present' | 'missing' | 'unavailable';
  picked: string | undefined;
  answer: PreflightAnswer;
  // preflight's answer once trust was asked, with the identity read; `answer` when undefined
  afterTrust: PreflightAnswer | undefined;
  confirmed: boolean;
  editorAnswers: ReadonlyMap<string, string> | undefined;
  killConfirmed: boolean;
  // granted: the trust question Locate asked made the grant, so its answer has an undo
  trust: 'granted' | 'trusted' | 'declined';
  // the folders held in a remote host's trust mirror now
  held: string[];
  busy: boolean[];
  relocated: { readonly id: string } | { readonly refusal: Coded };
  trail: string[];
  confirms: LocateConfirm[];
  refusals: Coded[];
  preflights: PreflightRequest[];
  interrupted: LocatePrepared[];
  stated: string[];
}

const OK: PreflightAnswer = { ok: true, mode: 'locate', chats: 3, worktrees: 0, notices: [] };

function setup(world: Partial<World> = {}) {
  const w: World = {
    presence: 'missing', picked: NEW, answer: OK, afterTrust: undefined, confirmed: true, editorAnswers: new Map(), killConfirmed: true, trust: 'trusted', held: [], busy: [],
    relocated: { id: 'r1' }, trail: [], confirms: [], refusals: [], preflights: [], interrupted: [], stated: [], ...world,
  };
  const deps: LocateProjectDeps = {
    project: () => ({ name: 'acme', fsPath: OLD }),
    presence: () => w.presence,
    listed: () => [OLD],
    pathPresence: async (candidate) => {
      w.stated.push(candidate);
      return candidate === path.dirname(OLD) ? 'directory' : 'missing';
    },
    pathFlavor: path,
    pickFolder: vi.fn(async (defaultPath: string | undefined) => {
      w.trail.push(`pick:${defaultPath}`);
      return w.picked;
    }),
    busy: async () => w.busy.shift() ?? false,
    // precheck: the preflight before the trust question, which reads no repository identity
    preflight: async (request) => {
      w.preflights.push(request);
      const step = request.identity === 'skip' ? 'precheck' : 'preflight';
      w.trail.push(w.held.length > 0 ? `${step} held:${w.held.join(',')}` : step);
      return request.identity === 'skip' ? w.answer : w.afterTrust ?? w.answer;
    },
    confirm: async (question) => {
      w.confirms.push(question);
      w.trail.push('confirm');
      return w.confirmed;
    },
    confirmCloseRoot: async () => {
      w.trail.push('editors');
      return w.editorAnswers;
    },
    terminals: {
      idsIn: () => ['t1'],
      confirmKill: async () => {
        w.trail.push('terminals');
        return w.killConfirmed;
      },
    },
    askTrust: async (fsPath) => {
      w.trail.push(`trust:${fsPath}`);
      if (w.trust !== 'granted') return { trusted: w.trust === 'trusted' };
      return { trusted: true, undo: async () => { w.trail.push('undo'); } };
    },
    closeChats: async () => {
      w.trail.push('closeChats');
    },
    relocate: async () => {
      w.trail.push('relocate');
      return w.relocated;
    },
    started: (id) => w.trail.push(`started:${id}`),
    interrupted: (prepared) => w.interrupted.push(prepared),
    refused: (_, refusal) => w.refusals.push(refusal),
    t,
  };
  return { w, deps };
}

describe('locateProject', () => {
  const PICK = `pick:${path.dirname(OLD)}`;
  const TRUST = `trust:${NEW}`;

  // core reads the new folder's root commits only once it is trusted, so the preflight that reads them comes after the trust
  // question, and the refusals that need no trust come before it
  it('asks in order, picking from the nearest existing ancestor, checking what needs no trust, asking trust, and starts the move', async () => {
    const { w, deps } = setup();
    expect(await locateProject('acme-key', deps)).toEqual({ kind: 'started', id: 'r1' });
    expect(w.trail).toEqual([PICK, 'precheck', TRUST, 'preflight', 'confirm', 'editors', 'terminals', 'closeChats', 'relocate', 'started:r1']);
    expect(w.preflights).toEqual([{ from: OLD, to: NEW, listed: [OLD], heldHere: 'ignore', identity: 'skip' }, { from: OLD, to: NEW, listed: [OLD], heldHere: 'ignore' }]);
    expect(w.confirms[0]).toMatchObject({ title: `Move acme's chats to ${NEW}?`, message: '3 chats move, with their history, checkpoints, spend and memories.', confirmLabel: 'Move Chats' });
    expect(w.confirms[0]!.warning).toBeUndefined();
  });

  it('shows a preflight refusal on the row and changes nothing, asking no trust question for a refusal that needs no trust', async () => {
    const refusal: Coded = { code: 'chatHeld', params: { sessionId: 's1', title: 'Fix the build', holder: 'otherProcess' } };
    const { w, deps } = setup({ answer: { ok: false, refusal }, trust: 'granted' });
    expect(await locateProject('acme-key', deps)).toEqual({ kind: 'refused', refusal });
    expect(w.refusals).toEqual([refusal]);
    expect(w.trail).toEqual([PICK, 'precheck']);
    expect(relocationText(refusal, { name: 'acme', fsPath: OLD }, t)).toBe('The chat "Fix the build" is open in another Damocles window or in VS Code. Close it there, then locate the project.');
  });

  it('opens the picker at no folder for a project whose volume does not answer, stating none of its ancestors', async () => {
    const { w, deps } = setup({ presence: 'unavailable' });
    expect(await locateProject('acme-key', deps)).toEqual({ kind: 'started', id: 'r1' });
    expect(deps.pickFolder).toHaveBeenCalledWith(undefined);
    expect(w.stated).toEqual([]);
  });

  it('refuses as busy, asking nothing, when the hung gate still refuses an ancestor\'s check after the wait', async () => {
    const { w, deps } = setup({ trust: 'granted' });
    const busy = { ...deps, pathPresence: async (candidate: string) => (w.stated.push(candidate), 'unchecked' as const) };
    expect(await locateProject('acme-key', busy)).toEqual({ kind: 'refused', refusal: { code: 'checksBusy' } });
    expect(w.stated).toEqual([path.dirname(OLD)]);
    expect(deps.pickFolder).not.toHaveBeenCalled();
    expect(w.trail).toEqual([]);
    expect(w.refusals).toEqual([{ code: 'checksBusy' }]);
    expect(relocationText({ code: 'checksBusy' }, { name: 'acme', fsPath: OLD }, t)).toBe('Damocles can\'t check these folders right now: its drive checks are busy. Try again in a moment.');
  });

  it('refuses a project whose folder is there without asking anything', async () => {
    const { w, deps } = setup({ presence: 'present' });
    expect(await locateProject('acme-key', deps)).toEqual({ kind: 'refused', refusal: { code: 'fromExists' } });
    expect(w.trail).toEqual([]);
  });

  it.each([
    ['the picker', { picked: undefined }, [PICK]],
    ['the confirm dialog', { confirmed: false }, [PICK, 'precheck', TRUST, 'preflight', 'confirm']],
    ['the unsaved-editors question', { editorAnswers: undefined }, [PICK, 'precheck', TRUST, 'preflight', 'confirm', 'editors']],
    ['the terminal question', { killConfirmed: false }, [PICK, 'precheck', TRUST, 'preflight', 'confirm', 'editors', 'terminals']],
  ] as const)('a Cancel in %s changes nothing', async (_, world, trail) => {
    const { w, deps } = setup(world);
    expect(await locateProject('acme-key', deps)).toEqual({ kind: 'cancelled' });
    expect(w.trail).toEqual(trail);
  });

  it('asks the new folder for trust before the preflight that reads its identity, and a decline still moves the chats', async () => {
    const { w, deps } = setup({ trust: 'declined' });
    expect(await locateProject('acme-key', deps)).toEqual({ kind: 'started', id: 'r1' });
    expect(w.trail).toEqual([PICK, 'precheck', TRUST, 'preflight', 'confirm', 'editors', 'terminals', 'closeChats', 'relocate', 'started:r1']);
  });

  it.each([
    ['a turn running at the pick', { busy: [true] }, [PICK], { code: 'busy' }],
    ['a refusal of the picked folder itself', { answer: { ok: false, refusal: { code: 'insideDamocles' } } }, [PICK, 'precheck'], { code: 'insideDamocles' }],
    ['a pending relocation', { answer: { ok: false, refusal: { code: 'pendingRelocation' } } }, [PICK, 'precheck'], { code: 'pendingRelocation' }],
  ] as const)('refuses %s before the trust question, asking nothing', async (_, world, trail, refusal) => {
    const { w, deps } = setup({ ...world, trust: 'granted' } as Partial<World>);
    expect(await locateProject('acme-key', deps)).toEqual({ kind: 'refused', refusal });
    expect(w.trail).toEqual(trail);
    expect(w.refusals).toEqual([refusal]);
  });

  it.each([
    ['a Cancel in the confirm dialog', { confirmed: false }, 'confirm'],
    ['a Cancel in the unsaved-editors question', { editorAnswers: undefined }, 'editors'],
    ['a Cancel in the terminal question', { killConfirmed: false }, 'terminals'],
    ['a preflight refusal that read the identity', { afterTrust: { ok: false, refusal: { code: 'pendingRelocation' } } }, 'preflight'],
    ['a turn started while the trust question was open', { busy: [false, true] }, TRUST],
    ['a turn started while the questions were open', { busy: [false, false, true] }, 'terminals'],
    ['core refusing the move', { relocated: { refusal: { code: 'pendingRelocation' } } }, 'relocate'],
  ] as const)('takes back the grant its own trust question made after %s', async (_, world, last) => {
    const { w, deps } = setup({ ...world, trust: 'granted' } as Partial<World>);
    expect((await locateProject('acme-key', deps)).kind).not.toBe('started');
    expect(w.trail.slice(-2)).toEqual([last, 'undo']);
  });

  // the row shows the refusal once the grant is taken back, so a second Locate meanwhile is not cancelled for nothing
  it.each([
    ['a preflight refusal after the trust question', { afterTrust: { ok: false, refusal: { code: 'pendingRelocation' } } }],
    ['a turn started while the questions were open', { busy: [false, false, true] }],
    ['core refusing the move', { relocated: { refusal: { code: 'pendingRelocation' } } }],
  ] as const)('reports %s on the row only after its undo finished', async (_, world) => {
    const { w, deps } = setup({ ...world, trust: 'granted' } as Partial<World>);
    // the undo ends only after a turn, so a report made at its start would come before 'undo'
    const askTrust: LocateProjectDeps['askTrust'] = async (fsPath) => ({ ...(await deps.askTrust(fsPath)), undo: async () => {
      await Promise.resolve();
      w.trail.push('undo');
    } });
    const reporting: LocateProjectDeps = { ...deps, askTrust, refused: (_key, refusal) => w.trail.push(`refused:${refusal.code}`) };
    expect((await locateProject('acme-key', reporting)).kind).toBe('refused');
    expect(w.trail.slice(-2)).toEqual(['undo', expect.stringMatching(/^refused:/)]);
  });

  it('takes back the grant when a step before relocate throws, and the error goes on', async () => {
    const { w, deps } = setup({ trust: 'granted' });
    const failing: LocateProjectDeps = { ...deps, preflight: async (request) => {
      if (request.identity === 'skip') return deps.preflight(request);
      w.trail.push('preflight');
      throw new Error('Damocles Core restarted');
    } };
    await expect(locateProject('acme-key', failing)).rejects.toThrow('Damocles Core restarted');
    expect(w.trail).toEqual([PICK, 'precheck', TRUST, 'preflight', 'undo']);
  });

  it('takes back the grant when the trust hold throws', async () => {
    const { w, deps } = setup({ trust: 'granted' });
    const failing: LocateProjectDeps = { ...deps, holdTrust: () => {
      w.trail.push('hold');
      throw new Error('the trust mirror is gone');
    } };
    await expect(locateProject('acme-key', failing)).rejects.toThrow('the trust mirror is gone');
    expect(w.trail).toEqual([PICK, 'precheck', TRUST, 'hold', 'undo']);
  });

  it.each(['trusted', 'declined'] as const)('revokes nothing on a Cancel when the answer has no undo (%s before, or another question granted it)', async (trust) => {
    const { w, deps } = setup({ trust, confirmed: false });
    expect(await locateProject('acme-key', deps)).toEqual({ kind: 'cancelled' });
    expect(w.trail).not.toContain('undo');
  });

  it('keeps the grant once the move started, and once relocate was sent and failed without an answer', async () => {
    const started = setup({ trust: 'granted' });
    expect(await locateProject('acme-key', started.deps)).toEqual({ kind: 'started', id: 'r1' });
    expect(started.w.trail).not.toContain('undo');
    const { w, deps } = setup({ trust: 'granted' });
    const failing: LocateProjectDeps = { ...deps, relocate: async () => Promise.reject(new Error('Damocles Core restarted')) };
    await expect(locateProject('acme-key', failing)).rejects.toThrow('Damocles Core restarted');
    expect(w.trail).not.toContain('undo');
  });

  // a remote host's core reads trust only from main's mirror
  it('holds the picked folder in the host\'s trust mirror from the trust answer until Locate ends, however it ends', async () => {
    const outcomes: Array<[Partial<World>, (deps: LocateProjectDeps) => LocateProjectDeps]> = [
      [{}, (deps) => deps],
      [{ confirmed: false }, (deps) => deps],
      [{ afterTrust: { ok: false, refusal: { code: 'pendingRelocation' } } }, (deps) => deps],
      [{}, (deps) => ({ ...deps, preflight: async (request) => (request.identity === 'skip' ? deps.preflight(request) : Promise.reject(new Error('Damocles Core restarted'))) })],
    ];
    for (const [world, change] of outcomes) {
      const { w, deps } = setup({ ...world, trust: 'granted' });
      const holding = change({ ...deps, holdTrust: (fsPath) => {
        w.trail.push(`hold:${fsPath}`);
        w.held.push(fsPath);
        return () => {
          w.held.splice(w.held.indexOf(fsPath), 1);
          w.trail.push('release');
        };
      } });
      await locateProject('acme-key', holding).catch(() => undefined);
      expect(w.trail.slice(0, 4)).toEqual([PICK, 'precheck', TRUST, `hold:${NEW}`]);
      if (holding.preflight === deps.preflight) expect(w.trail[4]).toBe(`preflight held:${NEW}`);
      expect(w.trail.at(-1)).toBe('release');
      expect(w.held).toEqual([]);
    }
  });

  it('warns above the buttons for an unreachable old folder, and shows the merge and inside-project notices', async () => {
    const notices: Coded[] = [{ code: 'unreachable', params: { root: '\\\\nas\\share\\' } }, { code: 'merge', params: { projectPath: NEW } }, { code: 'insideProject', params: { projectPath: path.dirname(NEW) } }];
    const { w, deps } = setup({ presence: 'unavailable', answer: { ok: true, mode: 'merge', chats: 1, worktrees: 0, notices } });
    expect(await locateProject('acme-key', deps)).toEqual({ kind: 'started', id: 'r1' });
    const [question] = w.confirms;
    expect(question!.warning).toBe(`\\\\nas\\share\\ is not reachable, so Damocles can't check that ${OLD} is gone. If it still exists there, it will no longer show these chats.`);
    expect(question!.message).toBe(`1 chat moves, with its history, checkpoints, spend and memories. ${NEW} is a project already: its settings and layout stay, and these chats join its chats. The new folder is inside the project ${path.dirname(NEW)}.`);
  });

  it('warns when the new folder shares no remote and no first commit with the old one', async () => {
    const notices: Coded[] = [{ code: 'unreachable', params: { root: 'D:\\' } }, { code: 'otherRepository' }];
    const { w, deps } = setup({ answer: { ok: true, mode: 'locate', chats: 2, worktrees: 0, notices } });
    await locateProject('acme-key', deps);
    expect(w.confirms[0]!.warning).toBe(`D:\\ is not reachable, so Damocles can't check that ${OLD} is gone. If it still exists there, it will no longer show these chats. The new folder looks like another repository: it shares no remote and no first commit with ${OLD}.`);
    expect(w.confirms[0]!.message).toBe('2 chats move, with their history, checkpoints, spend and memories.');
  });

  it('moves to the folder an offer named without the picker, the confirmation, the trust question or a mirror hold', async () => {
    const { w, deps } = setup({ trust: 'declined' });
    const holdTrust = vi.fn(() => () => undefined);
    expect(await locateProject('acme-key', { ...deps, holdTrust }, NEW)).toEqual({ kind: 'started', id: 'r1' });
    expect(w.trail).toEqual(['preflight', 'editors', 'terminals', 'closeChats', 'relocate', 'started:r1']);
    expect(w.preflights[0]).toEqual({ from: OLD, to: NEW, listed: [OLD], heldHere: 'ignore' });
    expect(holdTrust).not.toHaveBeenCalled();
  });

  // the folder is still gone: reopened, they would only fail to start there
  it('keeps the chats it closed waiting for the folder when core refuses the move after all', async () => {
    const refusal: Coded = { code: 'pendingRelocation', params: { path: OLD } };
    const { w, deps } = setup({ relocated: { refusal } });
    expect(await locateProject('acme-key', deps)).toEqual({ kind: 'refused', refusal });
    expect(w.trail.slice(-2)).toEqual(['closeChats', 'relocate']);
    expect(w.refusals).toEqual([refusal]);
    expect(w.interrupted).toEqual([]);
  });

  it('shows core\'s refusal of a folder in a chat worktree on the row, naming the project it belongs to, and asks nothing more', async () => {
    const worktree = path.resolve('/home/.damocles/worktrees/acme-111111/aaaa1111');
    const refusal: Coded = { code: 'chatWorktree', params: { projectPath: NEW } };
    const { w, deps } = setup({ answer: { ok: false, refusal } });
    expect(await locateProject('acme-key', deps)).toEqual({ kind: 'refused', refusal });
    expect(w.refusals).toEqual([refusal]);
    expect(w.trail).toEqual([PICK, 'precheck']);
    expect(relocationText(refusal, { name: 'aaaa1111', fsPath: worktree }, t)).toBe(`${worktree} is a chat worktree of ${NEW}, which Damocles keeps in place, so it can't be located. Move the folder back if you moved it, or remove this project.`);
    expect(relocationText({ code: 'chatWorktree' }, { name: 'aaaa1111', fsPath: worktree }, t)).toBe(`${worktree} is in the folder where Damocles keeps chat worktrees, so it can't be located. Remove this project.`);
  });

  // core may have written the journal before the request failed, and then resumes the move
  it('keeps the chats it closed waiting and records the request when the move request fails', async () => {
    const answers = new Map([['file:///work/acme/a.ts', 'save']]);
    const { w, deps } = setup({ editorAnswers: answers });
    const failing: LocateProjectDeps = { ...deps, relocate: async () => {
      w.trail.push('relocate');
      return Promise.reject(new Error('Damocles Core restarted'));
    } };
    await expect(locateProject('acme-key', failing)).rejects.toThrow('Damocles Core restarted');
    expect(w.trail.slice(-2)).toEqual(['closeChats', 'relocate']);
    expect(w.interrupted).toEqual([{ key: 'acme-key', from: OLD, to: NEW, answers }]);
  });
});

describe('locateOnce', () => {
  it('cancels a second Locate of the project while the first runs, asking nothing, and lets the next one run', async () => {
    const { w, deps } = setup();
    let pick!: (picked: string | undefined) => void;
    const picking: LocateProjectDeps = { ...deps, pickFolder: vi.fn(async () => new Promise<string | undefined>((resolve) => (pick = resolve))) };
    const running = new Set<string>();
    const first = locateOnce(running, 'acme-key', () => locateProject('acme-key', picking));
    expect(await locateOnce(running, 'acme-key', () => locateProject('acme-key', picking))).toEqual({ kind: 'cancelled' });
    await vi.waitFor(() => expect(picking.pickFolder).toHaveBeenCalledTimes(1));
    pick(NEW);
    expect(await first).toEqual({ kind: 'started', id: 'r1' });
    expect(picking.pickFolder).toHaveBeenCalledTimes(1);
    expect(await locateOnce(running, 'acme-key', () => locateProject('acme-key', deps))).toEqual({ kind: 'started', id: 'r1' });
    expect(w.trail.filter((step) => step === 'relocate')).toHaveLength(2);
  });

  it('lets the next Locate run after one that threw', async () => {
    const running = new Set<string>();
    await expect(locateOnce(running, 'acme-key', async () => Promise.reject(new Error('gone')))).rejects.toThrow('gone');
    expect(await locateOnce(running, 'acme-key', async () => ({ kind: 'started', id: 'r2' }))).toEqual({ kind: 'started', id: 'r2' });
  });
});

describe('InterruptedLocates', () => {
  const prepared: LocatePrepared = { key: 'acme-key', from: OLD, to: NEW, answers: new Map() };

  it('counts a move core reports later with the same folders as requested here, once', () => {
    const interrupted = new InterruptedLocates();
    interrupted.record('local', prepared);
    expect(interrupted.adopt('remote:box', { from: OLD, to: NEW })).toBeUndefined();
    expect(interrupted.adopt('local', { from: OLD, to: path.resolve('/elsewhere') })).toBeUndefined();
    expect(interrupted.adopt('local', { from: OLD, to: NEW })).toBe(prepared);
    expect(interrupted.adopt('local', { from: OLD, to: NEW })).toBeUndefined();
  });

  it('forgets a project\'s failed request once a later Locate of it started', () => {
    const interrupted = new InterruptedLocates();
    interrupted.record('local', prepared);
    interrupted.forget('local', 'acme-key');
    expect(interrupted.adopt('local', { from: OLD, to: NEW })).toBeUndefined();
  });
});

describe('preparedMove', () => {
  it('takes a reported move for the one Locate prepared under its id only when it names the same folders, by their keys', () => {
    const prepared: LocatePrepared = { key: 'ssh+box|/srv/acme', from: '/srv/acme', to: '/srv/moved', answers: new Map() };
    const keyOf = (fsPath: string): string => `ssh+box|${path.posix.resolve(fsPath)}`;
    expect(preparedMove(prepared, { from: '/srv/acme/', to: '/srv/moved' }, keyOf)).toBe(true);
    expect(preparedMove(prepared, { from: '/srv/other', to: '/srv/moved' }, keyOf)).toBe(false);
    expect(preparedMove(prepared, { from: '/srv/acme', to: '/srv/elsewhere' }, keyOf)).toBe(false);
  });
});

describe('nearestExistingAncestor', () => {
  it('walks up to the first directory, and answers undefined when even the root is gone', async () => {
    const deep = path.resolve('/a/b/c/d');
    expect(await nearestExistingAncestor(deep, async (candidate) => (candidate === path.resolve('/a') ? 'directory' : 'missing'), path)).toBe(path.resolve('/a'));
    expect(await nearestExistingAncestor(deep, async () => 'missing', path)).toBeUndefined();
  });

  it('stops at the first ancestor that does not answer', async () => {
    const seen: string[] = [];
    expect(await nearestExistingAncestor('/mnt/nas/work/acme', async (candidate) => {
      seen.push(candidate);
      return candidate === '/mnt/nas/work' ? 'unreachable' : 'directory';
    }, path.posix)).toBeUndefined();
    expect(seen).toEqual(['/mnt/nas/work']);
  });

  it('stops at the first ancestor the hung gate did not check, answering unchecked, never reading it as a dead volume', async () => {
    const seen: string[] = [];
    expect(await nearestExistingAncestor('/mnt/nas/work/acme', async (candidate) => {
      seen.push(candidate);
      return candidate === '/mnt/nas/work' ? 'unchecked' : 'directory';
    }, path.posix)).toBe('unchecked');
    expect(seen).toEqual(['/mnt/nas/work']);
  });

  it('walks a host path by the host\'s path rules, whatever this computer\'s are', async () => {
    const seen: string[] = [];
    expect(await nearestExistingAncestor('/srv/apps/acme', async (candidate) => {
      seen.push(candidate);
      return candidate === '/srv' ? 'directory' : 'missing';
    }, path.posix)).toBe('/srv');
    expect(seen).toEqual(['/srv/apps', '/srv']);
    expect(await nearestExistingAncestor('C:\\work\\acme', async (candidate) => (candidate === 'C:\\' ? 'directory' : 'missing'), path.win32)).toBe('C:\\');
  });
});

describe('relocationText', () => {
  it('renders every refusal, notice and failure code, and an unknown one by its code', () => {
    const project = { name: 'acme', fsPath: OLD };
    const codes = ['busy', 'fromExists', 'toMissing', 'toNotDirectory', 'sameFolder', 'insideDamocles', 'otherAuthority', 'chatWorktree', 'pendingRelocation', 'chatHeld', 'registryUnreadable', 'hasWorktrees', 'unreachable', 'otherRepository', 'insideProject', 'merge', 'conflict', 'io', 'memoryReadOnly', 'locked', 'stopped', 'agentRunHeld', 'agentRunning', 'checksBusy'];
    const texts = codes.map((code) => relocationText({ code }, project, t));
    expect(new Set(texts).size).toBe(codes.length);
    expect(texts.every((text) => !text.includes('{'))).toBe(true);
    expect(relocationText({ code: 'chatHeld', params: { title: 'Plan', holder: 'thisProcess' } }, project, t)).toBe('The chat "Plan" is open in this window. Close it, then locate the project.');
    expect(relocationText({ code: 'agentRunHeld', params: { title: 'Plan', holder: 'thisProcess' } }, project, t)).toBe('A subagent or team of the chat "Plan" is still running in this window. Wait for it to finish, then locate the project.');
    expect(relocationText({ code: 'agentRunHeld', params: { title: 'Plan', holder: 'otherProcess' } }, project, t)).toBe('A subagent or team of the chat "Plan" is still running in another Damocles window or in VS Code. Wait for it to finish, then locate the project.');
    expect(relocationText({ code: 'agentRunning', params: { sessionId: 's1' } }, project, t)).toBe('The move paused: a subagent or team of a chat of acme is still running. Wait for it to finish, then retry.');
    expect(relocationText({ code: 'later' }, project, t)).toBe('The move paused (later).');
    const memory = ['disabled', 'readOnly', 'unavailable'].map((reason) => relocationText({ code: 'memoryReadOnly', params: { reason } }, project, t));
    expect(new Set([...memory, texts[codes.indexOf('memoryReadOnly')]]).size).toBe(4);
    expect(memory.some((text) => /disabled|readOnly|unavailable/.test(text))).toBe(false);
  });

  it('renders the memories waiting on an earlier move, and why Stop moving was refused', () => {
    const project = { name: 'acme', fsPath: OLD };
    expect(relocationText({ code: 'earlierMove', params: { path: NEW } }, project, t)).toBe(`The project's memories move once an earlier move of ${NEW} has moved its own. Damocles moves them then.`);
    expect(relocationText({ code: 'notPaused' }, project, t)).toBe('The move of acme is no longer paused, so it was not stopped.');
    expect(relocationText({ code: 'relocationRunning' }, project, t)).toBe('The move of acme is running, so it was not stopped.');
  });
});

describe('locateShown', () => {
  const refusal: Coded = { code: 'fromExists' };
  const managed = (): Coded => ({ code: 'chatWorktree' });
  const none = (): undefined => undefined;

  it('shows the move its core runs or paused, whatever the folder\'s presence', () => {
    expect(locateShown({ id: 'r1' }, false, none, refusal)).toEqual({ state: 'move', view: { id: 'r1' } });
    expect(locateShown({ id: 'r1' }, true, managed, refusal)).toEqual({ state: 'move', view: { id: 'r1' } });
  });

  it('shows a refusal only while the folder is not there, and a folder in a chat worktree over it', () => {
    expect(locateShown(undefined, true, none, refusal)).toEqual({ state: 'refused', reason: refusal });
    expect(locateShown(undefined, true, managed, refusal)).toEqual({ state: 'notLocatable', reason: { code: 'chatWorktree' } });
    expect(locateShown(undefined, false, managed, refusal)).toBeUndefined();
    expect(locateShown(undefined, true, none, undefined)).toBeUndefined();
  });
});
