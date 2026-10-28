import { describe, expect, it } from 'vitest';
import { OfflineTranscripts, type TranscriptView } from '../offline-transcripts';
import type { RemoteChatRecord } from '../remote-state';

// a transcript shows a saved chat with a conversation
type SessionRecord = RemoteChatRecord & { readonly sessionId: string };

class View implements TranscriptView {
  isDisposed = false;
  private readonly disposeListeners: Array<() => void> = [];
  readonly record: SessionRecord;
  constructor(record: SessionRecord) {
    this.record = record;
  }
  close(): void {
    this.isDisposed = true;
    for (const listener of this.disposeListeners) listener();
  }
  onDispose(listener: () => void): void {
    this.disposeListeners.push(listener);
  }
}

const record = (sessionId: string): SessionRecord => ({ authority: 'ssh+h1', sessionId, panelToken: `token-${sessionId}` });

function harness(initiallyMirrored: readonly string[], localChatShown = false) {
  const mirroredSessions = [...initiallyMirrored];
  // each mirrored file's size and time as the sync left it
  const versions = new Map<string, string>();
  const reloaded: string[] = [];
  let connected = false;
  let selected: View | undefined = localChatShown ? new View(record('local')) : undefined;
  const opened: View[] = [];
  let load = async (_view: View): Promise<void> => undefined;
  const transcripts = new OfflineTranscripts<View>({
    mirrored: async (_authority, sessionId) => (mirroredSessions.includes(sessionId) ? { projectKey: 'ssh+h1|/srv/app', file: `/m/${sessionId}.jsonl` } : undefined),
    connected: () => connected,
    create: (authority: string, sessionId: string) => {
      const view = new View({ authority, sessionId, panelToken: '' });
      opened.push(view);
      return view;
    },
    load: (view) => load(view),
    selected: () => selected,
    version: async (file) => versions.get(file) ?? 'v0',
    reload: (view) => {
      reloaded.push(view.record.sessionId);
    },
    // the saved remote project is selected while a local chat still shows, or nothing shows
    chatViewFree: () => selected === undefined || selected.record.sessionId === 'local',
    select: (view) => {
      selected = view;
    },
  });
  return {
    transcripts,
    opened,
    reloaded,
    mirror: (sessionId: string, version = 'v0') => {
      if (!mirroredSessions.includes(sessionId)) mirroredSessions.push(sessionId);
      versions.set(`/m/${sessionId}.jsonl`, version);
    },
    connect: () => {
      connected = true;
    },
    selected: () => selected,
    failLoads: (error: Error) => {
      load = async () => { throw error; };
    },
  };
}

describe('OfflineTranscripts', () => {
  it('reads the running chats of a host it cannot attach to live: each sync opens saved chats the mirror now holds and replays changed transcripts', async () => {
    const { transcripts, opened, reloaded, mirror, selected } = harness(['s1']);
    await transcripts.open('ssh+h1', [record('s1'), record('s2')], undefined);
    expect(opened.map((view) => view.record.sessionId)).toEqual(['s1']);
    mirror('s2');
    await transcripts.synced('ssh+h1', [record('s1'), record('s2')], 's2');
    expect(opened.map((view) => view.record.sessionId)).toEqual(['s1', 's2']);
    expect(reloaded).toEqual([]);
    expect(selected()?.record.sessionId).toBe('s2');
    mirror('s1', 'v1');
    await transcripts.synced('ssh+h1', [record('s1'), record('s2')], 's2');
    await transcripts.synced('ssh+h1', [record('s1'), record('s2')], 's2');
    expect(opened).toHaveLength(2);
    expect(reloaded).toEqual(['s1']);
  });

  it('closes a view whose transcript core could not show, which no host connect would close', async () => {
    const { transcripts, opened, failLoads } = harness(['s1']);
    failLoads(new Error('The Damocles engine is stopped'));
    await expect(transcripts.openChat('ssh+h1', 's1')).rejects.toThrow('engine is stopped');
    expect(opened.map((view) => view.isDisposed)).toEqual([true]);
  });

  it('opens a transcript for each saved chat the mirror holds and shows the saved selection', async () => {
    const { transcripts, opened, selected } = harness(['s1', 's2']);
    await transcripts.open('ssh+h1', [record('s1'), record('gone'), record('s2')], 's2');
    expect(opened.map((view) => view.record.sessionId)).toEqual(['s1', 's2']);
    expect(selected()?.record.sessionId).toBe('s2');
  });

  it("takes the chat view from another authority's chat while the saved remote project is selected", async () => {
    const { transcripts, selected } = harness(['s1'], true);
    await transcripts.open('ssh+h1', [record('s1')], 's1');
    expect(selected()?.record.sessionId).toBe('s1');
  });

  it('replaces the read-only views with the live chats once the host connects, reselecting the selected chat', async () => {
    const { transcripts, opened, connect } = harness(['s1', 's2']);
    await transcripts.open('ssh+h1', [record('s1'), record('s2')], 's1');
    connect();
    expect(transcripts.hostConnected('ssh+h2')).toBeUndefined();
    expect(opened.every((view) => !view.isDisposed)).toBe(true);
    expect(transcripts.hostConnected('ssh+h1')).toBe('token-s1');
    expect(opened.every((view) => view.isDisposed)).toBe(true);
    expect(opened.some((view) => transcripts.has(view))).toBe(false);
  });

  it('opens nothing for a host that is connected, and closes a transcript whose host connected while it opened', async () => {
    const connectedAtStart = harness(['s1']);
    connectedAtStart.connect();
    await connectedAtStart.transcripts.open('ssh+h1', [record('s1')], undefined);
    expect(connectedAtStart.opened).toEqual([]);

    const midway = harness(['s1', 's2']);
    const open = midway.transcripts.open('ssh+h1', [record('s1'), record('s2')], undefined);
    midway.connect();
    await open;
    expect(midway.opened.every((view) => view.isDisposed)).toBe(true);
  });

  it('opens a chat of the offline chat list as its transcript, which a connect of its host closes with nothing to reselect', async () => {
    const { transcripts, opened, connect } = harness(['s1']);
    const view = await transcripts.openChat('ssh+h1', 's1');
    expect(view?.record.sessionId).toBe('s1');
    expect(await transcripts.openChat('ssh+h1', 'not-mirrored')).toBeUndefined();
    connect();
    expect(await transcripts.openChat('ssh+h1', 's1')).toBeUndefined();
    expect(transcripts.hostConnected('ssh+h1')).toBeUndefined();
    expect(opened.map((candidate) => candidate.isDisposed)).toEqual([true]);
  });
});
