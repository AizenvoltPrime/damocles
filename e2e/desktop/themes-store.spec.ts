import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat, expect, test } from './support/fixtures';
import { readUserSettings, writeUserSettings, type HermeticHome } from './support/hermetic';
import { settingsRow } from './support/settings';
import { controlReady, openAppearance, writeTheme } from './support/themes';

// The community theme store (docs/desktop-app.md "Settings", Browse; docs/invariants.md "Desktop themes"). The list is a local
// fixture signed by a key pair made here, which only the e2e hooks let core trust; https://e2e.test/<name> reads from the
// fixture folder.

const CHECKED = { timeout: 30_000 };
const LIST_NAME = 'community.signed.json';
const STORE_SETTING = 'damocles.desktop.themes.store';
const DARK = { background: '#1a1033', panel: '#24154a', text: '#f4e9ff', accent: '#ff7a59', success: '#5be3a0', warning: '#ffc857', danger: '#ff6b6b', info: '#8fb8ff' };
const LIGHT = { background: '#fbf3e4', panel: '#f1e4cc', text: '#2a1d12', accent: '#b4532a', success: '#2f6b3a', warning: '#8a5a00', danger: '#a12a2a', info: '#2d5a99' };
const OCEAN_ID = '3c4d5e6f-0000-4000-8000-0000000000a1';
const SUNSET_ID = '3c4d5e6f-0000-4000-8000-0000000000a2';
const REMOVED_REASON = 'The wallpaper was used without the artist\'s permission.';

const STORE_KEYS = generateKeyPairSync('ed25519');
const keyIdOf = (key: KeyObject): string => createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);

interface Entry {
  readonly id: string;
  readonly name: string;
  readonly author: string;
  readonly version: string;
  readonly kinds: readonly ('dark' | 'light')[];
  readonly hasLayout: boolean;
  readonly minAppVersion: string;
}
const SYNTHWAVE: Entry = { id: 'synthwave-sunset', name: 'Synthwave Sunset', author: 'retroline', version: '1.0.0', kinds: ['dark', 'light'], hasLayout: true, minAppVersion: '1.0.0' };
const OCEAN: Entry = { id: 'ocean-depths', name: 'Ocean Depths', author: 'tidal', version: '1.1.0', kinds: ['dark'], hasLayout: false, minAppVersion: '1.0.0' };
const NEON: Entry = { id: 'neon-grid', name: 'Neon Grid', author: 'cyberdesk', version: '1.0.0', kinds: ['dark'], hasLayout: false, minAppVersion: '99.0.0' };

const downloads = (home: HermeticHome): string => path.join(home.root, 'theme-downloads');

/** The entry's .damocles-theme file in the fixture folder, and the list's entry pinning its bytes. */
function writeEntry(home: HermeticHome, entry: Entry): Record<string, unknown> {
  const looks = Object.fromEntries(entry.kinds.map((kind) => [kind, { colors: kind === 'dark' ? DARK : LIGHT }]));
  const theme = { schemaVersion: 1, id: randomUUID(), name: entry.name, author: entry.author, version: entry.version, license: 'MIT', looks, ...(entry.hasLayout ? { layout: { sidebarWidth: 280 } } : {}) };
  const bytes = zipSync({ 'theme.json': strToU8(JSON.stringify(theme)) });
  const fileName = `${entry.id}-${entry.version}.damocles-theme`;
  fs.mkdirSync(downloads(home), { recursive: true });
  fs.writeFileSync(path.join(downloads(home), fileName), bytes);
  return {
    id: entry.id, name: entry.name, author: entry.author, description: `${entry.name} by ${entry.author}.`, kinds: entry.kinds, version: entry.version,
    file: { url: `https://e2e.test/${fileName}`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength },
    colors: Object.fromEntries(entry.kinds.map((kind) => [kind, kind === 'dark' ? DARK : LIGHT])), fonts: [], thumbnails: {}, licenses: ['MIT'],
    hasCss: false, hasLayout: entry.hasLayout, hasCharacters: false, hasMoving: false, minAppVersion: entry.minAppVersion,
  };
}

