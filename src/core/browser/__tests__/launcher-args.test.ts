import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);

/**
 * Args unit test for the real launcher: verifies that when launching headless we drop Playwright's
 * default `--mute-audio` (so media has sound) while still forcing `--headless=new`, that headful
 * launches add none of that special-casing, and (Slice 5 / S6) that `--remote-debugging-port=0` is
 * present ONLY when `devToolsPort` is true. Patchright is mocked so no real Chrome is spawned — we
 * only capture the options handed to `launchPersistentContext`.
 */

type CapturedOpts = { args: string[]; ignoreDefaultArgs?: string[]; headless: boolean; chromiumSandbox?: boolean };

const launchPersistentContext = vi.fn<(userDataDir: string, opts: CapturedOpts) => Promise<unknown>>(async () => ({}));

vi.mock('patchright', () => ({
  chromium: { launchPersistentContext: (userDataDir: string, opts: CapturedOpts) => launchPersistentContext(userDataDir, opts) },
}));

import { launchBrowserContext } from '../launcher';

function capturedOpts(call = 0): CapturedOpts {
  const captured = launchPersistentContext.mock.calls[call];
  if (!captured) throw new Error(`launchPersistentContext was called fewer than ${call + 1} time(s)`);
  return captured[1];
}

const baseOpts = {
  userDataDir: join(tmpdir(), 'damocles-test-udd'),
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  devToolsPort: true,
};

const DEVTOOLS_ARG = '--remote-debugging-port=0';

describe('launchBrowserContext — audio / headless args', () => {
  beforeEach(() => launchPersistentContext.mockClear());

  it('drops --mute-audio and forces --headless=new when headless', async () => {
    await launchBrowserContext({ ...baseOpts, headless: true });
    const opts = capturedOpts();

    expect(opts.headless).toBe(true);
    expect(opts.args).toContain('--headless=new');
    expect(opts.ignoreDefaultArgs).toContain('--headless');
    expect(opts.ignoreDefaultArgs).toContain('--mute-audio');
    // We only strip the two managed defaults, nothing else.
    expect(opts.args).not.toContain('--mute-audio');
  });

  for (const headless of [true, false]) {
    it(`keeps Chromium's sandbox on and never passes --no-sandbox (headless: ${headless})`, async () => {
      await launchBrowserContext({ ...baseOpts, headless });
      const opts = capturedOpts();
      expect(opts.chromiumSandbox).toBe(true);
      expect(opts.args).not.toContain('--no-sandbox');
    });
  }

  it('does no headless/mute special-casing when headful', async () => {
    await launchBrowserContext({ ...baseOpts, headless: false });
    const opts = capturedOpts();

    expect(opts.headless).toBe(false);
    expect(opts.args).not.toContain('--headless=new');
    // Headful Playwright never injects --mute-audio, so there is nothing to ignore.
    expect(opts.ignoreDefaultArgs).toBeUndefined();
  });
});

/**
 * Slice 5 / S6 — the DevTools debugging port is a launch-time Chromium flag gated on
 * `damocles.browser.devToolsPort`. The port flag is asserted by MEMBERSHIP, not position: it moved
 * from an unconditional array-literal entry (index 2) to a conditional `push`, which necessarily
 * relocates it to the tail. Chromium switch order is not semantically significant.
 */
describe('launchBrowserContext — DevTools debugging port (S6)', () => {
  beforeEach(() => launchPersistentContext.mockClear());

  it('passes --remote-debugging-port=0 when devToolsPort is true', async () => {
    await launchBrowserContext({ ...baseOpts, headless: true, devToolsPort: true });
    expect(capturedOpts().args).toContain(DEVTOOLS_ARG);
  });

  it('omits --remote-debugging-port=0 when devToolsPort is false', async () => {
    await launchBrowserContext({ ...baseOpts, headless: true, devToolsPort: false });
    const args = capturedOpts().args;
    expect(args).not.toContain(DEVTOOLS_ARG);
    // Nothing else stepped in to open a port under another spelling.
    expect(args.filter((a) => a.includes('remote-debugging'))).toEqual([]);
  });

  for (const headless of [true, false]) {
    it(`changes NOTHING but the port flag when devToolsPort is toggled (headless: ${headless})`, async () => {
      // POSITIVE CONTROL for the negative assertion above. Asserting only "the port arg is absent"
      // would still pass if the whole arg list were emptied, or if an unrelated flag were dropped in
      // the same edit. Comparing the two full arg lists with just the port flag filtered out proves
      // the setting's blast radius is EXACTLY one argument.
      await launchBrowserContext({ ...baseOpts, headless, devToolsPort: true });
      await launchBrowserContext({ ...baseOpts, headless, devToolsPort: false });
      const withPort = capturedOpts(0);
      const withoutPort = capturedOpts(1);

      expect(withPort.args.filter((a) => a !== DEVTOOLS_ARG)).toEqual(withoutPort.args);
      // Exactly one argument's worth of difference — not a coincidental re-ordering.
      expect(withPort.args).toHaveLength(withoutPort.args.length + 1);
      // The rest of the launch options are untouched by the setting.
      expect(withPort.headless).toBe(withoutPort.headless);
      expect(withPort.ignoreDefaultArgs).toEqual(withoutPort.ignoreDefaultArgs);
      // Guards against a vacuous pass on an empty/degenerate arg list.
      expect(withoutPort.args).toContain('--window-position=-32000,-32000');
      expect(withoutPort.args.length).toBeGreaterThan(3);
    });
  }
});

