// Reads a chat tab's conversation title and busy state off the host messages core already sends that tab, so core needs no desktop-only message.

interface StoredSessionLike {
  readonly id?: unknown;
  readonly customTitle?: unknown;
  readonly aiTitle?: unknown;
  readonly preview?: unknown;
}

type HostMessage = { readonly type?: unknown } & Record<string, unknown>;

// A tab label, not the conversation: long previews are cut here so ShellState stays small.
export const MAX_TAB_TITLE_CHARS = 120;

function displayName(session: StoredSessionLike): string | undefined {
  for (const candidate of [session.customTitle, session.aiTitle, session.preview]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return undefined;
}

function clip(title: string): string {
  const single = title.replace(/\s+/g, ' ');
  return single.length > MAX_TAB_TITLE_CHARS ? `${single.slice(0, MAX_TAB_TITLE_CHARS - 1)}…` : single;
}

export class ChatTabTitle {
  private sessionId: string | undefined;
  private name: string | undefined;
  private running = false;

  // sessionName is what the webview persisted for a resumed conversation that may be past the first page of the session list.
  constructor(restored?: { readonly sessionId?: string; readonly sessionName?: string }) {
    this.sessionId = restored?.sessionId;
    this.name = restored?.sessionName;
  }

  get title(): string {
    return this.name === undefined ? '' : clip(this.name);
  }

  get busy(): boolean {
    return this.running;
  }

  // Returns true when the title or busy state changed.
  observe(raw: unknown): boolean {
    if (typeof raw !== 'object' || raw === null) return false;
    const message = raw as HostMessage;
    const before = `${this.title}\u0000${this.running}`;
    switch (message.type) {
      case 'sessionStarted':
      case 'resumeAccepted':
        if (typeof message['sessionId'] === 'string' && message['sessionId'] !== this.sessionId) {
          this.sessionId = message['sessionId'];
          this.name = undefined;
        }
        break;
      case 'storedSessions': {
        const sessions = message['sessions'];
        if (this.sessionId === undefined || !Array.isArray(sessions)) break;
        const own = (sessions as StoredSessionLike[]).find((session) => session.id === this.sessionId);
        const name = own ? displayName(own) : undefined;
        if (name !== undefined) this.name = name;
        break;
      }
      case 'sessionRenamed':
        if (message['sessionId'] === this.sessionId && typeof message['newName'] === 'string') this.name = message['newName'];
        break;
      case 'sessionCleared':
      case 'conversationCleared':
        this.sessionId = undefined;
        this.name = undefined;
        break;
      case 'workspaceFolderUpdate':
        if (message['switched'] === true) {
          this.sessionId = undefined;
          this.name = undefined;
        }
        break;
      case 'sessionStateChanged':
        this.running = message['state'] === 'running' || message['state'] === 'requires_action';
        break;
      default:
        return false;
    }
    return `${this.title}\u0000${this.running}` !== before;
  }
}
