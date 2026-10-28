import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));
import type { Run } from '../../../daemon/control-messages';
import { MAX_OVERLAY_ITEMS, MAX_OVERLAY_LABEL_LENGTH, type CloseRemoteRow } from '../../../preload/overlay-channels';
import { parseCloseRemoteRequest } from '../../overlay';
import { askRemoteRuns, CLOSE_REMOTE_STEP_MS, closeRowId, listHostRuns, type CloseRemoteDeps, type CloseWithRunningAgents, type HostRuns } from '../close-remote';
import { runKey, type TokenNote } from '../keep-running-refresh';

// the question, then its answer acted on as a close that passed every question does
async function release(deps: CloseRemoteDeps, unattended: boolean): Promise<boolean> {
  const act = await askRemoteRuns(deps, unattended);
  if (!act) return false;
  await act();
  return true;
}

const run = (id: string, providers: readonly string[] = ['anthropic']): Run => ({ kind: 'chat', id, projectKey: '/srv/app', title: `chat ${id}`, state: 'running', providers });

function deps(options: { hosts?: readonly HostRuns[]; later?: readonly HostRuns[]; setting?: CloseWithRunningAgents; notes?: ReadonlyMap<string, TokenNote> } = {}) {
  const hosts = options.hosts ?? [{ hostId: 'h1', authorityKey: 'ssh+h1', runs: [run('host-1')] }];
  const listed: Array<readonly HostRuns[]> = [hosts, options.later ?? hosts];
  const recorded: Array<readonly HostRuns[]> = [];
  const events: string[] = [];
  const shown: Array<readonly CloseRemoteRow[]> = [];
  let statusListener: ((authorityKey: string, panelId: string, status: CloseRemoteRow['status']) => void) | undefined;
  let hostListener: ((hostId: string) => void) | undefined;
  const linger = new Set<string>(['h1']);
  // the host store's name and color of each host
  const hostStore = new Map<string, { name: string; tone?: 'danger' | 'success' }>([['h1', { name: 'prod-1' }]]);
  const hostFields = (hostId: string) => {
    const host = hostStore.get(hostId) ?? { name: hostId };
    return { hostLabel: host.name, ...(host.tone !== undefined ? { hostTone: host.tone } : {}), ...(linger.has(hostId) ? { lingerWarning: true as const } : {}) };
  };
  let rowsListener: ((rows: readonly CloseRemoteRow[]) => void) | undefined;
  let answer!: (value: { choice: 'keep' | 'stop' | 'cancel'; dontAskAgain: boolean }) => void;
  const value: CloseRemoteDeps = {
    // the first listing opens the question, the next one is the detach's
    hostRuns: async () => listed.shift() ?? hosts,
    setting: () => options.setting ?? 'ask',
    saveSetting: async (choice) => {
      events.push(`save ${choice}`);
    },
    row: (host, chat) => ({ hostId: host.hostId, panelId: closeRowId(host.hostId, chat.id), title: chat.title, projectLabel: 'app', status: 'running', ...hostFields(host.hostId) }),
    onHostChanged: (listener) => {
      hostListener = listener;
      return { dispose: () => { hostListener = undefined; } };
    },
    hostFields,
    ask: (rows, onRows) => {
      events.push('ask');
      shown.push(rows);
      onRows((next) => {
        rowsListener?.(next);
        shown.push(next);
      });
      return new Promise((resolve) => (answer = resolve));
    },
    onStatus: (listener) => {
      statusListener = listener;
      return { dispose: () => { statusListener = undefined; } };
    },
    startRefresh: (runs) => {
      events.push(`refresh ${runs.map((entry) => entry.panelId).join(',')}`);
      return { notes: Promise.resolve(options.notes ?? new Map()), push: async (pushHosts) => { events.push(`push ${pushHosts.map((host) => host.hostId).join(',')}`); } };
    },
    keepAtShutdown: async (runs, pushHosts) => {
      events.push(`keep unattended ${runs.length} ${pushHosts.map((host) => host.hostId).join(',')}`);
    },
    pushTo: (host) => ({ hostId: host.hostId, push: async () => undefined }),
    stop: async (authorityKey, panelId) => {
      events.push(`stop ${authorityKey} ${panelId}`);
    },
    leftRunning: async (left) => {
      recorded.push(left);
      events.push(`away ${left.map((host) => host.hostId).join(',')}`);
    },
    log: () => undefined,
  };
  const lingerEnabled = (hostId: string): void => {
    linger.delete(hostId);
    hostListener?.(hostId);
  };
  const recolor = (hostId: string, name: string, tone: 'danger' | 'success'): void => {
    hostStore.set(hostId, { name, tone });
    hostListener?.(hostId);
  };
  return { value, events, shown, recorded, lingerEnabled, recolor, status: (...args: Parameters<NonNullable<typeof statusListener>>) => statusListener?.(...args), answer: (next: { choice: 'keep' | 'stop' | 'cancel'; dontAskAgain: boolean }) => answer(next), rows: () => rowsListener };
}

