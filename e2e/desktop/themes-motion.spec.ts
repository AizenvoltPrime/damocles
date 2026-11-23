import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { readVideoSamples } from '../../src/shared/themes/video-samples';
import { FLASH_CHECK_VERSION } from '../../src/shared/themes/wallpapers';
import { coreLog } from './support/app';
import { activeChat, expect, test } from './support/fixtures';
import { writeUserSettings, type HermeticHome } from './support/hermetic';
import { onMainWindow, recordedToasts, recordToasts, shellPage, shellState } from './support/shell';
import { answerOpenDialog, clickMenu } from './support/ui';
import { HOOKS, openThemeEditor, pinNativeTheme, readTheme, skipWithoutGpuCompositing, storeBlob, themeHooks, windowShowsWallpapers, writeTheme } from './support/themes';

// Moving wallpapers (docs/invariants.md "Desktop themes"): a video plays once however many panels it spans, read in byte
// ranges; a file that flashes past WCAG 2.3.1 shows its still frame until the user allows it, and a video's check decodes
// every frame its container declares; an unfocused, minimized or covered window, battery power, battery saver and reduce
// motion pause playback; Next Wallpaper moves through a look's sets, and the set shown survives a relaunch. Main's e2e hooks
// record each theme blob answer and pin the motion inputs.

