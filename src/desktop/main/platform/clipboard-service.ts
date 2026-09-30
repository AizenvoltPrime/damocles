import { clipboard } from 'electron';
import type { ClipboardService } from '../../../platform/clipboard-service';

export function createDesktopClipboardService(): ClipboardService {
  return {
    writeText: async (text) => {
      clipboard.writeText(text);
    },
  };
}
