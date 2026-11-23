import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import type { Locator, Page } from '@playwright/test';
import { mainLog } from '../desktop/support/app';
import { writeUserSettings } from '../desktop/support/hermetic';
import { call, chatRequests, type OpenAIStub } from '../desktop/support/openai-stub';
import { closeSettingsModal, openSettingsModal, settingsNav } from '../desktop/support/settings';
import { overlayPage } from '../desktop/support/shell';
import { dockShown, themeDockView, themeEditorPage, windowBackground, writeTheme } from '../desktop/support/themes';
import { awaitTurnEnd, chatInput } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, hostLogs, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { TARGET_USER } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

// The theme tools in a remote chat on an SSH target (docs/invariants.md "Remote daemon and wire", user.theme): the daemon's
// core reads a source on the target and sends its bytes in 4 MiB chunks to this computer, whose core alone writes themes; the
// card shows in the chat here, its Show in window turns off when this window's theme editor takes the window, and its Apply
// changes this computer's window on the word of this computer's main that Apply was pressed on its own page; an install
// card's Allow flashing allows the file on this computer; the target holds no theme files; with the group off here the tools
// say why.

const APP = '/srv/app';
const CHECKED = { timeout: 60_000 };
const ASSET_BYTES = 40 * 1024 * 1024;
const AMBER_BG = '#2a1a10';
const AMBER = { theme: 'damocles', saveAs: 'new', name: 'Amber Night', look: 'dark', colors: { background: AMBER_BG, accent: '#e0a030' } };
// a theme of this computer's own, whose editor preview takes the window from the remote card's Show in window
const BLEACH_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const BLEACH_BG = '#141413';
const BLEACH = {
  schemaVersion: 1, id: BLEACH_ID, name: 'Bleach (copy)',
  looks: { dark: { colors: { background: BLEACH_BG, panel: '#262624', text: '#e6e3da', accent: '#d97757', success: '#788c5d', warning: '#f0b429', danger: '#f2555a', info: '#6a9bcc' } } },
};
// the theme ThemeSet install downloads, which this computer reads from the e2e hooks' download folder
const INSTALL_FILE = 'aurora.damocles-theme';
const INSTALL_NAME = 'Aurora Borealis';
const INSTALL_THEME = { schemaVersion: 1, id: '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d', name: INSTALL_NAME, looks: { dark: { colors: BLEACH.looks.dark.colors } } };
// an install whose moving wallpaper flashes, which this computer's core checks and blocks until the card's Allow here
const FLASHING = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'desktop', 'fixtures', 'wallpapers', 'flash-4hz.png'));
const FLASHING_SHA = createHash('sha256').update(FLASHING).digest('hex');
const STROBE_FILE = 'strobe.damocles-theme';
const STROBE_NAME = 'Strobe';
const STROBE_THEME = {
  schemaVersion: 1, id: '0f6e2d4c-8b1a-4c3d-9e5f-a7b6c5d4e3f2', name: STROBE_NAME,
  looks: { dark: { colors: BLEACH.looks.dark.colors, wallpapers: [{ panels: { chat: { asset: FLASHING_SHA, fit: 'fill', dim: 0.5, blur: 4 } } }] } },
  assets: { [FLASHING_SHA]: { kind: 'animated', mime: 'image/png', bytes: FLASHING.length, width: 64, height: 64, frames: 16, license: {} } },
};
const installCard = (tab: Page, name = INSTALL_NAME): Locator => tab.getByRole('region', { name: `Install “${name}”?`, exact: true });
// what ToolSearch and the gate answer once the switch, read from this device, takes the group out of the remote chat
const OFF_HERE = 'The theme tools are off on your computer. Turn them on in Settings › Appearance there.';

/** Every tool result the model received, in order, as text. */
function toolResults(stub: OpenAIStub): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const request of chatRequests(stub)) {
    for (const message of (request.body as { messages?: { role: string; tool_call_id?: string; content: unknown }[] }).messages ?? []) {
      if (message.role !== 'tool' || message.tool_call_id === undefined || seen.has(message.tool_call_id)) continue;
      seen.add(message.tool_call_id);
      results.push(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
    }
  }
  return results;
}