describe('the close\'s remote question', () => {
  it('asks nothing while no connected host runs an agent', async () => {
    const { value, events } = deps({ hosts: [{ hostId: 'h1', authorityKey: 'ssh+h1', runs: [] }] });
    expect(await release(value, false)).toBe(true);
    expect(events).toEqual([]);
  });

  it('keeps the runs: refreshes exactly the reported runs as it asks, pushes on Keep running and records them for the catch-up', async () => {
    const { value, events, answer } = deps();
    const released = release(value, false);
    await vi.waitFor(() => expect(events).toContain('ask'));
    answer({ choice: 'keep', dontAskAgain: false });
    expect(await released).toBe(true);
    expect(events).toEqual(['refresh host-1', 'ask', 'push h1', 'away h1']);
  });

  it('records for the catch-up only the runs still running when Keep running detaches, not one that finished while it asked', async () => {
    const { value, events, recorded, answer } = deps({
      hosts: [{ hostId: 'h1', authorityKey: 'ssh+h1', runs: [run('alpha'), run('charlie')] }],
      later: [{ hostId: 'h1', authorityKey: 'ssh+h1', runs: [run('alpha')] }],
    });
    const released = release(value, false);
    await vi.waitFor(() => expect(events).toContain('ask'));
    answer({ choice: 'keep', dontAskAgain: false });
    await released;
    expect(recorded.map((hosts) => hosts.flatMap((host) => host.runs.map((entry) => entry.id)))).toEqual([['alpha']]);
  });

  it('shows live status and a failed refresh\'s token note on the open dialog\'s rows', async () => {
    const { value, shown, status, answer } = deps({ notes: new Map([[runKey('h1', 'host-1'), { provider: 'anthropic', minutesLeft: 23 }]]) });
    const released = release(value, false);
    await vi.waitFor(() => expect(shown.at(-1)?.[0]?.tokenNote).toEqual({ provider: 'anthropic', minutesLeft: 23 }));
    status('ssh+h1', 'host-1', 'signIn');
    expect(shown.at(-1)?.[0]).toMatchObject({ panelId: 'h1/host-1', status: 'signIn', tokenNote: { provider: 'anthropic', minutesLeft: 23 } });
    answer({ choice: 'cancel', dontAskAgain: false });
    expect(await released).toBe(false);
  });

  it('drops a host\'s logout warning from its rows once Allow background work enabled linger there', async () => {
    const { value, shown, lingerEnabled, answer } = deps();
    const released = release(value, false);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0]?.[0]?.lingerWarning).toBe(true);
    lingerEnabled('h1');
    expect(shown.at(-1)?.[0]).not.toHaveProperty('lingerWarning');
    answer({ choice: 'cancel', dontAskAgain: false });
    await released;
  });

  it('shows a host renamed or recolored while the dialog is open with its new name and color at once', async () => {
    const { value, shown, recolor, answer } = deps();
    const released = release(value, false);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0]?.[0]).toMatchObject({ hostLabel: 'prod-1' });
    expect(shown[0]?.[0]).not.toHaveProperty('hostTone');
    recolor('h1', 'PROD', 'danger');
    expect(shown.at(-1)?.[0]).toMatchObject({ hostLabel: 'PROD', hostTone: 'danger', lingerWarning: true });
    const before = shown.length;
    // the same host fields again change nothing
    recolor('h1', 'PROD', 'danger');
    expect(shown).toHaveLength(before);
    answer({ choice: 'cancel', dontAskAgain: false });
    await released;
  });

  it('stops every run through its Stop path on Stop agents, and saves Don\'t ask again', async () => {
    const { value, events, answer } = deps({ hosts: [{ hostId: 'h1', authorityKey: 'ssh+h1', runs: [run('host-1'), run('host-2')] }] });
    const released = release(value, false);
    await vi.waitFor(() => expect(events).toContain('ask'));
    answer({ choice: 'stop', dontAskAgain: true });
    expect(await released).toBe(true);
    expect(events.slice(1)).toEqual(['ask', 'save stop', 'stop ssh+h1 host-1', 'stop ssh+h1 host-2']);
  });

  it('applies a saved keep or stop with no question', async () => {
    const keep = deps({ setting: 'keep' });
    expect(await release(keep.value, false)).toBe(true);
    expect(keep.events).toEqual(['refresh host-1', 'push h1', 'away h1']);
    const stop = deps({ setting: 'stop' });
    expect(await release(stop.value, false)).toBe(true);
    expect(stop.events).toEqual(['stop ssh+h1 host-1']);
  });

  it('keeps the runs with no question on an OS shutdown or an update\'s quit, whatever the setting', async () => {
    const { value, events } = deps({ setting: 'stop' });
    expect(await release(value, true)).toBe(true);
    expect(events).toEqual(['keep unattended 1 h1', 'away h1']);
  });
});