const ID = '7d1e2b5f-3c8e-4d2f-9b3a-6e7f8091a2b3';
const COLORS = { background: '#0b1020', panel: '#10172a', text: '#e4ecf5', accent: '#5ee6b0', success: '#4fd18b', warning: '#f2c14e', danger: '#ff6b7a', info: '#8ab4ff' };
const FIXTURES = path.resolve(import.meta.dirname, 'fixtures', 'wallpapers');
const media = (file: string): { readonly sha: string; readonly bytes: Buffer } => {
  const bytes = fs.readFileSync(path.join(FIXTURES, file));
  return { sha: createHash('sha256').update(bytes).digest('hex'), bytes };
};
const MOOV_START = media('moov-start.mp4');
const MOOV_END = media('moov-end.mp4');
const WEBM = media('loop.webm');
const FLASHING = 'flash-4hz.png';
const HOST_NEUTRAL = { inForcedColorsMode: false, prefersReducedTransparency: false };
const SETTINGS = { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': ID };

type Asset = { readonly sha: string; readonly bytes: Buffer };
const video = (asset: Asset, mime: string, size = { width: 160, height: 90 }, durationMs = 3000): Record<string, unknown> => ({ kind: 'video', mime, bytes: asset.bytes.length, ...size, durationMs, license: {} });

/** Stores the videos as core stores blobs and makes a theme of `sets` the preferred dark look; core analyzes them after launch. */
function useVideos(home: HermeticHome, sets: unknown[], assets: Record<string, unknown>, files: readonly Asset[], look: Record<string, unknown> = {}): void {
  for (const file of files) storeBlob(home, file.bytes);
  writeTheme(home, ID, { schemaVersion: 1, id: ID, name: 'Moving', origin: { kind: 'created', installedAt: 1 }, looks: { dark: { colors: COLORS, wallpapers: sets, ...look } }, assets });
  writeUserSettings(home, SETTINGS);
}

// An e2e window may never get focus from the OS and its machine may run on battery; moving wallpapers pause for either. A host
// in forced colors shows no wallpaper at all.
async function unpaused(app: ElectronApplication): Promise<void> {
  await themeHooks(app).pinMotion({ focused: true, onBattery: false, batterySaver: false });
  await pinNativeTheme(app, HOST_NEUTRAL);
}

interface Playback { readonly videos: number; readonly copies: number; readonly paused: boolean; readonly time: number; readonly source: string; readonly filters: string[] }
const playback = (shell: Page): Promise<Playback> => shell.evaluate(() => {
  const videos = [...document.querySelectorAll<HTMLVideoElement>('video[data-wallpaper-video]')];
  return {
    videos: videos.length,
    copies: document.querySelectorAll('canvas[data-wallpaper-copy]').length,
    paused: videos[0]?.paused ?? true,
    time: videos[0]?.currentTime ?? 0,
    source: videos[0]?.dataset['wallpaperVideo'] ?? '',
    filters: [...document.querySelectorAll<HTMLElement>('[data-wallpaper-region]')].filter((region) => !region.hidden).map((region) => (region.firstElementChild as HTMLElement).style.filter),
  };
});

/** Waits until the video of `sha` plays and its time moves on, then checks every answer main gave for it was a single-range 206. */
async function expectPlaying(app: ElectronApplication, shell: Page, sha: string): Promise<void> {
  await expect.poll(async () => {
    const now = await playback(shell);
    return now.source === sha && !now.paused;
  }, { timeout: 60_000 }).toBe(true);
  const before = (await playback(shell)).time;
  await expect.poll(async () => (await playback(shell)).time, { timeout: 10_000 }).not.toBe(before);
  const responses = await themeHooks(app).served(sha);
  expect(responses.length).toBeGreaterThan(0);
  for (const response of responses) {
    expect(response.status, JSON.stringify(responses)).toBe(206);
    expect(response.contentRange, JSON.stringify(responses)).toMatch(/^bytes \d+-\d+\/\d+$/);
  }
}

const SETS = [
  { name: 'Start', span: { asset: MOOV_START.sha, panels: ['sidebar', 'chat'], fit: 'fill' }, spanLook: { sidebar: { dim: 0.2, blur: 20 }, chat: { dim: 0.2, blur: 20 } } },
  { name: 'End', panels: { chat: { asset: MOOV_END.sha, fit: 'fill', dim: 0.2, blur: 0 } } },
  { name: 'WebM', panels: { sidebar: { asset: WEBM.sha, fit: 'tile', dim: 0.2, blur: 2 } } },
];
const SET_ASSETS = { [MOOV_START.sha]: video(MOOV_START, 'video/mp4'), [MOOV_END.sha]: video(MOOV_END, 'video/mp4'), [WEBM.sha]: video(WEBM, 'video/webm') };
const cycleFile = (home: HermeticHome): string => path.join(home.userData, 'theme-state.json');

test('plays an MP4 with moov at the start, one with moov at the end and a WebM through single-range 206 responses, decoding a spanning one once, and Next Wallpaper moves through the sets and saves the one shown', async ({ home, launch }) => {
  useVideos(home, SETS, SET_ASSETS, [MOOV_START, MOOV_END, WEBM]);
  const { app } = await launch(HOOKS);
  await skipWithoutGpuCompositing(app);
  await activeChat(app);
  const shell = await shellPage(app);
  await unpaused(app);

  await test.step('a video spanning two panels: one element, one canvas copy for the other region, blur capped at 8 px on both', async () => {
    await expectPlaying(app, shell, MOOV_START.sha);
    const spanning = await playback(shell);
    expect(spanning.videos).toBe(1);
    expect(spanning.copies).toBe(1);
    expect(spanning.filters).toEqual(['blur(8px)', 'blur(8px)']);
    // core checked it for flashing before it played
    const flash = JSON.parse(fs.readFileSync(path.join(home.damoclesDir, 'themes', 'cache', MOOV_START.sha, 'flash.json'), 'utf8')) as Record<string, unknown>;
    expect(flash).toEqual({ version: FLASH_CHECK_VERSION, flagged: false });
    expect(fs.existsSync(path.join(home.damoclesDir, 'themes', 'cache', MOOV_START.sha, 'still.png'))).toBe(true);
  });

  await test.step('Next Wallpaper: the MP4 whose index is at its end', async () => {
    await clickMenu(app, 'damocles.themes.nextWallpaper');
    await expectPlaying(app, shell, MOOV_END.sha);
    expect((await playback(shell)).videos).toBe(1);
  });

  await test.step('Next Wallpaper: the WebM, tiled', async () => {
    await clickMenu(app, 'damocles.themes.nextWallpaper');
    await expectPlaying(app, shell, WEBM.sha);
    // a tiled video draws its pattern on a canvas in its own region too
    expect((await playback(shell)).copies).toBe(1);
  });

  await test.step('the set shown is saved by the look it belongs to', async () => {
    await expect.poll(() => fs.existsSync(cycleFile(home)) && (JSON.parse(fs.readFileSync(cycleFile(home), 'utf8')) as { cycle: Record<string, { index: number }> }).cycle[`${ID}:dark`]?.index).toBe(2);
  });
});

// The file is written here in the form the test above reads back from main, so the two together pin what main writes and reads.
test('a launch shows the wallpaper set the last run left the look on', async ({ home, launch }) => {
  useVideos(home, SETS, SET_ASSETS, [MOOV_START, MOOV_END, WEBM]);
  fs.mkdirSync(home.userData, { recursive: true });
  fs.writeFileSync(cycleFile(home), JSON.stringify({ version: 1, cycle: { [`${ID}:dark`]: { index: 2, at: Date.now() } } }));
  const { app } = await launch(HOOKS);
  await skipWithoutGpuCompositing(app);
  await activeChat(app);
  await unpaused(app);
  const shell = await shellPage(app);
  await expect.poll(async () => (await shellState(app)).wallpapers?.map((region) => region.asset), { timeout: 30_000 }).toEqual([WEBM.sha]);
  await expectPlaying(app, shell, WEBM.sha);
});

test('Next Wallpaper on a look with one set says there is no next one and moves nothing', async ({ home, launch }) => {
  useVideos(home, [SETS[1]], { [MOOV_END.sha]: video(MOOV_END, 'video/mp4') }, [MOOV_END]);
  const { app } = await launch(HOOKS);
  await activeChat(app);
  await recordToasts(app);
  await clickMenu(app, 'damocles.themes.nextWallpaper');
  await expect.poll(async () => (await recordedToasts(app)).map((notice) => notice.message)).toEqual(['The look on screen has fewer than two wallpaper sets, so there is no next one.']);
  // no position was stored for the look
  expect(fs.existsSync(cycleFile(home)) ? (JSON.parse(fs.readFileSync(cycleFile(home), 'utf8')) as { cycle: Record<string, unknown> }).cycle : {}).toEqual({});
});

test('the blob route answers one byte range with that part, a range past the end with 416, and several ranges with the whole file', async ({ home, launch }) => {
  useVideos(home, [{ panels: { chat: { asset: MOOV_END.sha, fit: 'fill', dim: 0.2, blur: 0 } } }], { [MOOV_END.sha]: video(MOOV_END, 'video/mp4') }, [MOOV_END]);
  const { app } = await launch(HOOKS);
  await activeChat(app);
  const size = MOOV_END.bytes.length;
  expect(size).toBeGreaterThan(200);
  const fetchRange = (range: string): Promise<{ status: number; contentRange: string | null; length: string | null; body: string }> => app.evaluate(async ({ session }, [sha, header]) => {
    const res = await session.defaultSession.fetch(`app://damocles/theme-blob/${sha}`, { headers: { Range: header } });
    return { status: res.status, contentRange: res.headers.get('content-range'), length: res.headers.get('content-length'), body: Buffer.from(await res.arrayBuffer()).toString('base64') };
  }, [MOOV_END.sha, range] as const);
  // main serves a blob only while a theme names it, which it knows once it has read the themes
  await expect.poll(async () => (await fetchRange('bytes=0-0')).status).toBe(206);

  const part = await fetchRange('bytes=100-199');
  expect({ status: part.status, contentRange: part.contentRange, length: part.length }).toEqual({ status: 206, contentRange: `bytes 100-199/${size}`, length: '100' });
  expect(part.body).toBe(MOOV_END.bytes.subarray(100, 200).toString('base64'));

  const suffix = await fetchRange('bytes=-50');
  expect({ status: suffix.status, contentRange: suffix.contentRange }).toEqual({ status: 206, contentRange: `bytes ${size - 50}-${size - 1}/${size}` });
  expect(suffix.body).toBe(MOOV_END.bytes.subarray(size - 50).toString('base64'));

  // RFC 9110 section 15.5.17: a range that starts past the end names the size it missed
  const past = await fetchRange(`bytes=${size}-`);
  expect(past).toEqual({ status: 416, contentRange: `bytes */${size}`, length: '0', body: '' });

  // RFC 9110 section 14.2: a server may ignore a Range of several parts, and this one answers the whole file
  const several = await fetchRange('bytes=0-9,20-29');
  expect({ status: several.status, contentRange: several.contentRange, length: several.length }).toEqual({ status: 200, contentRange: null, length: String(size) });
  expect(several.body).toBe(MOOV_END.bytes.toString('base64'));
});

// The check hands each frame to a decoder itself and plays nothing, so it needs no GPU and no frame can be skipped: a clip
// that alternates black and white on every frame is a 30 Hz flash at 60 frames a second, which a check of every second
// frame would read as a still image.
test('a video\'s flash check decodes every frame its container declares: a per-frame strobe is flagged at 60 and at 30 frames a second, a still clip and each codec pass, and a frame that cannot be decoded refuses the file', async ({ home, launch }) => {
  const small = { width: 64, height: 64 };
  const clips = {
    strobe60: media('strobe-60fps.mp4'), strobe30: media('strobe-30fps.mp4'), still: media('still.mp4'),
    bframes: media('bframes.mp4'), fragmented: media('fragmented.mp4'), av1: media('av1.mp4'), vp8: media('vp8.webm'),
  };
  // the still clip with one frame's bytes zeroed: its container still declares the frame, and no decoder can read it. A
  // clip that flashes would be flagged before the check reached that frame.
  const damaged = Buffer.from(clips.still.bytes);
  const frame = readVideoSamples(new Uint8Array(damaged)).samples[31]!;
  damaged.fill(0, frame.offset, frame.offset + frame.size);
  const unreadable: Asset = { sha: createHash('sha256').update(damaged).digest('hex'), bytes: damaged };
  const named: Array<readonly [Asset, Record<string, unknown>]> = [
    [clips.strobe60, video(clips.strobe60, 'video/mp4', small, 2000)], [clips.strobe30, video(clips.strobe30, 'video/mp4', small, 2000)],
    [clips.still, video(clips.still, 'video/mp4', small, 2000)], [unreadable, video(unreadable, 'video/mp4', small, 2000)],
    [clips.bframes, video(clips.bframes, 'video/mp4', undefined, 2000)], [clips.fragmented, video(clips.fragmented, 'video/mp4', undefined, 2000)],
    [clips.av1, video(clips.av1, 'video/mp4', undefined, 2000)], [clips.vp8, video(clips.vp8, 'video/webm', undefined, 2000)],
  ];
  const sets = named.map(([asset]) => ({ panels: { chat: { asset: asset.sha, fit: 'fill', dim: 0.2, blur: 0 } } }));
  useVideos(home, sets, Object.fromEntries(named.map(([asset, meta]) => [asset.sha, meta])), named.map(([asset]) => asset));
  const { app } = await launch(HOOKS);
  await activeChat(app);

  const cache = path.join(home.damoclesDir, 'themes', 'cache');
  const flashOf = (asset: Asset): unknown => {
    const file = path.join(cache, asset.sha, 'flash.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
  };
  // core checks each named wallpaper after launch; the first failing second starts at the first transition, one frame in
  await expect.poll(() => flashOf(clips.strobe60), { timeout: 90_000 }).toEqual({ version: FLASH_CHECK_VERSION, flagged: true, atMs: 17, kind: 'general' });
  await expect.poll(() => flashOf(clips.strobe30), { timeout: 90_000 }).toEqual({ version: FLASH_CHECK_VERSION, flagged: true, atMs: 33, kind: 'general' });
  for (const passing of [clips.still, clips.bframes, clips.fragmented, clips.av1, clips.vp8]) {
    await expect.poll(() => flashOf(passing), { timeout: 90_000 }).toEqual({ version: FLASH_CHECK_VERSION, flagged: false });
    expect(fs.existsSync(path.join(cache, passing.sha, 'still.png'))).toBe(true);
  }
  // the unreadable frame: no verdict at all, so the file never plays, and the log says which frame's read failed
  await expect.poll(() => coreLog(home), { timeout: 90_000 }).toContain(`the wallpaper ${unreadable.sha} was not analyzed`);
  const line = coreLog(home).split('\n').find((candidate) => candidate.includes(`the wallpaper ${unreadable.sha} was not analyzed`))!;
  expect(line).toMatch(/a frame of the video did not decode|the decoder read \d+ of the video's 60 frames|was not read in its place/);
  expect(flashOf(unreadable)).toBeUndefined();
});

test('a file that flashes 4 times a second over half the frame is blocked with its failing time, and plays only after Allow flashing for this file', async ({ home, launch }) => {
  writeTheme(home, ID, { schemaVersion: 1, id: ID, name: 'Moving', origin: { kind: 'created', installedAt: 1 }, looks: { dark: { colors: COLORS } } });
  writeUserSettings(home, SETTINGS);
  const file = path.join(home.root, FLASHING);
  fs.copyFileSync(path.join(FIXTURES, FLASHING), file);
  const sha = media(FLASHING).sha;
  const { app } = await launch(HOOKS);
  await activeChat(app);
  await unpaused(app);
  const editor = await openThemeEditor(app, 'Moving', { tab: 'Wallpapers', width: 1280 });
  await editor.getByRole('radio', { name: 'One image per panel', exact: true }).click();
  await editor.getByRole('button', { name: 'Chat, no image', exact: true }).click();
  await answerOpenDialog(app, file);
  await editor.getByTestId('wallpaper-choose').click();

  // every frame was checked: the first second that fails starts at its first transition, 125 ms in
  const blocked = editor.getByTestId('wallpaper-flash-blocked');
  await expect(blocked).toBeVisible({ timeout: 60_000 });
  await expect(blocked).toContainText('Blocked: flashes');
  await expect(blocked).toContainText('from 0:00.1');
  await expect(blocked).toContainText('Seizure warning');
  expect(JSON.parse(fs.readFileSync(path.join(home.damoclesDir, 'themes', 'cache', sha, 'flash.json'), 'utf8'))).toEqual({ version: FLASH_CHECK_VERSION, flagged: true, atMs: 125, kind: 'general' });

  // the window's preview shows the still frame, never the animation; without GPU compositing it shows no wallpaper at all
  const windowShows = await windowShowsWallpapers(app);
  if (!windowShows) test.info().annotations.push({ type: 'partly skipped', description: 'no GPU compositing here, so the window checks do not run' });
  const shell = await shellPage(app);
  const chatImage = shell.locator('[data-wallpaper-region="chat"] > div').first();
  if (windowShows) {
    await expect.poll(() => shellState(app).then((state) => state.wallpapers?.[0]?.moving)).toEqual({ kind: 'animated', still: `app://damocles/theme-cache/${sha}/still.png`, playable: false });
    await expect(chatImage).toHaveAttribute('data-wallpaper-playing', 'false');
    expect(await chatImage.evaluate((element) => element.style.backgroundImage)).toContain(`${sha}/still.png`);
  }

  await editor.getByTestId('wallpaper-allow-flashing').click();
  await expect(editor.getByTestId('wallpaper-flash-allowed')).toBeVisible();
  if (windowShows) {
    await expect(chatImage).toHaveAttribute('data-wallpaper-playing', 'true', { timeout: 15_000 });
    expect(await chatImage.evaluate((element) => element.style.backgroundImage)).toContain(`theme-blob/${sha}`);
  }
  // the allowance is this computer's: beside the flash check, never in the theme file
  expect(JSON.parse(fs.readFileSync(path.join(home.damoclesDir, 'themes', 'cache', sha, 'flash.json'), 'utf8'))).toMatchObject({ flagged: true, allowed: true });
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => (readTheme(home, ID)['assets'] as Record<string, { flash?: unknown }> | undefined)?.[sha]?.flash).toEqual({ flagged: true, atMs: 125 });
});

// Covering the window is not reproducible here: under Playwright the page reports visibilityState visible whatever covers or
// minimizes the window, so the covered path (the page's report, main's pause) is unit-tested in page-motion.test.ts,
// shell-host.test.ts and appearance.test.ts. Minimizing is also seen through the window's own event, which this drives.
test('a minimized or unfocused window, battery power, battery saver and reduce motion each pause a moving wallpaper on its still frame, and it plays again when each ends', async ({ home, launch }) => {
  useVideos(home, [{ panels: { chat: { asset: MOOV_START.sha, fit: 'fill', dim: 0.2, blur: 0 } } }], { [MOOV_START.sha]: video(MOOV_START, 'video/mp4') }, [MOOV_START]);
  const { app } = await launch(HOOKS);
  await skipWithoutGpuCompositing(app);
  await activeChat(app);
  const shell = await shellPage(app);
  await unpaused(app);
  await expectPlaying(app, shell, MOOV_START.sha);
  const chatImage = shell.locator('[data-wallpaper-region="chat"] > div').first();
  await expect(chatImage).toHaveAttribute('data-wallpaper-playing', 'true');

  const minimize = (down: boolean): Promise<void> => onMainWindow(app, (win, minimized) => (minimized ? win.minimize() : win.restore()), down);
  const pin = themeHooks(app).pinMotion;
  const reduceMotion = (on: boolean): Promise<void> => Promise.resolve(writeUserSettings(home, { 'damocles.desktop.reduceMotion': on }));
  const pauses: Array<readonly [reason: string, start: () => Promise<void>, end: () => Promise<void>]> = [
    ['minimized', () => minimize(true), () => minimize(false)],
    ['unfocused', () => pin({ focused: false }), () => pin({ focused: true })],
    ['battery', () => pin({ onBattery: true }), () => pin({ onBattery: false })],
    ['batterySaver', () => pin({ batterySaver: true }), () => pin({ batterySaver: false })],
    ['reduceMotion', () => reduceMotion(true), () => reduceMotion(false)],
  ];
  for (const [reason, start, end] of pauses) {
    await test.step(reason, async () => {
      await start();
      await expect.poll(async () => (await shellState(app)).wallpaperPaused).toContain(reason);
      await expect.poll(async () => (await playback(shell)).paused).toBe(true);
      await expect(chatImage).toHaveAttribute('data-wallpaper-playing', 'false');
      expect(await chatImage.evaluate((element) => element.style.backgroundImage)).toContain(`${MOOV_START.sha}/still.png`);
      await end();
      await expect.poll(async () => (await shellState(app)).wallpaperPaused).toEqual([]);
      await expect.poll(async () => (await playback(shell)).paused).toBe(false);
      await expect(chatImage).toHaveAttribute('data-wallpaper-playing', 'true');
    });
  }
});