/** The features Playwright's own chromiumSwitches disables, read from the bundled patchright-core. */
function playwrightDisabledFeatures(): string[] {
  const bundle = readFileSync(join(dirname(require.resolve('patchright-core/package.json')), 'lib', 'coreBundle.js'), 'utf8');
  const list = /disabledFeatures = \[([\s\S]*?)\]\.filter\(Boolean\)/.exec(bundle)?.[1];
  if (list === undefined) throw new Error("patchright-core's disabledFeatures list was not found");
  return [...list.replace(/\/\/.*$/gm, '').matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

describe('launchBrowserContext — disabled Chromium features', () => {
  beforeEach(() => launchPersistentContext.mockClear());

  // Chrome keeps only the last --disable-features switch, which replaces Playwright's own.
  it("passes one --disable-features that keeps every feature Playwright disables, and Chrome's HTTPS-First mode off", async () => {
    await launchBrowserContext({ ...baseOpts, headless: true });
    const switches = capturedOpts().args.filter((arg) => arg.startsWith('--disable-features='));
    expect(switches).toHaveLength(1);
    const disabled = switches[0]!.slice('--disable-features='.length).split(',');
    const playwright = playwrightDisabledFeatures();
    expect(playwright).toContain('HttpsUpgrades');
    expect(disabled).toEqual(expect.arrayContaining([...playwright, 'HttpsFirstBalancedModeAutoEnable', 'ThirdPartyCookiePhaseout', 'FedCm']));
    expect(new Set(disabled).size).toBe(disabled.length);
  });
});

describe('launchBrowserContext — Chromium sandbox failures', () => {
  const ownGetuid = Object.getOwnPropertyDescriptor(process, 'getuid');
  const runAs = (uid: number): void => {
    Object.defineProperty(process, 'getuid', { value: () => uid, configurable: true, writable: true });
  };

  beforeEach(() => launchPersistentContext.mockClear());
  afterEach(() => {
    if (ownGetuid) Object.defineProperty(process, 'getuid', ownGetuid);
    else delete (process as { getuid?: unknown }).getuid;
  });

  it('refuses to launch as root before starting Chromium, instead of turning the sandbox off', async () => {
    runAs(0);
    await expect(launchBrowserContext({ ...baseOpts, headless: true })).rejects.toThrow(/runs as root.*non-root user/);
    expect(launchPersistentContext).not.toHaveBeenCalled();
  });

  it('launches with the sandbox on for a normal user', async () => {
    runAs(1000);
    await launchBrowserContext({ ...baseOpts, headless: true });
    expect(capturedOpts().chromiumSandbox).toBe(true);
  });

  it.each([
    ['Running as root without --no-sandbox is not supported. See https://crbug.com/638180.', /runs as root.*non-root user/],
    ['[FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox! Update your kernel or see the SUID sandbox docs.', /no usable sandbox.*user namespaces.*chrome-sandbox/],
  ])('turns Chromium\'s "%s" launch failure into a message that says how to fix it', async (browserLog, expected) => {
    runAs(1000);
    const launchError = new Error(`browserType.launchPersistentContext: Target page, context or browser has been closed\nBrowser logs:\n\n${browserLog}`);
    launchPersistentContext.mockRejectedValueOnce(launchError);
    const err = await launchBrowserContext({ ...baseOpts, headless: true }).then(() => null, (e: unknown) => e as Error);
    if (!err) throw new Error('the launch was expected to fail');
    expect(err.message).toMatch(expected);
    expect(err.cause).toBe(launchError);
  });

  it('passes any other launch failure through unchanged', async () => {
    runAs(1000);
    const launchError = new Error('browserType.launchPersistentContext: Chromium distribution \'chrome\' is not found');
    launchPersistentContext.mockRejectedValueOnce(launchError);
    await expect(launchBrowserContext({ ...baseOpts, headless: true })).rejects.toBe(launchError);
  });

  it('keeps this computer\'s paths out of a remote context\'s launch failure, which reaches the target', async () => {
    runAs(1000);
    // Patchright's launch failure quotes Chrome's command line from its browser logs
    const profile = 'C:\\Users\\someone\\.damocles\\browser-profiles\\ssh+host-1';
    const launchError = new Error(`browserType.launchPersistentContext: Failed to launch the browser process.\nBrowser logs:\n<launching> C:\\Users\\someone\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe --user-data-dir=${profile} --remote-debugging-pipe`);
    launchPersistentContext.mockRejectedValueOnce(launchError);
    const err = await launchBrowserContext({ ...baseOpts, headless: true, network: { server: 'http://127.0.0.1:9', args: [] } }).then(() => null, (e: unknown) => e as Error);
    if (!err) throw new Error('the launch was expected to fail');
    expect(err.message).not.toMatch(/someone|\.damocles|chrome\.exe/);
    expect(err.message).toMatch(/could not start on the computer that shows this chat/);
    expect(err.cause).toBe(launchError);
  });
});
