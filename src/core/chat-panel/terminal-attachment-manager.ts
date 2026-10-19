import { randomUUID } from "crypto";
import type { ChatAttachmentInfo, ChatAttachmentInput } from "@shared/types/chat-attachment";
import { attachmentInfo } from "../terminal-attachment";

// Pending attachments one composer holds; adding one more drops the oldest.
export const MAX_PENDING_TERMINAL_ATTACHMENTS = 8;
// Characters of text (terminal output and commits) one composer's pending attachments hold in total; an add past it is refused.
// The text of attached MCP resources, read at send, counts against it then.
// It counts text before neutralization and without block framing or attributes, so a sent prompt carries somewhat more.
export const MAX_PENDING_TERMINAL_ATTACHMENT_CHARS = 128_000;

interface PendingAttachment {
  readonly id: string;
  readonly attachment: ChatAttachmentInput;
  readonly info: ChatAttachmentInfo;
}

export interface TakenAttachment {
  readonly attachment: ChatAttachmentInput;
  readonly info: ChatAttachmentInfo;
}

/** The text an attachment holds while pending; an MCP resource holds none until it is read at send. */
export const heldChars = (attachment: ChatAttachmentInput): number => (attachment.kind === "mcpResource" ? 0 : attachment.text.length);

const pendingChars = (entries: readonly PendingAttachment[]): number => entries.reduce((total, entry) => total + heldChars(entry.attachment), 0);

/** A panel's pending attachments, terminal output, commits and MCP resources: the host or the MCP panel adds them, the composer removes them or sends them with a message. */
export class TerminalAttachmentManager {
  private pending: PendingAttachment[] = [];
  // added: the change is an attachment the user just added, whose composer then takes focus
  private readonly onChange: (attachments: ChatAttachmentInfo[], added: boolean) => void;

  constructor(onChange: (attachments: ChatAttachmentInfo[], added: boolean) => void) {
    this.onChange = onChange;
  }

  /** False, changing nothing, when the pending text would pass MAX_PENDING_TERMINAL_ATTACHMENT_CHARS. */
  add(attachment: ChatAttachmentInput): boolean {
    const id = randomUUID();
    const next = [...this.pending, { id, attachment, info: attachmentInfo(id, attachment) }].slice(-MAX_PENDING_TERMINAL_ATTACHMENTS);
    if (pendingChars(next) > MAX_PENDING_TERMINAL_ATTACHMENT_CHARS) return false;
    this.pending = next;
    this.publish(true);
    return true;
  }

  remove(id: string): void {
    const next = this.pending.filter((entry) => entry.id !== id);
    if (next.length === this.pending.length) return;
    this.pending = next;
    this.publish();
  }

  /** Removes and returns the named pending attachments in the order they were added; an unknown id names nothing. */
  take(ids: readonly string[]): TakenAttachment[] {
    const wanted = new Set(ids);
    const taken = this.pending.filter((entry) => wanted.has(entry.id));
    if (taken.length === 0) return [];
    this.pending = this.pending.filter((entry) => !wanted.has(entry.id));
    this.publish();
    return taken.map(({ attachment, info }) => ({ attachment, info }));
  }

  /**
   * Puts back attachments a send took but never delivered, in their order and ahead of any added since. They fit both
   * bounds when taken, so past either bound the ones added since go, newest first. Returns how many went.
   */
  restore(taken: readonly TakenAttachment[]): number {
    if (taken.length === 0) return 0;
    const restored = taken.map(({ attachment, info }) => ({ id: info.id, attachment, info }));
    let added = this.pending;
    const fits = (): boolean =>
      restored.length + added.length <= MAX_PENDING_TERMINAL_ATTACHMENTS && pendingChars([...restored, ...added]) <= MAX_PENDING_TERMINAL_ATTACHMENT_CHARS;
    while (added.length > 0 && !fits()) added = added.slice(0, -1);
    const dropped = this.pending.length - added.length;
    this.pending = [...restored, ...added];
    this.publish();
    return dropped;
  }

  displayInfo(): ChatAttachmentInfo[] {
    return this.pending.map((entry) => entry.info);
  }

  private publish(added = false): void {
    this.onChange(this.displayInfo(), added);
  }
}
