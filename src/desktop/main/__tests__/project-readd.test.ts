import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OverlayQuickPickItem } from '../../preload/overlay-channels';
import type { LocateConfirm, LocateOutcome } from '../locate-project';
import { addProjectAt, type MissingProject, type ReaddDeps } from '../project-readd';
import type { TrustAnswer } from '../trust-store';

const t = (message: string, ...args: string[]): string => message.replace(/\{(\d+)\}/g, (_, index: string) => args[Number(index)] ?? '');

const ADDED = path.resolve('/clones/acme');
const ACME: MissingProject = { key: 'acme-key', name: 'acme', fsPath: path.resolve('/work/acme'), chats: 3 };
const OLDER: MissingProject = { key: 'older-key', name: 'acme (old)', fsPath: path.resolve('/older/acme'), chats: 1 };

interface World {
  candidates: readonly MissingProject[];
  confirmed: boolean;
  picked: string | undefined;
  // granted: this call's own question made the grant, so the answer has an undo
  trust: 'granted' | 'trusted' | 'declined';
  moved: LocateOutcome;
  failAt: 'candidates' | 'add' | undefined;
  trail: string[];
  confirms: LocateConfirm[];
  picks: Array<{ placeholder: string; items: readonly OverlayQuickPickItem[] }>;
}

function setup(world: Partial<World> = {}) {
  const w: World = { candidates: [], confirmed: true, picked: undefined, trust: 'granted', moved: { kind: 'started', id: 'r1' }, failAt: undefined, trail: [], confirms: [], picks: [], ...world };
  const deps: ReaddDeps = {
    askTrust: async (folder): Promise<TrustAnswer> => {
      w.trail.push(`trust:${folder}`);
      if (w.trust !== 'granted') return { trusted: w.trust === 'trusted' };
      return { trusted: true, undo: async () => { w.trail.push('undo'); } };
    },
    candidates: async (folder) => {
      w.trail.push(`candidates:${folder}`);
      if (w.failAt === 'candidates') throw new Error('core restarted');
      return w.candidates;
    },
    confirm: async (question) => {
      w.confirms.push(question);
      w.trail.push('ask');
      return w.confirmed;
    },
    pick: async (placeholder, items) => {
      w.picks.push({ placeholder, items });
      w.trail.push('pick');
      return w.picked;
    },
    add: async () => {
      w.trail.push('add');
      if (w.failAt === 'add') throw new Error('projects.json is read-only');
    },
    moveChats: async (key, folder) => {
      w.trail.push(`move:${key}:${folder}`);
      return w.moved;
    },
    newChat: async () => { w.trail.push('newChat'); },
    t,
  };
  return { w, deps };
}