/** Writes the signed list; `signer` other than the trusted pair makes a list core must refuse. */
function writeList(home: HermeticHome, entries: readonly Entry[], removed: readonly Record<string, unknown>[] = [], signer = STORE_KEYS): void {
  const now = Date.now();
  const payload = JSON.stringify({ sequence: 1, issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 30 * 86_400_000).toISOString(), entries: entries.map((entry) => writeEntry(home, entry)), removed });
  const envelope = { format: 1, keyId: keyIdOf(signer.publicKey), payload, signature: sign(null, Buffer.from(payload, 'utf8'), signer.privateKey).toString('base64') };
  fs.mkdirSync(downloads(home), { recursive: true });
  fs.writeFileSync(path.join(downloads(home), LIST_NAME), JSON.stringify(envelope));
}

const storeEnv = (home: HermeticHome): Record<string, string> => ({
  DAMOCLES_E2E_HOOKS: '1',
  DAMOCLES_E2E_THEME_DOWNLOADS: downloads(home),
  DAMOCLES_E2E_THEME_STORE_LIST: `https://e2e.test/${LIST_NAME}`,
  DAMOCLES_E2E_THEME_STORE_KEY: STORE_KEYS.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
});

/** An installed store theme as core writes one; installedHash differs from its content, so it counts as edited. */
function writeStoreTheme(home: HermeticHome, id: string, name: string, entryId: string, version: string): void {
  writeTheme(home, id, {
    schemaVersion: 1, id, name, looks: { dark: { colors: DARK } },
    origin: { kind: 'store', store: { entryId, version, sha256: 'e'.repeat(64) }, installedHash: 'f'.repeat(64), installedAt: Date.now() - 86_400_000 },
  });
}

/** The installed user themes core wrote, by name. */
function installed(home: HermeticHome): { id: string; name: string; theme: Record<string, unknown> }[] {
  const root = path.join(home.damoclesDir, 'themes', 'themes');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((id) => {
    const file = path.join(root, id, 'theme.json');
    if (!fs.existsSync(file)) return [];
    const theme = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    return [{ id, name: String(theme['name']), theme }];
  });
}

interface StoreHooks { __damoclesE2e: { themeStore: { backgroundCheck(): Promise<{ ran: boolean; fetched: boolean }>; fetches(): Promise<{ url: string; purpose: 'list' | 'thumbnail' }[]> } } }
const backgroundCheck = (app: ElectronApplication): Promise<{ ran: boolean; fetched: boolean }> => app.evaluate(() => (globalThis as unknown as StoreHooks).__damoclesE2e.themeStore.backgroundCheck());
// returns and clears core's log of store requests
const fetches = (app: ElectronApplication): Promise<{ url: string; purpose: 'list' | 'thumbnail' }[]> => app.evaluate(() => (globalThis as unknown as StoreHooks).__damoclesE2e.themeStore.fetches());
const listFetches = async (app: ElectronApplication): Promise<number> => (await fetches(app)).filter((fetch) => fetch.purpose === 'list').length;

const installDialog = (overlay: Page): Locator => overlay.getByTestId('theme-install-dialog');

