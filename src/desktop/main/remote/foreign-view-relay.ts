// A remote chat's voice, its user-setting writes and its browser on this computer go through a foreign view proxy on the
// local core. The view's VOICE_VIEW_MESSAGES go to the local core's voice service and its REMOTE_CHAT_USER_SETTING_MESSAGES
// to that core's user settings; the proxy's VOICE_VIEW_POSTS and FOREIGN_SETTING_POSTS come back to it. The proxy owns the
// chat's browser pages.
// Every check reads main's own views, never an authority or view id a core named.
import {
  FOREIGN_SETTING_POSTS,
  FOREIGN_VIEW_NOT_ATTACHED,
  isRemoteChatSettingMessage,
  REMOTE_CHAT_SETTING_FAILURES,
  remoteChatSettingKey,
  VOICE_VIEW_MESSAGES,
  VOICE_VIEW_POSTS,
  type RemoteChatSettingMessage,
} from '../../../shared/remote-user';
import type { LocalizedText } from '../../../shared/localized-text';
import { l } from '../../../core/l10n';
import { CoreNotRunningError } from '../core-host';

// a daemon whose core re-applies a chat's tools when the client's user layer changes a Tools switch's key
const TOOLS_SET_ON_HOST_FEATURE = 'tools.setOnHost';

/** A loaded remote chat view as main holds it. */
export interface RemoteChatView {
  readonly authority: string;
  // set on a mirrored transcript, which has no agent and no Tools state
  readonly offline: object | undefined;
  postJson(type: string, json: string): void;
}

/** The local core's foreign view requests, on the running local core. */
export interface ForeignCore {
  attachForeign(authority: string, viewId: string): Promise<void>;
  detachForeign(viewId: string): Promise<void>;
  foreignMessage(viewId: string, message: unknown): Promise<void>;
  speak(viewId: string, text: string): Promise<void>;
}

export interface ForeignViewRelayDeps {
  // the live chat view of that id, undefined once it closed or for any other view
  readonly chatView: (viewId: string) => RemoteChatView | undefined;
  // a core of that authority is attached and serving
  readonly attached: (authority: string) => boolean;
  // the features the authority's connection lists, undefined while it has none
  readonly connectionFeatures: (authority: string) => readonly string[] | undefined;
  readonly hostName: (authority: string) => string;
  readonly local: ForeignCore;
  readonly log: (line: string) => void;
}

interface AttachedView {
  readonly authority: string;
  // each view's messages go in order
  queue: Promise<void>;
}