describe('addProjectAt', () => {
  it('asks for trust first, then looks for a missing project, adds a folder none matches and opens a new chat', async () => {
    const { w, deps } = setup();
    expect(await addProjectAt(ADDED, deps)).toBe('added');
    expect(w.trail).toEqual([`trust:${ADDED}`, `candidates:${ADDED}`, 'add', 'newChat']);
  });

  // core reads a folder's root commits only once it is trusted, so the match comes after the trust question
  it('asks for trust before the match; when one missing project matches, Move Chats adds and moves instead of opening a new chat', async () => {
    const { w, deps } = setup({ candidates: [ACME] });
    expect(await addProjectAt(ADDED, deps)).toBe('moving');
    expect(w.trail).toEqual([`trust:${ADDED}`, `candidates:${ADDED}`, 'ask', 'add', `move:acme-key:${ADDED}`]);
    expect(w.confirms[0]).toEqual({
      title: 'Move acme\'s chats here?',
      message: `The folder of acme is missing, and ${ADDED} is a folder of the same repository. 3 chats move, with their history, checkpoints, spend and memories.`,
      detail: { label: 'Missing folder', text: ACME.fsPath },
      confirmLabel: 'Move Chats',
      cancelLabel: 'Not Now',
    });
  });

  it('adds normally on Not Now, keeping the missing project as it is', async () => {
    const { w, deps } = setup({ candidates: [ACME], confirmed: false });
    expect(await addProjectAt(ADDED, deps)).toBe('added');
    expect(w.trail).toEqual([`trust:${ADDED}`, `candidates:${ADDED}`, 'ask', 'add', 'newChat']);
  });

  it('opens a new chat in the added folder when the move is cancelled or refused', async () => {
    for (const moved of [{ kind: 'cancelled' }, { kind: 'refused', refusal: { code: 'chatHeld' } }] as const) {
      const { w, deps } = setup({ candidates: [ACME], moved });
      expect(await addProjectAt(ADDED, deps)).toBe('added');
      // the folder is listed by then, so its trust stays
      expect(w.trail.slice(-3)).toEqual(['add', `move:acme-key:${ADDED}`, 'newChat']);
    }
  });

  it('lists several matches with their folders and chat counts, ending in Not Now', async () => {
    const { w, deps } = setup({ candidates: [ACME, OLDER], picked: 'older-key' });
    expect(await addProjectAt(ADDED, deps)).toBe('moving');
    expect(w.trail).toEqual([`trust:${ADDED}`, `candidates:${ADDED}`, 'pick', 'add', `move:older-key:${ADDED}`]);
    expect(w.picks[0]).toEqual({
      placeholder: `Move the chats of a missing project to ${ADDED}?`,
      items: [
        { id: 'acme-key', label: 'acme', description: ACME.fsPath, hint: '3 chats' },
        { id: 'older-key', label: 'acme (old)', description: OLDER.fsPath, hint: '1 chat' },
        { id: 'notNow', label: 'Not Now' },
      ],
    });
  });

  it('adds normally when the pick list is dismissed or answered Not Now', async () => {
    for (const picked of [undefined, 'notNow']) {
      const { w, deps } = setup({ candidates: [ACME, OLDER], picked });
      expect(await addProjectAt(ADDED, deps)).toBe('added');
      expect(w.trail).toEqual([`trust:${ADDED}`, `candidates:${ADDED}`, 'pick', 'add', 'newChat']);
    }
  });

  it('still adds a folder whose trust was declined, and still offers what core matched by remotes', async () => {
    const { w, deps } = setup({ trust: 'declined', candidates: [ACME] });
    expect(await addProjectAt(ADDED, deps)).toBe('moving');
    expect(w.trail).toEqual([`trust:${ADDED}`, `candidates:${ADDED}`, 'ask', 'add', `move:acme-key:${ADDED}`]);
  });

  it.each(['candidates', 'add'] as const)('takes back the grant its own question made when %s fails before the folder is listed', async (failAt) => {
    const { w, deps } = setup({ failAt, candidates: [ACME] });
    await expect(addProjectAt(ADDED, deps)).rejects.toThrow(failAt === 'add' ? 'projects.json is read-only' : 'core restarted');
    expect(w.trail.at(-1)).toBe('undo');
    expect(w.trail.filter((step) => step === 'undo')).toHaveLength(1);
  });

  it.each(['trusted', 'declined'] as const)('revokes nothing on a failure when the answer has no undo (%s before, or another question granted it)', async (trust) => {
    const { w, deps } = setup({ trust, failAt: 'add' });
    await expect(addProjectAt(ADDED, deps)).rejects.toThrow('projects.json is read-only');
    expect(w.trail).not.toContain('undo');
  });

  it('keeps the grant once the folder is listed', async () => {
    for (const moved of [{ kind: 'started', id: 'r1' }, { kind: 'cancelled' }] as const) {
      const { w, deps } = setup({ candidates: [ACME], moved });
      await addProjectAt(ADDED, deps);
      expect(w.trail).not.toContain('undo');
    }
  });

  it('throws both errors when taking back the grant fails too', async () => {
    const { deps } = setup({ failAt: 'add' });
    const failing: ReaddDeps = { ...deps, askTrust: async () => ({ trusted: true, undo: async () => { throw new Error('trusted-folders.json is read-only'); } }) };
    const thrown = await addProjectAt(ADDED, failing).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors.map((err: Error) => err.message)).toEqual(['projects.json is read-only', 'trusted-folders.json is read-only']);
    expect((thrown as AggregateError).message).toBe('projects.json is read-only (the folder\'s trust was not taken back: trusted-folders.json is read-only)');
  });
});
