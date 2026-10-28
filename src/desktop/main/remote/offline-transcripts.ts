import type { RemoteChatRecord } from './remote-state';

// A chat view as the transcripts need it.
export interface TranscriptView {
  readonly isDisposed: boolean;
  close(): void;
  onDispose(listener: () => void): unknown;
}

export interface OfflineTranscriptsDeps<V extends TranscriptView> {
  // the mirrored session file of the chat's session, with the project it belongs to; undefined when the mirror lacks it
  readonly mirrored: (authority: string, sessionId: string) => Promise<{ readonly projectKey: string; readonly file: string } | undefined>;
  // whether the authority is connected now; a connected one shows its live chats instead
  readonly connected: (authority: string) => boolean;
  // a read-only view of the chat; panelToken: the saved chat's, whose held messages it shows
  readonly create: (authority: string, sessionId: string, projectKey: string, panelToken: string | undefined) => V;
  // this computer's core shows the file on the view
  readonly load: (view: V, authority: string, file: string) => Promise<void>;
  readonly selected: () => V | undefined;
  // what a mirrored file holds now (its size and modification time), so a sync that changed it is told apart
  readonly version: (file: string) => Promise<string | undefined>;
  // the page replays the file again (core's transcript view replays on each ready)
  readonly reload: (view: V) => void;
  // no chat of the selected project shows, so the saved selection's transcript may take the chat view
  readonly chatViewFree: () => boolean;
  readonly select: (view: V) => void;
}

/**
 * The read-only transcripts of remote chats whose host is not connected: one view per saved chat a launch could not reopen
 * whose session the mirror holds, the saved selection's shown, and one per chat opened from the offline chat list. The host's
 * connect closes them all, and a selected saved chat names the live chat to select once it reopens.
 */
export class OfflineTranscripts<V extends TranscriptView> {
  private readonly deps: OfflineTranscriptsDeps<V>;
  // panelToken: the saved chat's page token, absent for a chat opened from the list
  private readonly views = new Map<V, { readonly authority: string; readonly sessionId: string; readonly file: string; version: string | undefined; readonly panelToken?: string }>();

  constructor(deps: OfflineTranscriptsDeps<V>) {
    this.deps = deps;
  }

  /** Opens the authority's saved chats as transcripts while it stays offline; selectedSession: the launch's saved selection. */
  async open(authority: string, records: readonly RemoteChatRecord[], selectedSession: string | undefined): Promise<void> {
    for (const record of records) {
      if (this.deps.connected(authority)) return;
      // a new chat has no transcript: its held messages wait for the host
      if (record.sessionId === undefined) continue;
      const view = await this.show(authority, record.sessionId, record.panelToken);
      if (view === 'connected') return;
      if (view && selectedSession === record.sessionId && this.deps.chatViewFree()) this.deps.select(view);
    }
  }

  /** Opens one chat of the offline chat list as its transcript; undefined when the mirror lacks it or the host connected. */
  async openChat(authority: string, sessionId: string): Promise<V | undefined> {
    if (this.deps.connected(authority)) return undefined;
    const view = await this.show(authority, sessionId, undefined);
    return view === 'connected' ? undefined : view;
  }

  /**
   * The authority's mirror synced while it stays unconnected (a daemon of another protocol runs its chats): saved chats the
   * mirror now holds open, and each transcript whose file changed replays it again, so the running chats read live.
   */
  async synced(authority: string, records: readonly RemoteChatRecord[], selectedSession: string | undefined): Promise<{ readonly opened: number; readonly reloaded: number }> {
    const shown = new Set([...this.views.values()].filter((transcript) => transcript.authority === authority).map((transcript) => transcript.sessionId));
    let opened = 0;
    let reloaded = 0;
    for (const record of records) {
      if (this.deps.connected(authority)) return { opened, reloaded };
      if (record.sessionId === undefined || shown.has(record.sessionId)) continue;
      const view = await this.show(authority, record.sessionId, record.panelToken);
      if (view === 'connected') return { opened, reloaded };
      if (!view) continue;
      opened++;
      if (selectedSession === record.sessionId && this.deps.chatViewFree()) this.deps.select(view);
    }
    for (const [view, transcript] of [...this.views]) {
      if (transcript.authority !== authority || view.isDisposed) continue;
      const version = await this.deps.version(transcript.file);
      if (version === transcript.version) continue;
      transcript.version = version;
      this.deps.reload(view);
      reloaded++;
    }
    return { opened, reloaded };
  }

  /** The authority connected: its transcripts close; resolves the page token of the live chat to select, if one was selected. */
  hostConnected(authority: string): string | undefined {
    let reselect: string | undefined;
    for (const [view, transcript] of [...this.views]) {
      if (transcript.authority !== authority) continue;
      if (this.deps.selected() === view) reselect = transcript.panelToken;
      this.views.delete(view);
      view.close();
    }
    return reselect;
  }

  has(view: V): boolean {
    return this.views.has(view);
  }

  // 'connected': the host connected meanwhile, which closed what opened
  private async show(authority: string, sessionId: string, panelToken: string | undefined): Promise<V | undefined | 'connected'> {
    const mirrored = await this.deps.mirrored(authority, sessionId);
    if (!mirrored || this.deps.connected(authority)) return undefined;
    const version = await this.deps.version(mirrored.file);
    const view = this.deps.create(authority, sessionId, mirrored.projectKey, panelToken);
    try {
      await this.deps.load(view, authority, mirrored.file);
    } catch (err) {
      // a view that never showed its file is tracked by no one, so no host connect would close it
      view.close();
      throw err;
    }
    if (view.isDisposed) return undefined;
    this.views.set(view, { authority, sessionId, file: mirrored.file, version, ...(panelToken !== undefined ? { panelToken } : {}) });
    view.onDispose(() => this.views.delete(view));
    // a host that connected while this one opened replaces it at once
    if (this.deps.connected(authority)) {
      this.hostConnected(authority);
      return 'connected';
    }
    return view;
  }
}
