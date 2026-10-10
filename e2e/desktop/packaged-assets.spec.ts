import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { asarFiles, readAsarHeader } from '../../scripts/asar-archive.mjs';
import { DESKTOP_FONT_FILES, DESKTOP_FONT_LICENSES } from '../../src/desktop/main/desktop-fonts';
import { logBeforeQuit, mainLog } from './support/app';
import { filesRow, quickPick } from './support/editor';
import { activeChat, expect, test } from './support/fixtures';
import { REPO_ROOT, seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { chatRequests, startOpenAIStub } from './support/openai-stub';
import { readyOverlay } from './support/overlay';
import { packagedAppPath } from './support/packaged-app';
import { popupPage, popupToasts, shellPage } from './support/shell';
import { activeTerminal, echoCommand, runInTerminal, terminalText, useTestProfile } from './support/terminal';
import { chatInput, hostMessages, postFromWebview, recordHostMessages } from './support/ui';

// One file per bundled tree-sitter grammar whose extraction has no fallback, each defining a symbol named probe_<language>.
const GRAMMAR_SAMPLES: Record<string, string> = {
  'probe.py': 'def probe_python():\n    return 1\n',
  'probe.js': 'function probe_javascript() { return 1; }\n',
  'probe.ts': 'export function probe_typescript(): number { return 1; }\n',
  'probe.tsx': 'export function probe_tsx() { return <div />; }\n',
  'probe.go': 'package main\n\nfunc probe_go() int { return 1 }\n',
  'probe.rs': 'fn probe_rust() -> i32 { 1 }\n',
  'Probe.java': 'class Probe { int probe_java() { return 1; } }\n',
  'probe.c': 'int probe_c(void) { return 1; }\n',
  'probe.cpp': 'int probe_cpp() { return 1; }\n',
  'probe.rb': 'def probe_ruby\n  1\nend\n',
  'Probe.cs': 'class Probe { int probe_csharp() { return 1; } }\n',
  'probe.kt': 'fun probe_kotlin(): Int = 1\n',
  'probe.scala': 'object Probe { def probe_scala(): Int = 1 }\n',
  'probe.php': '<?php\nfunction probe_php() { return 1; }\n',
  'Probe.vue': '<script setup lang="ts">\nfunction probe_vue(): number { return 1; }\n</script>\n',
};

// The overlay's preload and page, and the desktop fonts with their OFL texts, which ship only in the desktop build.
const SHELL_FILES = [
  'dist/desktop/preload-overlay.js',
  'dist/desktop-shell/assets/overlay.js',
  'dist/desktop-shell/assets/overlay.css',
  ...[...DESKTOP_FONT_FILES, ...DESKTOP_FONT_LICENSES].map((file) => `dist/desktop-shell/fonts/${file.output}`),
];

/** The SHELL_FILES the app under test lacks: inside app.asar for a packaged app, else in the repo's build output. */
function missingShellFiles(): string[] {
  const executable = packagedAppPath();
  if (executable === undefined) return SHELL_FILES.filter((file) => !fs.existsSync(path.join(REPO_ROOT, file)));
  const resources = process.platform === 'darwin' ? path.join(path.dirname(executable), '..', 'Resources') : path.join(path.dirname(executable), 'resources');
  const packed = new Set(asarFiles(readAsarHeader(path.join(resources, 'app.asar')).header).map((file: { path: string }) => file.path));
  return SHELL_FILES.filter((file) => !packed.has(file));
}

// The only Damocles files userData may hold: window and tab state, the trust store, the project list, encrypted secrets and logs.
const USER_DATA_JSON = new Set(['panels.json', 'projects.json', 'trusted-folders.json', 'secrets.json']);
const USER_DATA_STATE = new Set(['global.json', 'workspace.json']);

/** Lists the project and trusts it, as a previous run that added and trusted it would have left userData. */
function seedTrustedProject(h: HermeticHome): void {
  fs.writeFileSync(path.join(h.userData, 'projects.json'), JSON.stringify({ version: 1, projects: [h.project] }));
  fs.writeFileSync(path.join(h.userData, 'trusted-folders.json'), JSON.stringify({ version: 1, folders: [h.project] }));
}

/** Sample files that have at least one parsed symbol (not just a File node) in the project's Compass index. */
function parsedSamples(h: HermeticHome): string[] {
  const hash = createHash('sha256').update(h.project).digest('hex').slice(0, 12);
  const dbPath = path.join(h.damoclesDir, 'compass', hash, 'graph.db');
  if (!fs.existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT DISTINCT file_path FROM nodes WHERE kind <> 'File' AND name LIKE 'probe%'").all() as { file_path: string }[];
    return rows.map((row) => path.basename(row.file_path)).sort();
  } catch (err) {
    // The worker creates the schema on its first write; until then the file can exist without the table.
    if (err instanceof Error && /no such table/.test(err.message)) return [];
    throw err;
  } finally {
    db.close();
  }
}

/** Command lines of running shell sentinels whose environment carries this test's home, so parallel tests never count. */
function sentinelsOf(h: HermeticHome): string[] {
  const isSentinel = (args: string): boolean => args.includes(`${path.sep}dist${path.sep}sentinel.js`);
  if (process.platform === 'darwin') {
    return execFileSync('ps', ['-A', '-E', '-ww', '-o', 'args'], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => isSentinel(line) && line.includes(`HOME=${h.home}`));
  }
  const found: string[] = [];
  for (const pid of fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    let args: string;
    let environ: string[];
    try {
      args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
      environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    } catch (err) {
      // A process that exits between the listing and the read, or one owned by another user.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'EACCES' || (err as NodeJS.ErrnoException).code === 'ESRCH') continue;
      throw err;
    }
    if (isSentinel(args) && environ.includes(`HOME=${h.home}`)) found.push(args);
  }
  return found;
}

function checkpointRepos(h: HermeticHome): string[] {
  const base = path.join(h.damoclesDir, 'pi', 'checkpoints', 'folders');
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === 'HEAD' && path.basename(entry.parentPath) === '.git')
    .map((entry) => entry.parentPath);
}