function typeOf(message: unknown): string | undefined {
  const type = (message as { readonly type?: unknown } | null)?.type;
  return typeof message === 'object' && message !== null && typeof type === 'string' ? type : undefined;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isNotAttached = (err: unknown): boolean => err instanceof Error && err.message === FOREIGN_VIEW_NOT_ATTACHED;

export class ForeignViewRelay {
  private readonly deps: ForeignViewRelayDeps;
  // remote chat view id -> its authority, for each proxy the local core holds
  private readonly attachedViews = new Map<string, AttachedView>();
  // remote chat view id -> its setting writes the local core has not answered yet
  private readonly pendingWrites = new Map<string, number>();
  // authority -> the features its last connection in this run listed, kept while it is away
  private readonly hostFeatures = new Map<string, readonly string[]>();

  constructor(deps: ForeignViewRelayDeps) {
    this.deps = deps;
  }

  /** A connection to the authority was made: what its daemon supports from now on, also once it is away. */
  hostConnected(authority: string, features: readonly string[]): void {
    this.hostFeatures.set(authority, features);
  }

  /**
   * A chat page's message: true when it is a remote chat's voice or user-setting message, which goes to the local core and
   * never to its own. A setting write lands on this computer, so it goes whether or not the chat's core is attached.
   */
  fromView(viewId: string, message: unknown): boolean {
    const view = this.deps.chatView(viewId);
    const type = typeOf(message);
    if (!view || view.authority === 'local' || type === undefined) return false;
    if (isRemoteChatSettingMessage(type)) {
      this.settingWrite(viewId, view, type, message);
      return true;
    }
    if (!VOICE_VIEW_MESSAGES.has(type)) return false;
    if (!this.deps.attached(view.authority)) {
      this.deps.log(`[foreign-view] dropped ${type} from a chat on ${view.authority}, whose core is not attached`);
      return true;
    }
    const current = this.entryOf(viewId, view.authority);
    current.queue = current.queue.then(() => this.send(viewId, current, message)).catch((err: unknown) => {
      this.deps.log(`[foreign-view] ${type} from a chat on ${current.authority} failed: ${errorText(err)}`);
    });
    return true;
  }

  private settingWrite(viewId: string, view: RemoteChatView, type: RemoteChatSettingMessage, message: unknown): void {
    if (type !== 'setPinnedHeaderHidden') {
      // a transcript page never shows its Tools switches: it has no Tools status to show them from
      if (view.offline) {
        this.deps.log(`[foreign-view] dropped ${type} from a transcript of a chat on ${view.authority}, which has no tools`);
        return;
      }
      const features = this.deps.connectionFeatures(view.authority) ?? this.hostFeatures.get(view.authority);
      if (!features?.includes(TOOLS_SET_ON_HOST_FEATURE)) {
        const host = this.deps.hostName(view.authority);
        const detail = features ? l('Update Damocles on {0} to change this switch from its chats.', host) : l('{0} is not connected.', host);
        this.deps.log(`[foreign-view] refused ${type} from a chat on ${view.authority}, whose daemon ${features ? `lacks ${TOOLS_SET_ON_HOST_FEATURE}` : 'never connected in this run'}`);
        this.inOrder(viewId, () => this.answerFailed(viewId, type, message, detail));
        return;
      }
    }
    this.deps.log(`[foreign-view] ${type} from a chat on ${view.authority} goes to this computer's core`);
    this.pendingWrites.set(viewId, (this.pendingWrites.get(viewId) ?? 0) + 1);
    const current = this.entryOf(viewId, view.authority);
    current.queue = current.queue
      .then(() => this.send(viewId, current, message))
      .catch((err: unknown) => {
        this.deps.log(`[foreign-view] ${type} from a chat on ${current.authority} failed: ${errorText(err)}`);
        // the local core never answered (it was down, restarting or refused the message), so main does, and the switch reverts
        const detail = err instanceof CoreNotRunningError ? l("This computer's Damocles engine is not running.") : l('An unexpected error occurred. The log has the details.');
        this.answerFailed(viewId, type, message, detail);
      })
      .finally(() => this.writeSettled(viewId));
  }

  // A proxy the local core lost to its restart (the view's entry was taken before localCoreStarted) is attached once more.
  private async send(viewId: string, entry: AttachedView, message: unknown): Promise<void> {
    try {
      await this.deps.local.foreignMessage(viewId, message);
    } catch (err) {
      if (!isNotAttached(err)) throw err;
      this.deps.log(`[foreign-view] the local core holds no proxy for a chat view on ${entry.authority}; attaching it again`);
      if (this.attachedViews.get(viewId) === entry) this.attachedViews.delete(viewId);
      await this.deps.local.attachForeign(entry.authority, viewId);
      if (!this.attachedViews.has(viewId) && this.deps.chatView(viewId)?.authority === entry.authority) this.attachedViews.set(viewId, entry);
      await this.deps.local.foreignMessage(viewId, message);
    }
  }

  // After the writes the view queued earlier, so its results reach the page in the order it sent them.
  private inOrder(viewId: string, answer: () => void): void {
    const known = this.attachedViews.get(viewId);
    if (!known) {
      answer();
      return;
    }
    known.queue = known.queue.catch(() => undefined).then(answer);
  }

  private answerFailed(viewId: string, type: RemoteChatSettingMessage, message: unknown, detail: LocalizedText): void {
    const key = remoteChatSettingKey(type, (message as { readonly group?: unknown }).group);
    const view = this.deps.chatView(viewId);
    if (key === undefined || !view) return;
    const failure = l(REMOTE_CHAT_SETTING_FAILURES[type], detail);
    view.postJson('notification', JSON.stringify({ type: 'notification', message: failure, notificationType: 'error' }));
    view.postJson('settingWriteResult', JSON.stringify({ type: 'settingWriteResult', key, ok: false, error: detail }));
  }

  private writeSettled(viewId: string): void {
    const left = (this.pendingWrites.get(viewId) ?? 1) - 1;
    if (left > 0) this.pendingWrites.set(viewId, left);
    else this.pendingWrites.delete(viewId);
  }

  /**
   * The local core holds a proxy for the live remote chat view once this settles, so its browser pages are that chat's tabs
   * and close with it; the view's close lets go of it.
   */
  async attachView(viewId: string, authority: string): Promise<void> {
    const view = this.deps.chatView(viewId);
    if (!view || view.authority !== authority || authority === 'local') throw new Error('No chat of this host shows that view');
    await this.entryOf(viewId, authority).queue;
  }

  private entryOf(viewId: string, authority: string): AttachedView {
    const known = this.attachedViews.get(viewId);
    if (known && known.authority === authority) return known;
    const attach = this.deps.local.attachForeign(authority, viewId);
    const entry: AttachedView = { authority, queue: attach };
    this.attachedViews.set(viewId, entry);
    // a refused attach is not kept: the view's next message or browser call attaches again
    attach.catch(() => {
      if (this.attachedViews.get(viewId) === entry) this.attachedViews.delete(viewId);
    });
    return entry;
  }

  /**
   * The local core posted to a foreign proxy, delivered only to that live remote chat view, and only while its authority is
   * attached, except a setting write's result and toast while one of the view's writes waits for its answer.
   */
  foreignPost(viewId: string, message: unknown): void {
    const entry = this.attachedViews.get(viewId);
    const view = this.deps.chatView(viewId);
    const type = typeOf(message);
    const live = entry !== undefined && view !== undefined && view.authority === entry.authority;
    const setting = type !== undefined && FOREIGN_SETTING_POSTS.has(type);
    const known = setting || (type !== undefined && VOICE_VIEW_POSTS.has(type));
    const deliver = live && known && (this.deps.attached(view.authority) || (setting && this.pendingWrites.has(viewId)));
    if (!deliver || type === undefined) {
      this.deps.log(`[foreign-view] dropped a ${type?.slice(0, 64) ?? 'malformed'} post for view ${viewId.slice(0, 64)}, which this proxy does not deliver`);
      return;
    }
    view.postJson(type, JSON.stringify(message));
  }

  /** A remote core's spoken reply for one of its chat views: spoken by this computer's core, which reads its own consent. */
  async speak(authority: string, viewId: string, text: string): Promise<void> {
    const view = this.deps.chatView(viewId);
    if (!view || view.authority !== authority) throw new Error('No chat of this host shows that view');
    await this.deps.local.speak(viewId, text);
  }

  /** The view closed: the local core lets go of its proxy once the messages the view queued before it reached that core. */
  viewClosed(viewId: string): void {
    const entry = this.attachedViews.get(viewId);
    if (!entry) return;
    this.attachedViews.delete(viewId);
    entry.queue = entry.queue
      .catch(() => undefined)
      .then(() => this.deps.local.detachForeign(viewId))
      .catch((err: unknown) => this.deps.log(`[foreign-view] detaching a remote chat view failed: ${errorText(err)}`));
  }

  /** A new local core holds no proxy: each view attaches again with its next voice or setting message. */
  localCoreStarted(): void {
    this.attachedViews.clear();
  }
}
