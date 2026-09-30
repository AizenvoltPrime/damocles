import { splitIdeContext } from '@shared/ide-context';

/**
 * The typed text of a stored user message, without the leading IDE context block Damocles prepends.
 * The stored entry keeps the block for rewind; only the displayed transcript drops it.
 */
export function stripIdeContext(text: string): string {
  return splitIdeContext(text).text;
}
