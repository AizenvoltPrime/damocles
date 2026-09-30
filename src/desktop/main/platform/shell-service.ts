import { promises as fs } from 'node:fs';
import { shell } from 'electron';
import type { ShellService } from '../../../platform/shell-service';
import { webUrlHref } from '../../../core/web-url';
import { loggableUrl } from '../security';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createDesktopShellService(log: (line: string) => void): ShellService {
  return {
    openExternal: async (url) => {
      const href = webUrlHref(url);
      if (href === undefined) {
        log(`[shell] refused to open non-web URL ${loggableUrl(url)}`);
        return false;
      }
      try {
        await shell.openExternal(href);
        return true;
      } catch (err) {
        // No handler for the scheme, such as Linux without xdg-open.
        log(`[shell] could not open ${loggableUrl(href)}: ${errorText(err)}`);
        return false;
      }
    },
    openFolder: async (absolutePath) => {
      const stat = await fs.stat(absolutePath).catch((err: unknown) => {
        log(`[shell] could not open ${absolutePath}: ${errorText(err)}`);
        return undefined;
      });
      if (!stat) return false;
      if (!stat.isDirectory()) {
        log(`[shell] refused to open ${absolutePath}: not a folder`);
        return false;
      }
      const error = await shell.openPath(absolutePath);
      if (error !== '') log(`[shell] could not open ${absolutePath}: ${error}`);
      return error === '';
    },
    revealPath: async (absolutePath) => {
      shell.showItemInFolder(absolutePath);
    },
  };
}
