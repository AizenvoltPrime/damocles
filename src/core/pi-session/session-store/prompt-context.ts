import { splitIdeContext } from '@shared/ide-context';
import { splitTerminalAttachments } from '../../terminal-attachment';

/**
 * The typed text of a stored user message, without the blocks Damocles put before it: `attachmentCount` terminal
 * attachments (the count their sidecar recorded, `terminal-attachments.ts`), then the IDE context block. The stored
 * entry keeps the blocks for rewind; only the displayed transcript and previews drop them.
 */
export function storedTypedText(text: string, attachmentCount: number): string {
  return splitIdeContext(splitTerminalAttachments(text, attachmentCount).text).text;
}
