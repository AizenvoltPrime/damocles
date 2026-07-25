import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Args unit test for the real launcher: verifies that when launching headless we drop Playwright's
 * default `--mute-audio` (so media has sound) while still forcing `--headless=new`, that headful
 * launches add none of that special-casing, and (Slice 5 / S6) that `--remote-debugging-port=0` is
 * present ONLY when `devToolsPort` is true. Patchright is mocked so no real Chrome is spawned — we
 * only capture the options handed to `launchPersistentContext`.
 */

const launchPersistentContext = vi.fn(async () => ({}) as unknown);

vi.mock('patchright', () => ({
  chromium: { launchPersistentContext: (...a: unknown[]) => launchPersistentContext(...a) },
}));

import { launchBrowserContext } from '../launcher';

type CapturedOpts = { args: string[]; ignoreDefaultArgs?: string[]; headless: boolean };

function capturedOpts(call = 0): CapturedOpts {
  return launchPersistentContext.mock.calls[call][1] as CapturedOpts;
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