test('bundled assets resolve: first window, overlay, fonts, pi chat, shell, ripgrep, git, compass grammars, usage stats worker, voice package, data home', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    seedTrustedProject(home);
    writeUserSettings(home, { 'damocles.compass.enabled': true, 'damocles.dangerouslySkipPermissions': true });
    for (const [name, source] of Object.entries(GRAMMAR_SAMPLES)) fs.writeFileSync(path.join(home.project, name), source);

    const desktop = await launch();
    const { app } = desktop;
    const tab = await activeChat(app);
    await expect(chatInput(tab)).toBeVisible();
    await recordHostMessages(tab);

    // The overlay page runs on its own preload, script and stylesheet; the fonts and their licences ship beside it.
    expect(missingShellFiles()).toEqual([]);
    const overlay = await readyOverlay(app);
    await (await shellPage(app)).getByTestId('notification-bell').click();
    await expect(overlay.getByTestId('overlay-backdrop')).toHaveCSS('position', 'fixed');
    await overlay.keyboard.press('Escape');
    await expect(overlay.getByTestId('overlay-backdrop')).toHaveCount(0);

    // The popup window loads the same bundle on its own route: a notice for the chat, which has no conversation yet.
    await postFromWebview(tab, { type: 'openSessionLog' });
    const popup = await popupPage(app);
    await expect(popupToasts(popup).filter({ hasText: 'No active session to view' })).toBeVisible();
    await expect(popup.getByTestId('overlay-toasts')).toHaveCSS('position', 'fixed');

    // pi against the stub, the shell tool (koffi job objects on Windows, the ELECTRON_RUN_AS_NODE sentinel elsewhere) and a write that git checkpoints.
    stub.replies.push({
      chunks: [],
      toolCalls: [
        { name: 'bash', arguments: { command: 'echo packaged-shell-ok' } },
        { name: 'write', arguments: { path: 'written-by-agent.txt', content: 'from the agent' } },
      ],
    });
    stub.replies.push({ chunks: ['Both tools ran.'] });
    await chatInput(tab).fill('Run the probes');
    await chatInput(tab).press('Enter');
    await expect(tab.getByText('Both tools ran.')).toBeVisible();
    const toolResults = JSON.stringify((chatRequests(stub)[1]?.body as { messages?: unknown } | undefined)?.messages ?? []);
    expect(toolResults).toContain('packaged-shell-ok');
    expect(fs.readFileSync(path.join(home.project, 'written-by-agent.txt'), 'utf8')).toBe('from the agent');
    await expect.poll(() => mainLog(home)).toMatch(/\[git\] git version /);
    // The POSIX sentinel is the app binary running dist/sentinel.js as Node, which needs the runAsNode fuse.
    if (process.platform !== 'win32') expect(sentinelsOf(home).length, 'a shell sentinel running on this home').toBeGreaterThan(0);
    await expect.poll(() => checkpointRepos(home).length, { timeout: 30_000 }).toBeGreaterThan(0);

    // ripgrep lists the project's files for @ mentions.
    await postFromWebview(tab, { type: 'requestWorkspaceFiles' });
    await expect
      .poll(async () => {
        const replies = await hostMessages(tab, 'workspaceFiles');
        const files = (replies.at(-1)?.files ?? []) as { relativePath: string }[];
        return files.map((file) => file.relativePath);
      })
      .toEqual(expect.arrayContaining(['probe.py', 'Probe.vue', 'written-by-agent.txt']));

    // The compass worker loads every grammar from the unpacked resources and indexes the project.
    await postFromWebview(tab, { type: 'compassSearch', query: 'probe' });
    await expect.poll(() => parsedSamples(home), { timeout: 120_000, intervals: [1_000] }).toEqual(Object.keys(GRAMMAR_SAMPLES).sort());

    // The usage stats worker builds its index from the session files the chat wrote.
    const requestId = 'packaged-usage';
    await postFromWebview(tab, {
      type: 'requestUsageStats',
      requestId,
      query: { startMs: 0, endMs: Date.now() + 86_400_000, previous: null, modelKeys: [], projectKeys: [], bucket: 'day', timeZone: 'UTC', scan: true },
    });
    await expect
      .poll(async () => (await hostMessages(tab, 'usageStats')).find((m) => m.requestId === requestId && m.final === true), { timeout: 60_000 })
      .toBeTruthy();
    const usage = (await hostMessages(tab, 'usageStats')).find((m) => m.requestId === requestId && m.final === true)!;
    expect(usage.error).toBeUndefined();
    expect((usage.report as { totals: { requests: number } }).totals.requests).toBeGreaterThan(0);

    // The voice manifest resolves inside the unpacked Python package; voice is hidden on macOS.
    if (process.platform !== 'darwin') {
      await postFromWebview(tab, { type: 'voiceFreeDiskSpace' });
      await expect
        .poll(async () => (await hostMessages(tab, 'voiceSidecarStatus')).map((m) => `${String(m.state)}: ${String(m.message)}`), { timeout: 30_000 })
        .toContainEqual(expect.stringMatching(/^stopped: Removed \d+ old model directories/));
    }

    // Data lives in the shared ~/.damocles; userData holds only the desktop's own state beside Chromium's.
    expect(fs.readdirSync(path.join(home.damoclesDir, 'pi', 'agent', 'sessions')).length).toBeGreaterThan(0);
    const damoclesEntries = new Set(fs.readdirSync(home.damoclesDir));
    const userDataEntries = fs.readdirSync(home.userData);
    expect(userDataEntries.filter((name) => damoclesEntries.has(name))).toEqual([]);
    expect(userDataEntries.filter((name) => name.endsWith('.json') && !USER_DATA_JSON.has(name))).toEqual([]);
    const stateDir = path.join(home.userData, 'state');
    const stateEntries = fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : [];
    expect(stateEntries.filter((name) => !USER_DATA_STATE.has(name))).toEqual([]);
    expect(fs.existsSync(path.join(home.userData, 'logs', 'Damocles.log'))).toBe(true);
    await desktop.close();
    expect(logBeforeQuit(home)).not.toContain('[ShellSentinel] ERROR');
  } finally {
    await stub.close();
  }
});

