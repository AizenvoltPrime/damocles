import { randomUUID } from "crypto";
import type { TerminalAttachmentInfo, TerminalAttachmentInput } from "@shared/types/terminal-attachment";
import { terminalAttachmentInfo } from "../terminal-attachment";

// Pending attachments one composer holds; adding one more drops the oldest.
export const MAX_PENDING_TERMINAL_ATTACHMENTS = 8;
// Characters of terminal text one composer's pending attachments hold in total; an add past it is refused.
export const MAX_PENDING_TERMINAL_ATTACHMENT_CHARS = 128_000;

interface PendingAttachment {
  readonly id: string;
  readonly attachment: TerminalAttachmentInput;
  readonly info: TerminalAttachmentInfo;
}

export interface TakenAttachment {
  readonly attachment: TerminalAttachmentInput;
  readonly info: TerminalAttachmentInfo;
}

const pendingChars = (entries: readonly PendingAttachment[]): number => entries.reduce((total, entry) => total + entry.attachment.text.length, 0);

/** A panel's pending terminal attachments: the host adds them, the composer removes them or sends them with a message. */
export class TerminalAttachmentManager {
  private pending: PendingAttachment[] = [];
  // added: the change is an attachment the user just added, whose composer then takes focus
  private readonly onChange: (attachments: TerminalAttachmentInfo[], added: boolean) => void;

  constructor(onChange: (attachments: TerminalAttachmentInfo[], added: boolean) => void) {
    this.onChange = onChange;
  }

  /** False, changing nothing, when the pending text would pass MAX_PENDING_TERMINAL_ATTACHMENT_CHARS. */
  add(attachment: TerminalAttachmentInput): boolean {
    const id = randomUUID();
    const next = [...this.pending, { id, attachment, info: terminalAttachmentInfo(id, attachment) }].slice(-MAX_PENDING_TERMINAL_ATTACHMENTS);
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

  /** Puts back attachments a send took but never delivered, ahead of any added since; past either bound the oldest go first. */
  restore(taken: readonly TakenAttachment[]): void {
    if (taken.length === 0) return;
    let next = [...taken.map(({ attachment, info }) => ({ id: info.id, attachment, info })), ...this.pending].slice(-MAX_PENDING_TERMINAL_ATTACHMENTS);
    while (pendingChars(next) > MAX_PENDING_TERMINAL_ATTACHMENT_CHARS) next = next.slice(1);
    this.pending = next;
    this.publish();
  }

  displayInfo(): TerminalAttachmentInfo[] {
    return this.pending.map((entry) => entry.info);
  }

  private publish(added = false): void {
    this.onChange(this.displayInfo(), added);
  }
}
