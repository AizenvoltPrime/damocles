// What a chat's composer can hold as a pending attachment: terminal output or a commit the Graph attached (desktop only), or
// an MCP resource the MCP panel attached (both hosts). All travel one path: core holds them, sends them as data blocks
// before the typed text, and the webview shows chips.
import type { TerminalAttachmentInfo, TerminalAttachmentInput } from './terminal-attachment';

/** A commit as core read it: bounded, its start kept, and every control or bidi character but tab escaped (visibleLines). */
export interface CommitAttachmentInput {
  readonly kind: 'commit';
  // full object name
  readonly hash: string;
  // git's %s, escaped (visibleText) and cut at MAX_COMMIT_LABEL_CHARS
  readonly subject: string;
  readonly author: string;
  // ms since the epoch
  readonly authorDate: number;
  // the header, the message, the stat and the patch against the first parent, or the empty tree for a root commit
  readonly text: string;
  // lines cut from the end; 0 when the text is whole
  readonly omittedLines: number;
  // omittedLines is a floor: git printed more than the reader counted
  readonly omittedAtLeast?: true;
}

export interface CommitAttachmentInfo {
  readonly id: string;
  readonly kind: 'commit';
  readonly hash: string;
  readonly subject: string;
  readonly author: string;
  readonly authorDate: number;
  readonly lineCount: number;
  readonly omittedLines: number;
  readonly omittedAtLeast?: true;
  // the first COMMIT_ATTACHMENT_PREVIEW_LINES lines, at most COMMIT_ATTACHMENT_PREVIEW_CHARS characters
  readonly preview: string;
}

/** An MCP resource by reference: core reads it when the message is sent, so its content never waits in the composer. */
export interface McpResourceAttachmentInput {
  readonly kind: 'mcpResource';
  // the server and URI exactly as the server listed them, which the deny rules match
  readonly server: string;
  readonly uri: string;
  // server text flattened to one line (oneLine) and cut at MAX_MCP_RESOURCE_LABEL_CHARS
  readonly name: string;
  readonly mimeType?: string;
  // the serving manager's identity at attach (`McpResourceServer.serverId`); the read at send refuses another server
  readonly serverId: string;
}

/** A resource attachment as its prompt block records it, which keeps no server identity. */
export type McpResourceReference = Omit<McpResourceAttachmentInput, 'serverId'>;

export interface McpResourceAttachmentInfo {
  readonly id: string;
  readonly kind: 'mcpResource';
  readonly server: string;
  readonly uri: string;
  readonly name: string;
  readonly mimeType?: string;
}

export type ChatAttachmentInput = TerminalAttachmentInput | CommitAttachmentInput | McpResourceAttachmentInput;
export type ChatAttachmentInfo = TerminalAttachmentInfo | CommitAttachmentInfo | McpResourceAttachmentInfo;

export const MAX_MCP_RESOURCE_LABEL_CHARS = 200;

// The terminal attachment's bounds (MAX_TERMINAL_ATTACHMENT_LINES and _CHARS); a commit keeps its start.
export const MAX_COMMIT_ATTACHMENT_LINES = 2000;
export const MAX_COMMIT_ATTACHMENT_CHARS = 64_000;
export const MAX_COMMIT_LABEL_CHARS = 200;
export const COMMIT_ATTACHMENT_PREVIEW_LINES = 40;
export const COMMIT_ATTACHMENT_PREVIEW_CHARS = 4000;
