import { promises as fs } from 'node:fs';
import { shell } from 'electron';
import type { ShellService } from '../../../platform/shell-service';
import { webUrlHref } from '../../../core/web-url';
import { loggableUrl } from '../security';
import type { RevealVerdict } from '../reveal-guard';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface DesktopShellService extends ShellService {
  // Shows a path below a folder the user picked in a native dialog (a download's), which the Reveal check does not apply to;
  // every other path goes through revealPath.
  revealChosenPath(absolutePath: string): Promise<void>;
}

// revealable: the Reveal check (reveal-guard.ts), which every reveal and folder open passes; refused: tells the user a reveal
// was refused, and why
export function createDesktopShellService(
  log: (line: string) => void,
  revealable: (absolutePath: string) => Promise<RevealVerdict>,
  refused: (absolutePath: string, reason: Exclude<RevealVerdict, true>) => void,
): DesktopShellService {
  const allowed = async (absolutePath: string): Promise<boolean> => {
    const verdict = await revealable(absolutePath);
    if (verdict === true) return true;
    log(`[shell] refused to show ${absolutePath}: the Reveal check refused it (${verdict})`);
    refused(absolutePath, verdict);
    return false;
  };
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
      // the check walks the path before this stat follows any link on it
      if (!(await allowed(absolutePath))) return false;
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
      if (await allowed(absolutePath)) shell.showItemInFolder(absolutePath);
    },
    revealChosenPath: async (absolutePath) => {
      shell.showItemInFolder(absolutePath);
    },
  };
}
