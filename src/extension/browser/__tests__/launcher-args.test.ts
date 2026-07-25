import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Args unit test for the real launcher: verifies that when launching headless we drop Playwright's
 * default `--mute-audio` (so media has sound) while still forcing `--headless=new`, and that headful
 * launches add none of that special-casing. Patchright is mocked so no real Chrome is spawned — we
 * only capture the options handed to `launchPersistentContext`.
 */

const launchPersistentContext = vi.fn(async () => ({}) as unknown);

vi.mock('patchright', () => ({
  chromium: { launchPersistentContext: (...a: unknown[]) => launchPersistentContext(...a) },
}));

import { launchBrowserContext } from '../launcher';

type CapturedOpts = { args: string[]; ignoreDefaultArgs?: string[]; headless: boolean };

function capturedOpts(): CapturedOpts {
  return launchPersistentContext.mock.calls[0][1] as CapturedOpts;
}

const baseOpts = {
  userDataDir: '/tmp/damocles-test-udd',
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
};

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
