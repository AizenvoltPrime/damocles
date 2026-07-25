import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { chromium, type BrowserContext } from 'patchright';
import { log } from '../logger';

const execFileAsync = promisify(execFile);

let cachedBrowserPath: string | null = null;

async function fileExists(filePath: string): Promise<boolean> {
  return fsp.access(filePath).then(() => true, () => false);
}

/**
 * Locate a system Chrome/Edge install. Patchright's `channel:'chrome'` normally discovers the branded
 * Chrome itself, but on machines where the channel is unavailable (Chrome missing, only Edge present)
 * we fall back to an explicit `executablePath`. Kept identical to the pre-Patchright discovery order so
 * behaviour is unchanged. Returns `null` when nothing is found so the caller can rely on `channel:'chrome'`.
 */
export async function findBrowser(): Promise<string | null> {
  if (cachedBrowserPath) return cachedBrowserPath;

  if (process.platform === 'win32') {
    const env = process.env;
    const paths = [
      join(env['PROGRAMFILES'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env['PROGRAMFILES(X86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env['PROGRAMFILES'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(env['PROGRAMFILES(X86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
    for (const p of paths) {
      if (await fileExists(p)) {
        cachedBrowserPath = p;
        return p;
      }
    }
  } else if (process.platform === 'darwin') {
    const paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    for (const p of paths) {
      if (await fileExists(p)) {
        cachedBrowserPath = p;
        return p;
      }
    }
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium', 'microsoft-edge-stable', 'microsoft-edge']) {
      try {
        const { stdout } = await execFileAsync('which', [name]);
        const resolved = stdout.trim();
        if (resolved) {
          cachedBrowserPath = resolved;
          return resolved;
        }
      } catch {
        // `which` exits non-zero when the binary is absent; try the next candidate.
      }
    }
  }
  return null;
}

export interface LaunchBrowserOptions {
  userDataDir: string;
  headless: boolean;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  devToolsPort: boolean;
}

// Extra flags Patchright does NOT manage that we still want. The flags Patchright's launch patch owns
// are deliberately absent: it removes --enable-automation / --disable-extensions / --disable-default-apps
// / --disable-popup-blocking / --disable-component-update and adds --disable-blink-features=AutomationControlled
// itself, so re-adding them would either be redundant or (for --enable-automation) actively harmful to
// stealth. Playwright already injects --no-sandbox (chromiumSandbox defaults false), --no-first-run and
// --no-default-browser-check via chromiumSwitches, so we only add the genuinely-missing extras here.
const CURATED_EXTRA_ARGS = [
  '--disable-translate',
  '--autoplay-policy=no-user-gesture-required',
  // Keep cookies working on strict sites + silence FedCm prompts (unchanged from the raw-CDP launcher).
  '--disable-features=ThirdPartyCookiePhaseout,TrackingProtection3pcd,ThirdPartyStoragePartitioning,SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure,FedCm,FedCmIdpSigninStatusEnabled,FedCmAutoSelectedFlag',
];

/**
 * Launch system Chrome through Patchright's persistent context.
 *
 * Key decisions (see mission-brief open questions):
 *  - `channel:'chrome'` launches the branded system Chrome with NO Chromium download. `executablePath`
 *    is only supplied as a fallback when no branded Chrome/Edge is discoverable.
 *  - #4 (new headless): Playwright emits a plain `--headless` for `channel:'chrome'` + `headless:true`.
 *    On Chrome 128+ plain `--headless` already selects the new headless implementation, but to be
 *    explicit and future-proof we drop Playwright's `--headless` via `ignoreDefaultArgs` and pass
 *    `--headless=new` ourselves, forcing the new headless surface deterministically.
 *  - Off-screen window: `--window-position=-32000,-32000` parks the window far off-screen. In new
 *    headless there is no OS window (so it is a harmless no-op); in the HEADFUL path (headless:false)
 *    it prevents the focus-steal/flash, preserving the pre-Patchright behaviour.
 *  - `--remote-debugging-port=0` (only when `devToolsPort`) makes Chrome pick a free port and write it
 *    to the DevToolsActivePort file in the user-data-dir; the DevTools button reads that file.
 *    Playwright drives its own connection over a pipe, so the port coexists. The port is
 *    unauthenticated on loopback and attached to the logged-in profile, so any local process can
 *    attach and drive the browser as the user — `damocles.browser.devToolsPort` turns it off.
 */
export async function launchBrowserContext(opts: LaunchBrowserOptions): Promise<BrowserContext> {
  const { userDataDir, headless, viewport, deviceScaleFactor, devToolsPort } = opts;

  const args = [
    '--window-position=-32000,-32000',
    '--window-size=1920,1080',
    ...CURATED_EXTRA_ARGS,
  ];

  if (devToolsPort) {
    args.push('--remote-debugging-port=0');
  }

  // Force the new headless surface (see #4 above). Only meaningful when launching headless.
  const ignoreDefaultArgs: string[] = [];
  if (headless) {
    ignoreDefaultArgs.push('--headless');
    args.push('--headless=new');
    // Playwright's default headless args include --mute-audio, which mutes media at the process
    // level regardless of in-page volume. New headless (--headless=new) routes audio to the host,
    // so drop the flag to let videos play sound.
    ignoreDefaultArgs.push('--mute-audio');
  }

  const executablePath = await findBrowser();
  if (!executablePath) {
    log('[Browser] No branded Chrome/Edge discovered — relying on Patchright channel:chrome resolution');
  }

  return chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless,
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor,
    acceptDownloads: true,
    args,
    ...(ignoreDefaultArgs.length > 0 ? { ignoreDefaultArgs } : {}),
    ...(executablePath ? { executablePath } : {}),
  });
}
