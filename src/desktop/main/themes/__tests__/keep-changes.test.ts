import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEEP_CHANGES_MS, type KeepChangesState } from '../../../../shared/themes/agent';
import { KEEP_RESULT_LINGER_MS, KeepChanges } from '../keep-changes';

// The keep-changes banner's state machine: one countdown at most, restarted by a later change of its entry, Keep and Revert
// through core, the timeout reverting, and every waiting tool call told the end.

const CHANGE = { kind: 'create', theme: 'Amber', picked: ['dark'] } as const;

function setup(revertUndid = true) {
  const published: Array<KeepChangesState | undefined> = [];
  const keep = vi.fn(async () => undefined);
  const revert = vi.fn(async () => revertUndid);
  const banner = new KeepChanges({ keep, revert, publish: (state) => published.push(state), log: () => undefined });
  return { banner, published, keep, revert, last: () => published.at(-1) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('KeepChanges', () => {
  it('counts down 15 s and reverts through core on the timeout; the waiting call gets reverted, and the banner lingers then goes', async () => {
    const { banner, revert, last } = setup();
    const outcome = banner.applied({ entryId: 'e1', chatTitle: 'Warm', change: CHANGE });
    expect(banner.counting()).toBe(true);
    expect(last()).toEqual({ phase: 'counting', endsAt: 1_000_000 + KEEP_CHANGES_MS, durationMs: KEEP_CHANGES_MS, chatTitle: 'Warm', change: CHANGE, changeCount: 1 });
    await vi.advanceTimersByTimeAsync(KEEP_CHANGES_MS);
    expect(revert).toHaveBeenCalledWith('e1');
    expect(await outcome).toBe('reverted');
    expect(last()).toMatchObject({ phase: 'reverted' });
    expect(banner.counting()).toBe(false);
    await vi.advanceTimersByTimeAsync(KEEP_RESULT_LINGER_MS);
    expect(last()).toBeUndefined();
  });

  it('a later change of the same entry restarts the countdown and grows the count; every waiting call gets the one end', async () => {
    const { banner, keep, revert, last } = setup();
    const first = banner.applied({ entryId: 'e1', change: CHANGE, previousName: 'Damocles' });
    await vi.advanceTimersByTimeAsync(10_000);
    const second = banner.applied({ entryId: 'e1', change: { kind: 'save', theme: 'Amber' } });
    expect(last()).toMatchObject({ phase: 'counting', endsAt: 1_010_000 + KEEP_CHANGES_MS, changeCount: 2, previousName: 'Damocles', change: { kind: 'save' } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(revert).not.toHaveBeenCalled();
    await banner.keep();
    expect(keep).toHaveBeenCalledWith('e1');
    expect(await first).toBe('kept');
    expect(await second).toBe('kept');
    expect(last()).toMatchObject({ phase: 'kept' });
  });

  it('Revert asks core to undo the entry', async () => {
    const { banner } = setup();
    const outcome = banner.applied({ entryId: 'e1', change: CHANGE });
    await banner.revert();
    expect(await outcome).toBe('reverted');
  });

  // Core sends themes.pendingSettled before it answers the revert, so the settle is handled first.
  it("a revert that undid nothing ends as core's word said when it came first, and sets no timer but the result's", async () => {
    const { banner, revert, last } = setup(false);
    const outcome = banner.applied({ entryId: 'e1', change: CHANGE });
    revert.mockImplementationOnce(async () => {
      banner.settled('e1', 'reverted');
      return false;
    });
    await banner.revert();
    expect(await outcome).toBe('reverted');
    expect(last()).toMatchObject({ phase: 'reverted' });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(KEEP_RESULT_LINGER_MS);
    expect(last()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a revert that undid nothing, with no word from core, ends kept at once', async () => {
    const { banner, last } = setup(false);
    const outcome = banner.applied({ entryId: 'e1', change: CHANGE });
    await banner.revert();
    expect(banner.counting()).toBe(false);
    expect(last()).toMatchObject({ phase: 'kept', endsAt: 1_000_000 });
    expect(await outcome).toBe('kept');
  });

  it('a timeout whose revert core refuses rejects nothing: it is logged once and the countdown counts again', async () => {
    const lines: string[] = [];
    const revert = vi.fn(async (): Promise<boolean> => true);
    revert.mockRejectedValueOnce(new Error('lock lost'));
    const published: Array<KeepChangesState | undefined> = [];
    const banner = new KeepChanges({ keep: async () => undefined, revert, publish: (state) => published.push(state), log: (line) => lines.push(line) });
    const rejections: unknown[] = [];
    const unhandled = (reason: unknown): void => void rejections.push(reason);
    process.on('unhandledRejection', unhandled);
    try {
      const outcome = banner.applied({ entryId: 'e1', change: CHANGE });
      await vi.advanceTimersByTimeAsync(KEEP_CHANGES_MS);
      // an unhandled rejection is reported on a later turn of the loop
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      vi.useFakeTimers();
      expect(rejections).toEqual([]);
      expect(lines).toEqual(['[themes] the keep-changes banner could not revert the change: lock lost']);
      expect(published.at(-1)).toMatchObject({ phase: 'counting' });
      await banner.revert();
      expect(await outcome).toBe('reverted');
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('Keep pressed while a revert is on its way to core asks core nothing more, and the revert decides the end', async () => {
    const { banner, keep, revert } = setup();
    let answer!: (undid: boolean) => void;
    revert.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      answer = resolve;
    }));
    const outcome = banner.applied({ entryId: 'e1', change: CHANGE });
    const reverting = banner.revert();
    await banner.keep();
    expect(keep).not.toHaveBeenCalled();
    expect(banner.counting()).toBe(true);
    answer(true);
    await reverting;
    expect(await outcome).toBe('reverted');
  });

  it('a Keep core refuses rejects for its caller and keeps the countdown running, counted again from the start', async () => {
    const { banner, keep, last } = setup();
    keep.mockRejectedValueOnce(new Error('lock lost'));
    const outcome = banner.applied({ entryId: 'e1', change: CHANGE });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(banner.keep()).rejects.toThrow('lock lost');
    expect(last()).toMatchObject({ phase: 'counting', endsAt: 1_005_000 + KEEP_CHANGES_MS });
    await banner.keep();
    expect(await outcome).toBe('kept');
  });

  it('dispose leaves no timer: neither the countdown nor the result that lingers', async () => {
    const counting = setup();
    void counting.banner.applied({ entryId: 'e1', change: CHANGE });
    counting.banner.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(KEEP_CHANGES_MS);
    expect(counting.revert).not.toHaveBeenCalled();

    const lingering = setup();
    void lingering.banner.applied({ entryId: 'e1', change: CHANGE });
    await lingering.banner.keep();
    lingering.banner.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an earlier banner's result never clears a banner that started while it lingered", async () => {
    const { banner, last } = setup();
    void banner.applied({ entryId: 'e1', change: CHANGE });
    await banner.keep();
    await vi.advanceTimersByTimeAsync(KEEP_RESULT_LINGER_MS - 1_000);
    void banner.applied({ entryId: 'e2', change: CHANGE });
    await vi.advanceTimersByTimeAsync(KEEP_RESULT_LINGER_MS);
    expect(last()).toMatchObject({ phase: 'counting' });
    expect(banner.entryId()).toBe('e2');
  });

  it('a call whose signal is already aborted rejects alone: core applied the change, so its countdown still starts', async () => {
    const { banner, last } = setup();
    const stop = new AbortController();
    stop.abort(new Error('stopped'));
    await expect(banner.applied({ entryId: 'e1', change: CHANGE }, stop.signal)).rejects.toThrow('stopped');
    expect(banner.counting()).toBe(true);
    expect(last()).toMatchObject({ phase: 'counting', changeCount: 1 });
  });

  it('a revert core refuses keeps the countdown running for another try', async () => {
    const { banner, revert, last } = setup();
    revert.mockRejectedValueOnce(new Error('lock lost'));
    const outcome = banner.applied({ entryId: 'e1', change: CHANGE });
    await expect(banner.revert()).rejects.toThrow('lock lost');
    expect(banner.counting()).toBe(true);
    expect(last()).toMatchObject({ phase: 'counting' });
    await vi.advanceTimersByTimeAsync(KEEP_CHANGES_MS);
    expect(revert).toHaveBeenCalledTimes(2);
    expect(await outcome).toBe('reverted');
  });

  it("core's word that another change settled the entry ends the banner without asking core again", async () => {
    const { banner, keep, revert } = setup();
    const outcome = banner.applied({ entryId: 'e1', change: CHANGE });
    banner.settled('other', 'reverted');
    expect(banner.counting()).toBe(true);
    banner.settled('e1', 'kept');
    expect(await outcome).toBe('kept');
    expect(keep).not.toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
  });

  it('one banner at most: a new entry ends the earlier one as kept and starts its own count', async () => {
    const { banner, last } = setup();
    const first = banner.applied({ entryId: 'e1', change: CHANGE });
    const second = banner.applied({ entryId: 'e2', change: CHANGE });
    expect(await first).toBe('kept');
    expect(last()).toMatchObject({ phase: 'counting', changeCount: 1 });
    expect(banner.entryId()).toBe('e2');
    await banner.keep();
    expect(await second).toBe('kept');
  });

  it("another chat's change and the user's join the one countdown: it restarts, keeps the look the first change replaced, names no single chat, and reverts the first change's entry", async () => {
    const { banner, revert, last } = setup();
    const first = banner.applied({ entryId: 'e1', chatId: 'chat-a', chatTitle: 'Warm', change: CHANGE, previousName: 'Damocles' });
    await vi.advanceTimersByTimeAsync(5_000);
    const second = banner.applied({ entryId: 'e1', chatId: 'chat-b', chatTitle: 'Cool', change: { kind: 'save', theme: 'Ice' }, previousName: 'Amber' });
    expect(last()).toMatchObject({ phase: 'counting', endsAt: 1_005_000 + KEEP_CHANGES_MS, changeCount: 2, several: true, previousName: 'Damocles' });
    expect(last()).not.toHaveProperty('chatTitle');
    await vi.advanceTimersByTimeAsync(10_000);
    banner.extended({ entryId: 'e1', change: { kind: 'pick', look: 'light', theme: 'Paper', was: 'Damocles' } });
    expect(last()).toMatchObject({ phase: 'counting', endsAt: 1_015_000 + KEEP_CHANGES_MS, changeCount: 3, several: true });
    await vi.advanceTimersByTimeAsync(KEEP_CHANGES_MS);
    expect(revert).toHaveBeenCalledWith('e1');
    expect(await first).toBe('reverted');
    expect(await second).toBe('reverted');
  });

  it("the same chat's changes keep naming it, and a change of the user alone starts a countdown no call waits on", async () => {
    const { banner, keep, last } = setup();
    void banner.applied({ entryId: 'e1', chatId: 'chat-a', chatTitle: 'Warm', change: CHANGE });
    void banner.applied({ entryId: 'e1', chatId: 'chat-a', chatTitle: 'Warm', change: { kind: 'save', theme: 'Amber' } });
    expect(last()).toMatchObject({ chatTitle: 'Warm', changeCount: 2 });
    expect(last()).not.toHaveProperty('several');
    await banner.keep();
    const other = setup();
    other.banner.extended({ entryId: 'e9', change: { kind: 'pick', look: 'dark', theme: 'Night', was: 'Damocles' } });
    expect(other.banner.counting()).toBe(true);
    await other.banner.keep();
    expect(other.keep).toHaveBeenCalledWith('e9');
    expect(keep).toHaveBeenCalledWith('e1');
  });

  it('stops counting while no engine runs: the timeout asks nothing, and a press that fails starts no countdown either', async () => {
    const { banner, revert, keep, last } = setup();
    void banner.applied({ entryId: 'e1', change: CHANGE });
    banner.coreEnded();
    await vi.advanceTimersByTimeAsync(KEEP_CHANGES_MS * 10);
    expect(revert).not.toHaveBeenCalled();
    expect(last()).toMatchObject({ phase: 'counting', endsAt: 1_000_000 + KEEP_CHANGES_MS });
    keep.mockRejectedValueOnce(new Error('The Damocles engine is not running'));
    await expect(banner.keep()).rejects.toThrow('not running');
    await vi.advanceTimersByTimeAsync(KEEP_CHANGES_MS * 10);
    expect(revert).not.toHaveBeenCalled();
    expect(banner.counting()).toBe(true);
  });

  it('an engine that starts ends the countdown as the files say, and every waiting call gets that end', async () => {
    for (const stands of ['reverted', 'kept'] as const) {
      const { banner, revert, last } = setup();
      const outcome = banner.applied({ entryId: 'e1', change: CHANGE });
      banner.coreEnded();
      banner.coreStarted(stands);
      expect(await outcome).toBe(stands);
      expect(last()).toMatchObject({ phase: stands });
      expect(revert).not.toHaveBeenCalled();
    }
  });

  describe('who ended the countdown', () => {
    const ended = async (end: (banner: KeepChanges) => unknown, revertUndid = true): Promise<KeepChangesState | undefined> => {
      const { banner, last } = setup(revertUndid);
      void banner.applied({ entryId: 'e1', change: CHANGE });
      await end(banner);
      return last();
    };

    it("says the user for the banner's Revert and its Keep", async () => {
      expect(await ended((banner) => banner.revert())).toMatchObject({ phase: 'reverted', endedBy: 'user' });
      expect(await ended((banner) => banner.keep())).toMatchObject({ phase: 'kept', endedBy: 'user' });
    });

    it('says the timeout when nobody answered', async () => {
      expect(await ended(() => vi.advanceTimersByTimeAsync(KEEP_CHANGES_MS))).toMatchObject({ phase: 'reverted', endedBy: 'timeout' });
    });

    it("says what core's word names: the engine's start, or the user's Undo of the first change", async () => {
      expect(await ended((banner) => banner.settled('e1', 'reverted', 'engineStart'))).toMatchObject({ phase: 'reverted', endedBy: 'engineStart' });
      expect(await ended((banner) => banner.settled('e1', 'kept', 'engineStart'))).toMatchObject({ phase: 'kept', endedBy: 'engineStart' });
      expect(await ended((banner) => banner.settled('e1', 'reverted', 'user'))).toMatchObject({ phase: 'reverted', endedBy: 'user' });
    });

    it('names nobody when another change ended it: a revert that undid nothing, a stale mark, a countdown of another entry', async () => {
      for (const end of [
        (banner: KeepChanges) => banner.revert(),
        (banner: KeepChanges) => banner.settled('e1', 'kept'),
        (banner: KeepChanges) => {
          void banner.applied({ entryId: 'e2', change: CHANGE });
          banner.dispose();
        },
      ]) {
        const { banner, published } = setup(false);
        void banner.applied({ entryId: 'e1', change: CHANGE });
        await end(banner);
        const kept = published.find((state) => state?.phase === 'kept');
        expect(kept).toBeDefined();
        expect(kept).not.toHaveProperty('endedBy');
      }
    });

    it("says the engine's start for a revert main read from the files, unless an answer of its own was on its way when the engine ended", async () => {
      expect(await ended((banner) => {
        banner.coreEnded();
        banner.coreStarted('reverted');
      })).toMatchObject({ phase: 'reverted', endedBy: 'engineStart' });
      const { banner, revert, last } = setup();
      void banner.applied({ entryId: 'e1', change: CHANGE });
      revert.mockRejectedValueOnce(new Error('Damocles Core ended'));
      await banner.revert().catch(() => undefined);
      banner.coreEnded();
      banner.coreStarted('reverted');
      expect(last()).toMatchObject({ phase: 'reverted' });
      expect(last()).not.toHaveProperty('endedBy');
      // a change kept on disk may be a Keep that landed or a revert the start could not make, which the files do not tell apart
      const kept = await ended((started) => {
        started.coreEnded();
        started.coreStarted('kept');
      });
      expect(kept).toMatchObject({ phase: 'kept' });
      expect(kept).not.toHaveProperty('endedBy');
    });
  });

  it('an engine that starts while the mark still stands counts again from the start, and the timeout reverts through it', async () => {
    const { banner, revert, last } = setup();
    const outcome = banner.applied({ entryId: 'e1', change: CHANGE });
    banner.coreEnded();
    await vi.advanceTimersByTimeAsync(60_000);
    banner.coreStarted('marked');
    expect(last()).toMatchObject({ phase: 'counting', endsAt: 1_060_000 + KEEP_CHANGES_MS });
    await vi.advanceTimersByTimeAsync(KEEP_CHANGES_MS);
    expect(revert).toHaveBeenCalledWith('e1');
    expect(await outcome).toBe('reverted');
  });

  it("a call's abort lets go of its wait only; the countdown goes on", async () => {
    const { banner } = setup();
    const stop = new AbortController();
    const waiting = banner.applied({ entryId: 'e1', change: CHANGE }, stop.signal);
    stop.abort(new Error('stopped'));
    await expect(waiting).rejects.toThrow('stopped');
    expect(banner.counting()).toBe(true);
  });

  it('says which answer is on its way to core until core answers, and takes answers again when core refuses it', async () => {
    const { banner, keep, revert, published, last } = setup();
    void banner.applied({ entryId: 'e1', change: CHANGE });
    let refuse!: (err: Error) => void;
    keep.mockImplementationOnce(() => new Promise<undefined>((_resolve, reject) => { refuse = reject; }));
    const pressed = banner.keep();
    const failed = expect(pressed).rejects.toThrow('disk full');
    expect(last()).toMatchObject({ phase: 'counting', ending: 'kept' });
    await banner.revert();
    expect(revert).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    refuse(new Error('disk full'));
    await failed;
    expect(last()).toEqual({ phase: 'counting', endsAt: 1_005_000 + KEEP_CHANGES_MS, durationMs: KEEP_CHANGES_MS, change: CHANGE, changeCount: 1 });

    await vi.advanceTimersByTimeAsync(KEEP_CHANGES_MS);
    expect(published.at(-2)).toMatchObject({ phase: 'counting', ending: 'reverted' });
    expect(last()).toMatchObject({ phase: 'reverted' });
    expect(last()).not.toHaveProperty('ending');
  });

  it('says the engine is not running while none runs, and no longer once one started or the countdown ended', async () => {
    const { banner, keep, last } = setup();
    void banner.applied({ entryId: 'e1', change: CHANGE });
    banner.coreEnded();
    expect(last()).toMatchObject({ phase: 'counting', engineDown: true });
    keep.mockRejectedValueOnce(new Error('The Damocles engine is not running'));
    await expect(banner.keep()).rejects.toThrow('not running');
    expect(last()).toMatchObject({ phase: 'counting', engineDown: true });
    expect(last()).not.toHaveProperty('ending');
    banner.coreStarted('marked');
    expect(last()).not.toHaveProperty('engineDown');

    banner.coreEnded();
    banner.coreStarted('reverted');
    expect(last()).toMatchObject({ phase: 'reverted' });
    expect(last()).not.toHaveProperty('engineDown');
  });
});
