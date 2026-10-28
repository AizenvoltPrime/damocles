import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_GRID_LAYOUT, MIN_SIDEBAR_WIDTH } from '../../../src/desktop/preload/shell-channels';
import { expect, test } from '../support/fixtures';
import type { HermeticHome } from '../support/hermetic';
import { showView } from '../support/projects';
import { settled, showShellTheme, THEMES } from '../support/screenshots';
import { projectsList, readyShell, sectionAction } from '../support/shell-ui';
import type { DesktopApp, LaunchOptions } from '../support/app';

// Review captures of the Projects section's Flat and By host views in both themes, not tests: only the screenshots project matches them.
const SHOTS = process.env['DAMOCLES_PROJECT_SHOTS'] ?? path.join(os.tmpdir(), 'damocles-project-views');
const HOST = 'h0e2eshots';

// Two local projects and a saved host with two projects that this launch never connects, so its group shows offline.
function seed(home: HermeticHome, sidebarWidth?: number): void {
  const parent = path.dirname(home.project);
  const folders = ['alpha', 'beta'].map((name) => path.join(parent, name));
  for (const folder of folders) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(home.userData, 'projects.json'), JSON.stringify({ version: 1, projects: folders }));
  fs.writeFileSync(path.join(home.userData, 'remote-hosts.json'), JSON.stringify({
    version: 1,
    authorities: { [`ssh+${HOST}`]: { projects: [{ path: '/srv/app', folderKey: '/srv/app', os: 'linux' }, { path: '/srv/billing', folderKey: '/srv/billing', os: 'linux' }], trusted: [] } },
    order: [],
    hosts: { [HOST]: { id: HOST, kind: 'ssh', destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1', recentFolders: [], settings: {} } },
    groupOrder: [],
  }));
  // room for every row of both views
  const collapsed = { collapsed: true, size: 200 };
  fs.writeFileSync(path.join(home.userData, 'window-layout.json'), JSON.stringify({
    version: 2,
    sidebar: {
      sidebarVisible: true,
      sidebarWidth: sidebarWidth ?? 264,
      sections: { projects: { collapsed: false, size: 320 }, chats: { collapsed: false }, files: collapsed, search: collapsed, repos: collapsed, scm: collapsed, graph: collapsed },
      grid: DEFAULT_GRID_LAYOUT,
    },
  }));
}

async function capture(launch: (options?: LaunchOptions) => Promise<DesktopApp>, name: string): Promise<void> {
  const { app } = await launch();
  const shell = await readyShell(app);
  await expect(projectsList(shell).locator('[role="option"][data-project-key]')).toHaveCount(4);
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const view of ['flat', 'grouped'] as const) {
    await showView(shell, view);
    for (const theme of THEMES) {
      await showShellTheme(app, theme);
      await settled(shell);
      await shell.getByTestId('sidebar').screenshot({ path: path.join(SHOTS, `${name}-${view}-${theme}.png`), animations: 'disabled' });
      // the header's Connect to host and Open a project folder, revealed by hover
      await sectionAction(shell, 'connect-host');
      await settled(shell);
      await shell.getByTestId('sidebar').screenshot({ path: path.join(SHOTS, `${name}-${view}-${theme}-actions.png`), animations: 'disabled' });
      await shell.getByTestId('breadcrumb').hover();
    }
  }
}

test('Projects section, Flat and By host', async ({ foreground: _foreground, home, launch }) => {
  seed(home);
  await capture(launch, 'projects');
});

test('Projects section at the narrowest sidebar, Flat and By host', async ({ foreground: _foreground, home, launch }) => {
  seed(home, MIN_SIDEBAR_WIDTH);
  await capture(launch, 'projects-narrowest');
});