/** Opens Settings › Appearance › Browse, waits for the entry named `name` and expects the one list fetch that took. */
async function openBrowse(app: ElectronApplication, name: string): Promise<void> {
  const page = await openAppearance(app, 1280);
  await page.getByRole('tab', { name: 'Browse', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible(CHECKED);
  expect(await listFetches(app)).toBe(1);
}

/** Waits until the install card's visibility check let its controls act. */
async function cardReady(overlay: Page, title: string): Promise<Locator> {
  const dialog = overlay.getByRole('dialog', { name: title, exact: true });
  await expect(dialog).toBeVisible(CHECKED);
  await controlReady(dialog.getByTestId('theme-install-go'));
  return dialog;
}

for (const width of [1280, 900] as const) {
  test(`S1 Browse journey at ${width} px, then the installed entry shows Installed and the toast confirms`, async ({ home, launch }) => {
    test.setTimeout(240_000);
    writeList(home, [SYNTHWAVE, NEON]);
    writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': 'damocles-aurora' });
    const { app } = await launch({ env: storeEnv(home) });
    await activeChat(app);
    const page = await openAppearance(app, width);

    // the design's S1 journey, by role and accessible name
    await page.getByRole('radio', { name: 'Damocles, dark', exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Damocles, dark, active', exact: true })).toBeVisible();
    await page.getByRole('radio', { name: 'Damocles, dark, active', exact: true }).press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'System colors, dark, active', exact: true })).toBeFocused();
    await page.getByRole('radio', { name: 'System colors, dark, active', exact: true }).press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Aurora, dark, active', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Browse', exact: true }).click();
    await expect(page.getByLabel('Search community themes', { exact: true })).toBeVisible(CHECKED);
    await page.getByLabel('Search community themes', { exact: true }).fill('zzz');
    await expect(page.getByRole('heading', { name: 'No themes matched “zzz”', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Clear search and filters', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Synthwave Sunset', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Install Synthwave Sunset', exact: true }).click();
    await expect(page.getByLabel('Use this theme\'s window arrangement', { exact: false })).toBeVisible(CHECKED);
    const dialog = await cardReady(page, 'Install “Synthwave Sunset”?');
    await expect(dialog.getByTestId('theme-install-source')).toHaveText('From the community store, by retroline. The file matched the signed list.');
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Install “Synthwave Sunset”?', exact: true })).toBeHidden(CHECKED);
    await expect(page.getByRole('button', { name: 'Install Synthwave Sunset', exact: true })).toBeHidden(CHECKED);

    // the slice's own checks: the badge, the toast, and the origin core wrote
    const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Synthwave Sunset', exact: true }) });
    await expect(card.getByTestId('theme-browse-installed')).toHaveText('Installed');
    await expect(page.getByTestId('theme-toast')).toContainText('Installed Synthwave Sunset. Pick it as your dark or light look on Installed.');
    const theme = installed(home).find((entry) => entry.name === 'Synthwave Sunset');
    expect(theme).toBeDefined();
    expect(theme!.theme['origin']).toMatchObject({ kind: 'store', store: { entryId: SYNTHWAVE.id, version: SYNTHWAVE.version } });

    // an entry made for a newer app cannot be installed
    const newer = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Neon Grid', exact: true }) }).getByRole('button', { name: 'Needs a newer Damocles', exact: true });
    await expect(newer).toHaveAttribute('aria-disabled', 'true');
    await expect(newer).toHaveAttribute('title', 'Made for Damocles 99.0.0 or newer. Update Damocles to install it.');
    // aria-disabled keeps Playwright from clicking, so the click is forced to prove the button does nothing
    await newer.click({ force: true });
    await expect(installDialog(page)).toBeHidden();
    expect(installed(home).some((entry) => entry.name === 'Neon Grid')).toBe(false);
  });
}

test('Update of an edited store theme notes the your-edits copy, keeps it, and replaces the theme under its id', async ({ home, launch }) => {
  test.setTimeout(240_000);
  writeStoreTheme(home, OCEAN_ID, 'Ocean Depths', OCEAN.id, '1.0.0');
  writeList(home, [OCEAN]);
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': OCEAN_ID });
  const { app } = await launch({ env: storeEnv(home) });
  await activeChat(app);
  const page = await openAppearance(app, 1280);

  await page.getByRole('tab', { name: 'Browse', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ocean Depths', exact: true })).toBeVisible(CHECKED);
  await expect(page.getByText('Update 1.1.0', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Update Ocean Depths', exact: true }).click();
  const dialog = await cardReady(page, 'Update “Ocean Depths” to 1.1.0?');
  await expect(dialog.getByTestId('theme-install-your-edits')).toHaveText('Your own edits to this theme are kept as a copy named “Ocean Depths (your edits)”.');
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(installDialog(page)).toBeHidden(CHECKED);
  await expect(page.getByTestId('theme-toast')).toContainText('Updated Ocean Depths. Pick it as your dark or light look on Installed. Your edited version is kept as “Ocean Depths (your edits)”.');

  const after = installed(home);
  expect(after.map((entry) => entry.name).sort()).toEqual(['Ocean Depths', 'Ocean Depths (your edits)']);
  const updated = after.find((entry) => entry.name === 'Ocean Depths')!;
  expect(updated.id).toBe(OCEAN_ID);
  expect(updated.theme['origin']).toMatchObject({ kind: 'store', store: { entryId: OCEAN.id, version: OCEAN.version } });
  expect((after.find((entry) => entry.name === 'Ocean Depths (your edits)')!.theme['origin'] as { kind: string }).kind).not.toBe('store');
  await expect(page.getByRole('button', { name: 'Update Ocean Depths', exact: true })).toBeHidden(CHECKED);
});

test('the update check applies a removed entry without Browse: the theme is marked, the look switches away, Delete is offered', async ({ home, launch }) => {
  test.setTimeout(240_000);
  writeStoreTheme(home, SUNSET_ID, 'Sunset Boulevard', 'sunset-boulevard', '2.0.0');
  writeList(home, [], [{ id: 'sunset-boulevard', reason: REMOVED_REASON }]);
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': SUNSET_ID });
  const { app } = await launch({ env: storeEnv(home) });
  await activeChat(app);
  expect(await listFetches(app)).toBe(0);

  expect(await backgroundCheck(app)).toEqual({ ran: true, fetched: true });
  expect(await listFetches(app)).toBe(1);
  await expect.poll(() => readUserSettings(home)['damocles.desktop.themes.dark']).not.toBe(SUNSET_ID);

  const page = await openAppearance(app, 900);
  const card = page.getByTestId(`theme-card-${SUNSET_ID}`);
  await expect(card.getByTestId('theme-card-removed')).toContainText(`Removed from the store: ${REMOVED_REASON}`);
  await expect(page.getByRole('radio', { name: 'Damocles, dark, active', exact: true })).toBeVisible();
  // nothing was deleted until the user chooses Delete
  expect(installed(home).map((entry) => entry.id)).toEqual([SUNSET_ID]);
  await card.getByTestId('theme-card-removed').getByRole('button', { name: 'Delete Sunset Boulevard', exact: true }).click();
  await page.getByTestId('theme-delete').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(card).toBeHidden(CHECKED);
  expect(installed(home)).toEqual([]);
});

test('a list signed by a key the app does not know is refused with its reason, and nothing of it shows', async ({ home, launch }) => {
  test.setTimeout(180_000);
  writeList(home, [SYNTHWAVE], [], generateKeyPairSync('ed25519'));
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
  const { app } = await launch({ env: storeEnv(home) });
  await activeChat(app);
  const page = await openAppearance(app, 1280);

  await page.getByRole('tab', { name: 'Browse', exact: true }).click();
  const refused = page.getByTestId('theme-browse-refused');
  await expect(refused).toBeVisible(CHECKED);
  await expect(refused.getByRole('heading', { name: 'The community list didn\'t pass its checks', exact: true })).toBeVisible();
  await expect(page.getByTestId('theme-browse-refused-reason')).not.toBeEmpty();
  await expect(page.getByRole('heading', { name: 'Synthwave Sunset', exact: true })).toBeHidden();
  expect(await listFetches(app)).toBe(1);
});

test('a file that differs from its pin installs nothing, and a list that cannot be fetched still shows and installs', async ({ home, launch }) => {
  test.setTimeout(240_000);
  writeList(home, [SYNTHWAVE, OCEAN]);
  // the store's file changed after the list pinned it: the same size, other bytes
  const pinned = path.join(downloads(home), `${OCEAN.id}-${OCEAN.version}.damocles-theme`);
  fs.writeFileSync(pinned, Buffer.alloc(fs.statSync(pinned).size, 7));
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
  const { app } = await launch({ env: storeEnv(home) });
  await activeChat(app);
  const page = await openAppearance(app, 1280);
  await page.getByRole('tab', { name: 'Browse', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ocean Depths', exact: true })).toBeVisible(CHECKED);

  await page.getByRole('button', { name: 'Install Ocean Depths', exact: true }).click();
  await expect(page.getByTestId('theme-error')).toHaveText('The downloaded theme\'s SHA-256 does not match the community store list\'s pin, so nothing was installed.', CHECKED);
  await expect(installDialog(page)).toBeHidden();
  expect(installed(home)).toEqual([]);

  // the list is gone from where it is fetched: the kept one shows, says why, and still installs
  fs.rmSync(path.join(downloads(home), LIST_NAME));
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  const banner = page.getByTestId('theme-browse-cached');
  await expect(banner).toContainText('Couldn\'t check for updates.', CHECKED);
  await expect(banner.getByTestId('theme-browse-cached-reason')).not.toBeEmpty();
  await expect(banner).not.toContainText(/offline/i);
  await expect(page.getByRole('heading', { name: 'Synthwave Sunset', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Install Synthwave Sunset', exact: true }).click();
  const dialog = await cardReady(page, 'Install “Synthwave Sunset”?');
  await dialog.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(installDialog(page)).toBeHidden(CHECKED);
  expect(installed(home).map((entry) => entry.name)).toEqual(['Synthwave Sunset']);
});

test('with the store off nothing is fetched, by Browse or the update check; Turn on the store lists it', async ({ home, launch }) => {
  test.setTimeout(180_000);
  writeStoreTheme(home, OCEAN_ID, 'Ocean Depths', OCEAN.id, '1.0.0');
  writeList(home, [OCEAN]);
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark', [STORE_SETTING]: false });
  const { app } = await launch({ env: storeEnv(home) });
  await activeChat(app);

  expect(await backgroundCheck(app)).toMatchObject({ fetched: false });
  const page = await openAppearance(app, 900);
  await expect(settingsRow(page, STORE_SETTING).getByRole('switch', { name: 'Community store', exact: true })).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('tab', { name: 'Browse', exact: true }).click();
  const off = page.getByTestId('theme-browse-off');
  await expect(off.getByRole('heading', { name: 'The community store is off', exact: true })).toBeVisible(CHECKED);
  expect(await fetches(app)).toEqual([]);

  await off.getByRole('button', { name: 'Turn on the store', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ocean Depths', exact: true })).toBeVisible(CHECKED);
  await expect.poll(() => readUserSettings(home)[STORE_SETTING]).toBe(true);
  expect(await listFetches(app)).toBe(1);
});

test('no store fetch beside the update check while no store theme is installed', async ({ home, launch }) => {
  test.setTimeout(120_000);
  writeList(home, [SYNTHWAVE]);
  const { app } = await launch({ env: storeEnv(home) });
  await activeChat(app);
  expect(await backgroundCheck(app)).toMatchObject({ fetched: false });
  expect(await fetches(app)).toEqual([]);
  // the control: the log records a fetch Browse makes
  await openBrowse(app, SYNTHWAVE.name);
});

test('no store fetch while "Check for updates automatically" is off, even with a store theme installed', async ({ home, launch }) => {
  test.setTimeout(120_000);
  writeStoreTheme(home, OCEAN_ID, 'Ocean Depths', OCEAN.id, '1.0.0');
  writeList(home, [OCEAN]);
  writeUserSettings(home, { 'damocles.desktop.update.checkAutomatically': false });
  const { app } = await launch({ env: storeEnv(home) });
  await activeChat(app);
  expect(await backgroundCheck(app)).toEqual({ ran: false, fetched: false });
  expect(await fetches(app)).toEqual([]);
  // the control: Browse still fetches, since the switch governs only the background check
  await openBrowse(app, OCEAN.name);
});
