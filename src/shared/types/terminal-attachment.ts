// Terminal output the user attaches to a chat's composer (desktop only). The VS Code host never produces one, and a
// webview that receives none shows none.

export type TerminalAttachmentSource = 'selection' | 'command';

/** What the desktop host hands core. The host has already capped and cleaned the text; core never re-caps it. */
export interface TerminalAttachmentInput {
  readonly source: TerminalAttachmentSource;
  // The command line from the host's own record for source 'command'; null for a selection or an unrecorded command.
  readonly commandLine: string | null;
  // The recorded exit code; null for a selection, a command still running or one the shell reported none for.
  readonly exitCode: number | null;
  // The terminal's computed title, which names a selection's terminal.
  readonly terminalTitle: string;
  // Plain text: no escape sequences, no control characters but \n and \t, only \n line ends, the end of the output kept.
  readonly text: string;
  // Lines the cap dropped from the start; 0 when the text is whole.
  readonly omittedLines: number;
}

/** What the webview shows for an attachment: a composer chip, its preview and the chip on a sent message. */
export interface TerminalAttachmentInfo {
  // Issued by core for a pending attachment; `${userEntryId}:${index}` on a message.
  readonly id: string;
  readonly source: TerminalAttachmentSource;
  readonly commandLine: string | null;
  readonly exitCode: number | null;
  readonly terminalTitle: string;
  // Lines of the attached text.
  readonly lineCount: number;
  readonly omittedLines: number;
  // The last TERMINAL_ATTACHMENT_PREVIEW_LINES lines, at most TERMINAL_ATTACHMENT_PREVIEW_CHARS characters. Plain text.
  readonly preview: string;
}

export const TERMINAL_ATTACHMENT_PREVIEW_LINES = 40;
export const TERMINAL_ATTACHMENT_PREVIEW_CHARS = 4000;