test('the formatter host loads from the build and formats a file with the project\'s Prettier', async ({ home, launch }) => {
  seedTrustedProject(home);
  const packageDir = path.join(home.project, 'node_modules', 'prettier');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'prettier-stub', 'index.js'), path.join(packageDir, 'index.js'));
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'prettier', version: '3.3.3', main: 'index.js' }));
  fs.writeFileSync(path.join(home.project, 'a.ts'), 'const a=1\n');
  const { app } = await launch();
  const shell = await shellPage(app);
  // Through the shell's own bridge, as Format Document does: main resolves the Prettier and runs it in the utility process.
  await expect.poll(() => shell.evaluate(async (project) => {
    const api = window.damoclesShell!;
    const key = (await api.getState()).projects.find((candidate) => candidate.fsPath === project)?.key;
    if (key === undefined) return undefined;
    await api.openEditor({ projectKey: key, relativePath: 'a.ts' });
    const tab = (await api.getEditorState()).tabs.find((candidate) => candidate.title === 'a.ts');
    if (tab?.documentId === undefined) return undefined;
    return api.formatDocument({ documentId: tab.documentId, text: 'const a=1\n', options: { tabSize: 2, insertSpaces: true }, reason: 'command' });
  }, home.project), { timeout: 60_000 }).toEqual({ kind: 'formatted', text: 'const a = 1;\n' });
});

