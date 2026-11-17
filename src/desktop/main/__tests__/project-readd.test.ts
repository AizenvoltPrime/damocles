import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OverlayQuickPickItem } from '../../preload/overlay-channels';
import type { LocateConfirm, LocateOutcome } from '../locate-project';
import { addProjectAt, type MissingProject, type ReaddDeps } from '../project-readd';

const t = (message: string, ...args: string[]): string => message.replace(/\{(\d+)\}/g, (_, index: string) => args[Number(index)] ?? '');

const ADDED = path.resolve('/clones/acme');
const ACME: MissingProject = { key: 'acme-key', name: 'acme', fsPath: path.resolve('/work/acme'), chats: 3 };
const OLDER: MissingProject = { key: 'older-key', name: 'acme (old)', fsPath: path.resolve('/older/acme'), chats: 1 };

interface World {
  candidates: readonly MissingProject[];
  confirmed: boolean;
  picked: string | undefined;
  trusted: boolean;
  moved: LocateOutcome;
  trail: string[];
  confirms: LocateConfirm[];
  picks: Array<{ placeholder: string; items: readonly OverlayQuickPickItem[] }>;
}

function setup(world: Partial<World> = {}) {
  const w: World = { candidates: [], confirmed: true, picked: undefined, trusted: false, moved: { kind: 'started', id: 'r1' }, trail: [], confirms: [], picks: [], ...world };
  const deps: ReaddDeps = {
    candidates: async (folder) => {
      w.trail.push(`candidates:${folder}`);
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
    add: async () => { w.trail.push('add'); },
    isTrusted: () => w.trusted,
    requestTrust: async () => {
      w.trail.push('trust');
      return true;
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
  it('adds a folder no missing project matches, asks for trust, then opens a new chat', async () => {
    const { w, deps } = setup();
    expect(await addProjectAt(ADDED, deps)).toBe('added');
    expect(w.trail).toEqual([`candidates:${ADDED}`, 'add', 'trust', 'newChat']);
  });

  it('asks before adding when one missing project matches; Move Chats adds, asks for trust and moves instead of opening a new chat', async () => {
    const { w, deps } = setup({ candidates: [ACME] });
    expect(await addProjectAt(ADDED, deps)).toBe('moving');
    expect(w.trail).toEqual([`candidates:${ADDED}`, 'ask', 'add', 'trust', `move:acme-key:${ADDED}`]);
    expect(w.confirms[0]).toEqual({
      title: 'Move acme\'s chats here?',
      message: `The folder of acme is missing, and ${ADDED} is a folder of the same repository. 3 chats move, with their history, checkpoints, spend and memories.`,
      detail: { label: 'Missing folder', text: ACME.fsPath },
      confirmLabel: 'Move Chats',
      cancelLabel: 'Not Now',
    });
  });

  it('adds normally on Not Now, keeping the missing project as it is', async () => {
    const { w, deps } = setup({ candidates: [ACME], confirmed: false, trusted: true });
    expect(await addProjectAt(ADDED, deps)).toBe('added');
    expect(w.trail).toEqual([`candidates:${ADDED}`, 'ask', 'add', 'newChat']);
  });

  it('opens a new chat in the added folder when the move is cancelled or refused', async () => {
    for (const moved of [{ kind: 'cancelled' }, { kind: 'refused', refusal: { code: 'chatHeld' } }] as const) {
      const { w, deps } = setup({ candidates: [ACME], trusted: true, moved });
      expect(await addProjectAt(ADDED, deps)).toBe('added');
      expect(w.trail.slice(-2)).toEqual([`move:acme-key:${ADDED}`, 'newChat']);
    }
  });

  it('lists several matches with their folders and chat counts, ending in Not Now', async () => {
    const { w, deps } = setup({ candidates: [ACME, OLDER], picked: 'older-key' });
    expect(await addProjectAt(ADDED, deps)).toBe('moving');
    expect(w.trail).toEqual([`candidates:${ADDED}`, 'pick', 'add', 'trust', `move:older-key:${ADDED}`]);
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
      const { w, deps } = setup({ candidates: [ACME, OLDER], picked, trusted: true });
      expect(await addProjectAt(ADDED, deps)).toBe('added');
      expect(w.trail).toEqual([`candidates:${ADDED}`, 'pick', 'add', 'newChat']);
    }
  });
});
