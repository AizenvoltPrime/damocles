import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { asarFiles, readAsarHeader } from '../../scripts/asar-archive.mjs';
import { DESKTOP_FONT_FILES, DESKTOP_FONT_LICENSES } from '../../src/desktop/main/desktop-fonts';
import { mainLog } from './support/app';
import { activeChat, expect, test } from './support/fixtures';
import { REPO_ROOT, seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { chatRequests, startOpenAIStub } from './support/openai-stub';
import { readyOverlay } from './support/overlay';
import { packagedAppPath } from './support/packaged-app';
import { popupPage, popupToasts, shellPage } from './support/shell';
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

    const { app } = await launch();
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
    expect(mainLog(home)).toMatch(/\[git\] git version /);
    expect(mainLog(home)).not.toContain('[ShellSentinel] ERROR');
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
  } finally {
    await stub.close();
  }
});