test('Quick Open lists and scores the project\'s files in the build\'s worker thread', async ({ home, launch }) => {
  seedTrustedProject(home);
  fs.mkdirSync(path.join(home.project, 'src', 'routes'), { recursive: true });
  fs.writeFileSync(path.join(home.project, 'src', 'routes', 'packaged-probe.ts'), 'export {};\n');
  const desktop = await launch();
  const { app } = desktop;
  const shell = await shellPage(app);
  const overlay = await readyOverlay(app);
  // The title bar's search box, through the shell bridge, since a packaged app exposes no main process.
  await shell.evaluate(() => {
    void window.damoclesShell!.openQuickOpen();
  });
  await expect(quickPick(overlay)).toBeVisible();
  await overlay.getByTestId('quick-pick-input').fill('packaged-probe');
  await expect(quickPick(overlay).getByTestId('quick-pick-item').first()).toContainText('packaged-probe.ts', { timeout: 30_000 });
  await overlay.getByTestId('quick-pick-input').press('Escape');
  await expect(quickPick(overlay)).toHaveCount(0);
  await desktop.close();
  expect(logBeforeQuit(home)).not.toContain('[quick-open]');
});

test('the watch worker loads from the build and a file created under the project reaches the Files tree', async ({ home, launch }) => {
  test.skip(process.platform !== 'win32', 'only Windows runs its recursive watches on the watch worker');
  seedTrustedProject(home);
  fs.writeFileSync(path.join(home.project, 'present.txt'), 'x');
  const desktop = await launch();
  const shell = await shellPage(desktop.app);
  await expect(filesRow(shell, 'present.txt')).toBeVisible({ timeout: 30_000 });
  // The worker's first scan records without reporting whatever it lists, so a fresh name is written until one is reported.
  const probes = shell.locator('[data-testid="files-row"][data-tree-path^="watch-probe-"]');
  let attempt = 0;
  await expect.poll(async () => {
    fs.writeFileSync(path.join(home.project, `watch-probe-${attempt++}.txt`), 'x');
    return probes.count();
  }, { timeout: 60_000, intervals: [1_000] }).toBeGreaterThan(0);
  await desktop.close();
  expect(logBeforeQuit(home)).not.toContain('[watcher] the watch worker');
});

test('the pty host loads node-pty from the build and a shell echoes into the terminal', async ({ home, launch }) => {
  seedTrustedProject(home);
  useTestProfile(home);
  const { app } = await launch();
  const shell = await shellPage(app);
  // Toggle Terminal through the shell bridge, since a packaged app exposes no main process: with no terminal, main starts one in the
  // current project, once the shells are detected (wsl.exe -l alone can take seconds).
  await expect.poll(async () => (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).canCreate, { timeout: 60_000 }).toBe(true);
  await shell.evaluate(() => window.damoclesShell!.toggleTerminal());
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
  await runInTerminal(shell, echoCommand('packaged-pty-marker'));
  await expect.poll(() => terminalText(shell)).toContain('packaged-pty-marker');
});

test('a shell starts with the build\'s own integration script and reports a running command to main', async ({ home, launch }) => {
  seedTrustedProject(home);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': process.platform === 'win32' ? 'windows-powershell' : 'bash' });
  // Windows PowerShell finds its PSReadLine under Program Files, which the hermetic environment leaves out; the inbox 2.0.0 it
  // falls back to fails without the user's environment, and only PSReadLine sends the command line.
  const programFiles = process.env['ProgramFiles'];
  const { app } = await launch(process.platform === 'win32' && programFiles !== undefined ? { env: { ProgramFiles: programFiles } } : {});
  const shell = await shellPage(app);
  await expect.poll(async () => (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).canCreate, { timeout: 60_000 }).toBe(true);
  await shell.evaluate(() => window.damoclesShell!.toggleTerminal());
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
  const info = async () => (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals[0]!;
  await expect.poll(async () => (await info()).integrated, { timeout: 60_000 }).toBe(true);
  const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 3' : 'sleep 3';
  await runInTerminal(shell, command);
  await expect.poll(async () => (await info()).running).toBe(command);
  await expect.poll(async () => (await info()).running, { timeout: 15_000 }).toBeNull();
});
