import { describe, expect, it } from 'vitest';
import { CloseRelease } from '../close-release';

function harness(answers: { terminals?: boolean[]; editors?: boolean[]; remote?: Array<'act' | 'cancel'> } = {}) {
  const events: string[] = [];
  const asked: boolean[] = [];
  const release = new CloseRelease({
    remote: async (unattended) => {
      asked.push(unattended);
      events.push('remote asked');
      if ((answers.remote?.shift() ?? 'act') === 'cancel') return undefined;
      return async () => {
        events.push('remote acted');
      };
    },
    terminals: async () => {
      events.push('terminals asked');
      return answers.terminals?.shift() ?? true;
    },
    editors: async () => {
      events.push('editors asked');
      return answers.editors?.shift() ?? true;
    },
  });
  return { release, events, asked };
}

describe('a close\'s questions', () => {
  it('asks remote agents, terminals, then editors, and acts on the remote answer only once all passed', async () => {
    const { release, events } = harness();
    expect(await release.release()).toBe(true);
    expect(events).toEqual(['remote asked', 'terminals asked', 'editors asked', 'remote acted']);
  });

  it('leaves the agents untouched when the editors\' question is cancelled, and asks again next time', async () => {
    const { release, events } = harness({ editors: [false, true] });
    expect(await release.release()).toBe(false);
    expect(events).not.toContain('remote acted');
    expect(release.terminalsAgreed).toBe(false);
    events.length = 0;
    expect(await release.release()).toBe(true);
    expect(events).toEqual(['remote asked', 'terminals asked', 'editors asked', 'remote acted']);
  });

  it('asks nothing twice within one close: the window\'s own close event passes at once', async () => {
    const { release, events } = harness();
    await release.release();
    events.length = 0;
    expect(await release.release()).toBe(true);
    expect(events).toEqual(['editors asked']);
  });

  // macOS keeps the app after a window close; the next quit must ask about the agents again
  it('asks the remote question again after a window opened again', async () => {
    const { release, events } = harness();
    await release.release();
    release.windowOpened();
    events.length = 0;
    await release.release();
    expect(events).toEqual(['remote asked', 'terminals asked', 'editors asked', 'remote acted']);
  });

  it('keeps the runs unasked for an OS shutdown or an update\'s quit only until that quit is cancelled', async () => {
    const { release, asked } = harness({ editors: [false, true] });
    release.keepRunsWithoutAsking();
    expect(await release.release()).toBe(false);
    expect(await release.release()).toBe(true);
    expect(asked).toEqual([true, false]);
  });

  it('ends at the remote question\'s Cancel, asking nothing more', async () => {
    const { release, events } = harness({ remote: ['cancel'] });
    expect(await release.release()).toBe(false);
    expect(events).toEqual(['remote asked']);
  });
});
