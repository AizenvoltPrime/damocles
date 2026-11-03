import type { ElectronApplication } from '@playwright/test';

/**
 * Kills the renderer process of the one webContents whose URL contains urlPart, from main, and resolves its pid. Electron on
 * Linux ignores forcefullyCrashRenderer for a sandboxed renderer, so no render-process-gone would follow; a SIGKILL reports
 * one on every OS, with a reason other than clean-exit.
 */
export function killRenderer(app: ElectronApplication, urlPart: string): Promise<number> {
  return app.evaluate(({ webContents }, part) => {
    const matches = webContents.getAllWebContents().filter((contents) => contents.getURL().includes(part));
    if (matches.length !== 1) throw new Error(`${matches.length} webContents show a URL containing ${part}`);
    const pid = matches[0]!.getOSProcessId();
    if (pid === 0) throw new Error(`the renderer showing ${part} has no process`);
    process.kill(pid, 'SIGKILL');
    return pid;
  }, urlPart);
}
