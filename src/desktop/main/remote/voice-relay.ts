// A remote chat's voice on this computer: the view's VOICE_VIEW_MESSAGES go to the local core's voice service through a
// foreign view proxy, and that proxy's VOICE_VIEW_POSTS come back to the view. Every check reads main's own views, never an
// authority or view id a core named.
import { VOICE_VIEW_MESSAGES, VOICE_VIEW_POSTS } from '../../../shared/remote-user';

/** A loaded remote chat view as main holds it. */
export interface RemoteChatView {
  readonly authority: string;
  postJson(type: string, json: string): void;
}

/** The local core's foreign view requests, on the running local core. */
export interface ForeignCore {
  attachForeign(authority: string, viewId: string): Promise<void>;
  detachForeign(viewId: string): Promise<void>;
  foreignMessage(viewId: string, message: unknown): Promise<void>;
  speak(viewId: string, text: string): Promise<void>;
}

export interface VoiceRelayDeps {
  // the live chat view of that id, undefined once it closed or for any other view
  readonly chatView: (viewId: string) => RemoteChatView | undefined;
  // a core of that authority is attached and serving
  readonly attached: (authority: string) => boolean;
  readonly local: ForeignCore;
  readonly log: (line: string) => void;
}

export function isVoiceViewMessage(message: unknown): message is { readonly type: string } {
  const type = (message as { readonly type?: unknown } | null)?.type;
  return typeof message === 'object' && message !== null && typeof type === 'string' && VOICE_VIEW_MESSAGES.has(type);
}

export class VoiceRelay {
  private readonly deps: VoiceRelayDeps;
  // remote chat view id -> its authority, for each proxy the local core holds; each view's messages go in order
  private readonly attachedViews = new Map<string, { readonly authority: string; queue: Promise<void> }>();

  constructor(deps: VoiceRelayDeps) {
    this.deps = deps;
  }

  /** A chat page's message: true when it is a remote chat's voice message, which goes to the local core and never to its own. */
  fromView(viewId: string, message: unknown): boolean {
    const view = this.deps.chatView(viewId);
    if (!view || view.authority === 'local' || !isVoiceViewMessage(message)) return false;
    if (!this.deps.attached(view.authority)) {
      this.deps.log(`[voice] dropped ${message.type} from a chat on ${view.authority}, whose core is not attached`);
      return true;
    }
    let entry = this.attachedViews.get(viewId);
    if (!entry || entry.authority !== view.authority) {
      const authority = view.authority;
      entry = { authority, queue: this.deps.local.attachForeign(authority, viewId) };
      this.attachedViews.set(viewId, entry);
    }
    const current = entry;
    current.queue = current.queue.then(() => this.deps.local.foreignMessage(viewId, message)).catch((err: unknown) => {
      this.deps.log(`[voice] ${message.type} from a chat on ${current.authority} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  }

  /** The local core posted to a foreign proxy: only voice view state, and only to that live remote chat view of an attached authority. */
  foreignPost(viewId: string, message: unknown): void {
    const entry = this.attachedViews.get(viewId);
    const view = this.deps.chatView(viewId);
    const type = (message as { readonly type?: unknown } | null)?.type;
    if (!entry || !view || view.authority !== entry.authority || !this.deps.attached(view.authority) || typeof type !== 'string' || !VOICE_VIEW_POSTS.has(type)) {
      this.deps.log(`[voice] dropped a post for view ${viewId.slice(0, 64)}, which is no voice post to an attached remote chat view`);
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

  /** The view closed: the local core lets go of its proxy. */
  viewClosed(viewId: string): void {
    if (!this.attachedViews.delete(viewId)) return;
    this.deps.local.detachForeign(viewId).catch((err: unknown) => this.deps.log(`[voice] detaching a remote chat view failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** A new local core holds no proxy: each view attaches again with its next voice message. */
  localCoreStarted(): void {
    this.attachedViews.clear();
  }
}
