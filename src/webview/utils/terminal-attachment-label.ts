import type { TerminalAttachmentInfo } from "@shared/types/terminal-attachment";

type Translate = (key: string, values?: Record<string, unknown>, plural?: number) => string;

/** A chip's parts: "Terminal: npm test", then "exit 1" and "120 lines"; a selection names its terminal instead. */
export function terminalAttachmentParts(attachment: TerminalAttachmentInfo, t: Translate): { head: string; details: string[] } {
  // Whitespace runs read as one space, as the reloaded attribute (`escapeAttribute`) has its line breaks flattened.
  const command = attachment.commandLine?.trim().split(/\s+/).join(" ");
  const head = attachment.source === "command" && command ? t("terminalAttachment.command", { command }) : t("terminalAttachment.selection");
  const details = [
    ...(attachment.source === "command" ? [] : [attachment.terminalTitle]),
    ...(attachment.exitCode !== null ? [t("terminalAttachment.exit", { code: attachment.exitCode })] : []),
    t("terminalAttachment.lines", { n: attachment.lineCount }, attachment.lineCount),
  ].filter((part) => part !== "");
  return { head, details };
}

/** The whole chip label, as screen readers and the chip's title read it. */
export function terminalAttachmentLabel(attachment: TerminalAttachmentInfo, t: Translate): string {
  const { head, details } = terminalAttachmentParts(attachment, t);
  return [head, ...details].join(" · ");
}