describe('the close\'s remote question, bounded and deferred', () => {
  it('acts on the answer only when the close calls back, so a later Cancel leaves the agents as they were', async () => {
    const { value, events, answer } = deps({ setting: 'ask' });
    const asked = askRemoteRuns(value, false);
    await vi.waitFor(() => expect(events).toContain('ask'));
    answer({ choice: 'stop', dontAskAgain: false });
    const act = await asked;
    expect(events).toEqual(['refresh host-1', 'ask']);
    await act!();
    expect(events).toEqual(['refresh host-1', 'ask', 'stop ssh+h1 host-1']);
  });

  it('leaves out a host whose run list does not come within the bound, and lists the others', async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const listed = listHostRuns([
        { hostId: 'h1', authorityKey: 'ssh+h1', list: () => new Promise(() => undefined) },
        { hostId: 'h2', authorityKey: 'ssh+h2', list: async () => [run('host-2'), { ...run('term-1'), kind: 'terminal' }] },
      ], (line) => lines.push(line));
      let hosts: readonly HostRuns[] | undefined;
      void listed.then((value) => { hosts = value; });
      await vi.advanceTimersByTimeAsync(CLOSE_REMOTE_STEP_MS - 1);
      expect(hosts).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(hosts).toEqual([{ hostId: 'h2', authorityKey: 'ssh+h2', runs: [run('host-2')] }]);
      expect(lines).toEqual([`[close] ssh+h1 did not list its runs: ssh+h1's run list did not answer within ${CLOSE_REMOTE_STEP_MS} ms`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('goes on past a Stop that does not answer within the bound', async () => {
    vi.useFakeTimers();
    try {
      const { value } = deps({ setting: 'stop' });
      const act = await askRemoteRuns({ ...value, stop: () => new Promise(() => undefined) }, false);
      let done = false;
      void act!().then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(CLOSE_REMOTE_STEP_MS);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a title past the overlay\'s label bound cut with an ellipsis, and at most the overlay\'s rows', async () => {
    const runs = Array.from({ length: MAX_OVERLAY_ITEMS + 5 }, (_unused, index) => ({ ...run(`host-${index}`), title: 'x'.repeat(MAX_OVERLAY_LABEL_LENGTH + 50) }));
    const { value, shown, answer } = deps({ hosts: [{ hostId: 'h1', authorityKey: 'ssh+h1', runs }] });
    const released = release(value, false);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0]).toHaveLength(MAX_OVERLAY_ITEMS);
    expect(shown[0]![0]!.title).toBe(`${'x'.repeat(MAX_OVERLAY_LABEL_LENGTH - 1)}…`);
    expect(parseCloseRemoteRequest(shown[0])).toBeDefined();
    answer({ choice: 'cancel', dontAskAgain: false });
    expect(await released).toBe(false);
  });
});