async function turn(tab: Page, openai: OpenAIStub, prompt: string, ...replies: Parameters<OpenAIStub['replies']['push']>): Promise<void> {
  openai.replies.push(...replies);
  await chatInput(tab).fill(prompt);
  await chatInput(tab).press('Enter');
  await expect(chatInput(tab)).toHaveValue('');
  await expect(tab.getByText(`Echo: ${prompt}`, { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
}

const previewCard = (tab: Page): Locator => tab.getByRole('region', { name: 'Preview a new theme', exact: true });
const answers = (tab: Page): Locator => tab.getByRole('listbox', { name: 'Answer the theme preview', exact: true });

test('theme tools in a remote chat change this computer\'s app through the relay: a 40 MB asset crosses in chunks, Apply writes here, Allow flashing allows the file here, the target holds no theme, and the group off here says why', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(900_000);
  const fixture = await sshd('prod-1');
  const openai = await startTargetStub(home, fixture);
  try {
    writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.git.autofetch': false, 'damocles.pi.webSearch.enabled': true });
    writeTheme(home, BLEACH_ID, BLEACH);
    const downloads = path.join(home.root, 'theme-downloads');
    fs.mkdirSync(downloads, { recursive: true });
    fs.writeFileSync(path.join(downloads, INSTALL_FILE), zipSync({ 'theme.json': strToU8(JSON.stringify(INSTALL_THEME)) }));
    fs.writeFileSync(path.join(downloads, STROBE_FILE), zipSync({ 'theme.json': strToU8(JSON.stringify(STROBE_THEME)), [`assets/${FLASHING_SHA}.png`]: new Uint8Array(FLASHING) }));
    await fixture.sh([`mkdir -p ${APP}`, `head -c ${ASSET_BYTES} /dev/zero > ${APP}/huge.png`].join(' && '), TARGET_USER);
    const desktop = await launch({ env: { ...remoteEnv(ssh, mirror), DAMOCLES_E2E_HOOKS: '1', DAMOCLES_E2E_THEME_DOWNLOADS: downloads } });
    const hostId = await addHost(desktop.app, { alias: 'prod-1', name: 'prod-1' });
    await openRemoteFolder(desktop.app, hostId, APP);
    const key = await remoteProjectKey(desktop.app, { authorityKey: `ssh+${hostId}` }, APP);
    const tab = await newRemoteChat(desktop.app, key);

    // the device the turn is pinned to lists themes and has the group on, so the group loads
    await turn(tab, openai, 'Load the theme tools.', call('ToolSearch', { tools: ['theme'] }));
    expect(toolResults(openai).at(-1)).toMatch(/^Loaded \d+ tools: .*ThemeSet/);

    // the target reads its file, and its 40 MB cross in 4 MiB chunks to this computer's core, which checks and then refuses
    // them as no wallpaper; the connection stays up
    await turn(tab, openai, 'Use the huge picture.', call('ThemeSet', { name: 'Huge', look: 'dark', asset: { name: 'huge', from: { file: 'huge.png' } }, wallpapers: [{ panels: { chat: { image: 'huge' } } }] }));
    expect(toolResults(openai).at(-1)).toContain('The image was not used:');
    await expect.poll(() => mainLog(home), CHECKED).toContain(`[remote] user.theme.uploadChunk for ssh+${hostId}: complete, ${ASSET_BYTES} bytes`);
    expect(mainLog(home)).not.toContain('held frames over the bound');
    expect((await hostLogs(desktop.app, hostId)).daemon).not.toContain('held frames passed the per-connection bound');

    // the card shows in the remote chat here, the device the change lands on; Apply writes the theme on this computer
    openai.replies.push(call('ThemeSet', AMBER), { chunks: ['Applied from prod-1.'] });
    await chatInput(tab).fill('A warmer theme, please.');
    await chatInput(tab).press('Enter');
    await expect(previewCard(tab)).toBeVisible(CHECKED);
    await expect(tab.getByTestId('theme-change-other-device')).toHaveCount(0);

    // Show in window paints this window; the theme editor's preview takes it over, and the remote card hears it through
    // user.theme.showEnded: its toggle turns off with the note a local card shows
    const toggle = tab.getByRole('button', { name: 'Show in window', exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true', CHECKED);
    await expect.poll(() => windowBackground(desktop.app), CHECKED).toBe(AMBER_BG);
    // Settings opens on the remote chat's host tab; this computer's themes are in its User tab
    const overlay = await openSettingsModal(desktop.app);
    await overlay.getByTestId('settings-scope-user').click();
    await expect(overlay.getByTestId('settings-scope-user')).toHaveAttribute('aria-selected', 'true');
    await settingsNav(overlay, 'appearance').click();
    await overlay.getByRole('button', { name: `More actions for ${BLEACH.name}`, exact: true }).click();
    await overlay.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    const editor = await themeEditorPage(desktop.app);
    await dockShown(desktop.app);
    await expect.poll(() => windowBackground(desktop.app), CHECKED).toBe(BLEACH_BG);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false', CHECKED);
    await expect(tab.getByText('Another preview took over the window.', { exact: true })).toBeVisible();
    expect(mainLog(home)).not.toContain('[remote] the end of a theme card\'s Show in window');
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(async () => (await themeDockView(desktop.app))?.visible, CHECKED).toBe(false);
    await closeSettingsModal(await overlayPage(desktop.app));

    await answers(tab).getByRole('option', { name: 'Apply', exact: true }).click();
    await expect(tab.getByText('Applied from prod-1.', { exact: true })).toBeVisible(CHECKED);
    await awaitTurnEnd(tab);
    await expect.poll(() => windowBackground(desktop.app), CHECKED).toBe(AMBER_BG);
    // this computer's main saw both presses on its own page, and its core committed on that word alone
    expect(mainLog(home)).toContain(`[remote] user.theme.commit for ssh+${hostId}: Apply was pressed on this computer`);
    expect(mainLog(home)).not.toContain('[remote] user.theme.preview refused');
    const themesDir = path.join(home.damoclesDir, 'themes', 'themes');
    const names = fs.readdirSync(themesDir).map((id) => (JSON.parse(fs.readFileSync(path.join(themesDir, id, 'theme.json'), 'utf8')) as { name: string }).name);
    expect(names.sort()).toEqual(['Amber Night', BLEACH.name]);
    expect((await fixture.sh('test -e ~/.damocles/themes && echo present || echo absent', TARGET_USER)).trim()).toBe('absent');

    // ThemeSet install: this computer downloads the link, since its web search is on, and its card here installs it here
    openai.replies.push(call('ThemeSet', { install: { url: `https://e2e.test/${INSTALL_FILE}` } }), { chunks: ['Installed from prod-1.'] });
    await chatInput(tab).fill('Install the aurora theme.');
    await chatInput(tab).press('Enter');
    const install = installCard(tab);
    await expect(install).toBeVisible(CHECKED);
    await expect(install.getByTestId('theme-install-host')).toHaveText('e2e.test');
    await expect(install.getByTestId('theme-install-other-device')).toHaveCount(0);
    await expect(install.getByTestId('theme-install-go')).not.toHaveAttribute('aria-disabled', CHECKED);
    await install.getByTestId('theme-install-go').click();
    await expect(tab.getByText('Installed from prod-1.', { exact: true })).toBeVisible(CHECKED);
    await awaitTurnEnd(tab);
    expect(toolResults(openai).at(-1)).toContain('Installed: the user installed the theme');
    await expect.poll(() => mainLog(home), CHECKED).toContain(`[remote] user.theme.installCommit for ssh+${hostId}: Install was pressed on this computer`);
    const installedNames = fs.readdirSync(themesDir).map((id) => (JSON.parse(fs.readFileSync(path.join(themesDir, id, 'theme.json'), 'utf8')) as { name: string }).name);
    expect(installedNames.sort()).toEqual(['Amber Night', INSTALL_NAME, BLEACH.name].sort());
    expect((await fixture.sh('test -e ~/.damocles/themes && echo present || echo absent', TARGET_USER)).trim()).toBe('absent');

    // a flashing wallpaper: this computer's core checks it and the card blocks it; the press on this page goes through main
    // to this computer's core, never the chat's remote core, and that core's update reaches the card through the host
    openai.replies.push(call('ThemeSet', { install: { url: `https://e2e.test/${STROBE_FILE}` } }), { chunks: ['Strobe installed from prod-1.'] });
    await chatInput(tab).fill('Install the strobe theme.');
    await chatInput(tab).press('Enter');
    const strobe = installCard(tab, STROBE_NAME);
    await expect(strobe).toBeVisible(CHECKED);
    await expect(strobe.getByTestId('theme-install-go')).not.toHaveAttribute('aria-disabled', CHECKED);
    const blocked = strobe.getByTestId('theme-install-flash-blocked');
    await expect(blocked).toBeVisible({ timeout: 90_000 });
    await expect(blocked).toContainText('Blocked: flashes');
    const flashFile = path.join(home.damoclesDir, 'themes', 'cache', FLASHING_SHA, 'flash.json');
    expect(JSON.parse(fs.readFileSync(flashFile, 'utf8'))).not.toHaveProperty('allowed');
    await blocked.getByRole('button', { name: 'Allow flashing for this file', exact: true }).click();
    await expect(strobe.getByTestId('theme-install-flash-allowed')).toBeVisible(CHECKED);
    await expect(blocked).toBeHidden();
    expect(JSON.parse(fs.readFileSync(flashFile, 'utf8'))).toMatchObject({ flagged: true, allowed: true });
    await expect.poll(() => mainLog(home), CHECKED).toContain(`[remote] Allow flashing of ${FLASHING_SHA} from a chat on ssh+${hostId}: allowed`);
    await strobe.getByTestId('theme-install-go').click();
    await expect(tab.getByText('Strobe installed from prod-1.', { exact: true })).toBeVisible(CHECKED);
    await awaitTurnEnd(tab);
    expect(toolResults(openai).at(-1)).toContain('Installed: the user installed the theme');
    const withStrobe = fs.readdirSync(themesDir).map((id) => (JSON.parse(fs.readFileSync(path.join(themesDir, id, 'theme.json'), 'utf8')) as { name: string }).name);
    expect(withStrobe.sort()).toEqual(['Amber Night', INSTALL_NAME, STROBE_NAME, BLEACH.name].sort());
    expect((await fixture.sh('test -e ~/.damocles/themes && echo present || echo absent', TARGET_USER)).trim()).toBe('absent');

    // the group switched off on this computer: the remote core reads the switch from this device's settings, so ToolSearch no
    // longer loads the group, and a call already loaded never reaches a theme; nothing more is written here
    const written = fs.readdirSync(themesDir).length;
    writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.git.autofetch': false, 'damocles.desktop.themes.agentTools': false });
    let attempt = 0;
    await expect(async () => {
      attempt += 1;
      await turn(tab, openai, `Load the theme tools again (${attempt}).`, call('ToolSearch', { tools: ['theme'] }));
      expect(toolResults(openai).at(-1)).toContain(OFF_HERE);
    }).toPass({ timeout: 120_000 });
    await turn(tab, openai, 'Try a theme anyway.', call('ThemeSet', AMBER));
    // the switch takes the tools out of the chat's eligible set, so pi answers for a tool the chat no longer has
    expect(toolResults(openai).at(-1)).toBe('Tool ThemeSet not found');
    expect(fs.readdirSync(themesDir)).toHaveLength(written);

    await shutdownHostDaemon(desktop.app, hostId, fixture);
  } finally {
    await openai.close();
  }
});
