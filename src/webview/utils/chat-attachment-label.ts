import type { ChatAttachmentInfo, CommitAttachmentInfo, McpResourceAttachmentInfo } from "@shared/types/chat-attachment";
import { terminalAttachmentLabel } from "./terminal-attachment-label";

type Translate = (key: string, values?: Record<string, unknown>) => string;

// git's short hash length, as the Graph shows it.
const SHORT_HASH = 7;

export const shortHash = (hash: string): string => hash.slice(0, SHORT_HASH);

/** A commit chip's whole label, "Commit 1a2b3c4 · Subject", as screen readers and the chip's title read it. */
export function commitAttachmentLabel(attachment: CommitAttachmentInfo, t: Translate): string {
  return t("commitAttachment.label", { hash: shortHash(attachment.hash), subject: attachment.subject });
}

/** An MCP resource chip's whole label, "Name · server". */
export function mcpResourceAttachmentLabel(attachment: McpResourceAttachmentInfo, t: Translate): string {
  return t("mcp.resourceChip.label", { name: attachment.name, serverName: attachment.server });
}

export function chatAttachmentLabel(attachment: ChatAttachmentInfo, t: Translate): string {
  if (attachment.kind === "mcpResource") return mcpResourceAttachmentLabel(attachment, t);
  return attachment.kind === "commit" ? commitAttachmentLabel(attachment, t) : terminalAttachmentLabel(attachment, t);
}
