/**
 * The IDE context block Damocles prepends to a user message: the opened file, or a selection. It is
 * model-only context the user never typed. `formatIdeContextBlock` produces it and
 * `splitIdeContext` reads it back, so the wire format has exactly one definition.
 */

export type IdeContextBlock =
  | { type: 'opened_file'; filePath: string }
  | { type: 'selection'; filePath: string; startLine: number; endLine: number; content: string };

const RELATEDNESS_NOTE = 'This may or may not be related to the current task.';

const OPENED_OPEN = '<ide_opened_file>The user opened the file ';
const OPENED_CLOSE = ` in the IDE. ${RELATEDNESS_NOTE}</ide_opened_file>`;
const SELECTION_OPEN = '<ide_selection>The user selected the lines ';
const SELECTION_CLOSE = `\n\n${RELATEDNESS_NOTE}</ide_selection>`;
const SELECTION_HEADER = /^(\d+) to (\d+) from ([^\n]*):\n/;

export function formatIdeContextBlock(block: IdeContextBlock): string {
  if (block.type === 'selection') {
    return `${SELECTION_OPEN}${block.startLine} to ${block.endLine} from ${block.filePath}:\n${block.content}${SELECTION_CLOSE}`;
  }
  return `${OPENED_OPEN}${block.filePath}${OPENED_CLOSE}`;
}

/**
 * Separates a leading IDE context block from the text the user typed. `extractText`
 * (`pi-session/branch-text.ts`) joins the block and the message with one newline before `prompt()`,
 * so that separator is part of this format. A block anywhere but the start is user text and stays.
 */
export function splitIdeContext(text: string): { context: IdeContextBlock | null; text: string } {
  const rest = (end: number): string => text.slice(text[end] === '\n' ? end + 1 : end);
  if (text.startsWith(OPENED_OPEN)) {
    const close = text.indexOf(OPENED_CLOSE, OPENED_OPEN.length);
    if (close >= 0) {
      return {
        context: { type: 'opened_file', filePath: text.slice(OPENED_OPEN.length, close) },
        text: rest(close + OPENED_CLOSE.length),
      };
    }
  } else if (text.startsWith(SELECTION_OPEN)) {
    const close = text.indexOf(SELECTION_CLOSE, SELECTION_OPEN.length);
    const header = close >= 0 ? SELECTION_HEADER.exec(text.slice(SELECTION_OPEN.length, close)) : null;
    if (header) {
      const contentStart = SELECTION_OPEN.length + header[0].length;
      return {
        context: {
          type: 'selection',
          filePath: header[3]!,
          startLine: Number(header[1]),
          endLine: Number(header[2]),
          content: text.slice(contentStart, close),
        },
        text: rest(close + SELECTION_CLOSE.length),
      };
    }
  }
  return { context: null, text };
}
