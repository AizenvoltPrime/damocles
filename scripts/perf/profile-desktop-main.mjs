// Usage: node scripts/perf/profile-desktop-main.mjs --seconds <n> [--from <userData>] [--project <folder>]
//          [--sessions <n>] [--out <dir>] [--interval-us <n>]
//
// Records a CPU profile of the desktop app's main process from its first instruction. It launches the dev build
// (run `npm run build:desktop` first, and on Windows `node scripts/brand-dev-electron.mjs`) with --inspect-brk and a fresh temporary --user-data-dir, starts V8's profiler
// over the Chrome DevTools Protocol before main runs, profiles for <n> seconds, writes main.cpuprofile to --out
// (default: the temporary folder) and closes the app. The packaged app cannot be profiled: its
// enableNodeCliInspectArguments fuse is off.
//
// --from copies projects.json, trusted-folders.json and window-layout.json from an existing userData folder, such as
// "%APPDATA%\damocles". --project with --sessions writes a panels.json that restores that many of the project's most
// recently modified sessions, so startup does a real restore. Sessions are read from ~/.damocles, which the dev build
// shares with every other Damocles app.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { devElectronDist } from '../dev-electron-binary.mjs';

const require = createRequire(import.meta.url);
const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const COPIED = ['projects.json', 'trusted-folders.json', 'window-layout.json'];
const INSPECTOR_WAIT_MS = 30_000;

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: node scripts/perf/profile-desktop-main.mjs --seconds <n> [--from <userData>] [--project <folder>] [--sessions <n>] [--out <dir>] [--interval-us <n>]');
  process.exit(1);
}

function parseArgs(argv) {
  const options = { sessions: 0, intervalUs: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (value === undefined) usage(`${argv[i]} needs a value`);
    switch (argv[i]) {
      case '--seconds': options.seconds = Number(value); break;
      case '--from': options.from = path.resolve(value); break;
      case '--project': options.project = path.resolve(value); break;
      case '--sessions': options.sessions = Number(value); break;
      case '--out': options.out = path.resolve(value); break;
      case '--interval-us': options.intervalUs = Number(value); break;
      default: usage(`unknown option ${argv[i]}`);
    }
    i++;
  }
  if (!(options.seconds > 0)) usage('--seconds must be a positive number');
  if (!Number.isInteger(options.sessions) || options.sessions < 0) usage('--sessions takes a whole number');
  if (options.sessions > 0 && !options.project) usage('--sessions needs --project');
  if (!Number.isInteger(options.intervalUs) || options.intervalUs <= 0) usage('--interval-us takes a positive whole number');
  return options;
}

// pi's session folder encoding, as src/core/pi-session/session-store/session-dir.ts writes it
function sessionDirOf(project) {
  const safe = `--${project.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return path.join(os.homedir(), '.damocles', 'pi', 'agent', 'sessions', safe);
}

const folderKey = (folder) => (process.platform === 'win32' ? folder.toLowerCase() : folder);

function newestSessions(project, count) {
  const dir = sessionDirOf(project);
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  return files
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, count)
    .map(({ name }) => name.slice(name.indexOf('_') + 1, -'.jsonl'.length));
}

function prepareUserData(options) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-prof-'));
  for (const name of COPIED) {
    if (options.from && fs.existsSync(path.join(options.from, name))) fs.copyFileSync(path.join(options.from, name), path.join(userData, name));
  }
  if (options.project) {
    const projectsFile = path.join(userData, 'projects.json');
    const projects = fs.existsSync(projectsFile) ? JSON.parse(fs.readFileSync(projectsFile, 'utf8')) : { version: 1, projects: [] };
    if (!projects.projects.some((folder) => folderKey(path.resolve(folder)) === folderKey(options.project))) projects.projects.push(options.project);
    fs.writeFileSync(projectsFile, `${JSON.stringify(projects, null, 2)}\n`);
  }
  if (options.sessions > 0) {
    const projectKey = folderKey(options.project);
    const chats = newestSessions(options.project, options.sessions).map((sessionId) => ({ panelId: randomUUID(), state: { sessionId, workspaceFolderKey: projectKey }, pages: [] }));
    const selected = chats[0] ? { projectKey, sessionId: chats[0].state.sessionId, panelId: chats[0].panelId } : { projectKey };
    fs.writeFileSync(path.join(userData, 'panels.json'), `${JSON.stringify({ version: 2, selected, chats }, null, 2)}\n`);
    console.log(`restoring ${chats.length} sessions of ${options.project}`);
  }
  return userData;
}

function launch(userData) {
  const env = { ...process.env };
  // A shell started from an editor's extension host inherits this, which would start the binary as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.platform === 'win32') process.env.ELECTRON_OVERRIDE_DIST_PATH = devElectronDist(path.dirname(require.resolve('electron/package.json')));
  const electronBinary = require('electron');
  const main = path.join(repoRoot, 'dist', 'desktop', 'main.js');
  if (!fs.existsSync(main)) usage(`${main} is missing; run npm run build:desktop first`);
  // POSIX: its own process group, so killTree reaches the GPU, network and renderer processes too
  const child = spawn(electronBinary, ['--inspect-brk=0', main, `--user-data-dir=${userData}`], { env, stdio: ['ignore', 'inherit', 'pipe'], detached: process.platform !== 'win32' });
  // On Windows the binary is the branded copy that only scripts/brand-dev-electron.mjs writes.
  child.once('error', (err) => usage(`could not start ${electronBinary}: ${err.message}; run node scripts/brand-dev-electron.mjs first`));
  return child;
}

function inspectorUrl(child) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('the app printed no inspector address')), INSPECTOR_WAIT_MS);
    child.stderr.on('data', (chunk) => {
      text += chunk;
      process.stderr.write(chunk);
      const match = /Debugger listening on (ws:\/\/\S+)/.exec(text);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('exit', (code) => reject(new Error(`the app exited with code ${code} before its inspector opened`)));
  });
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    // Under --inspect-brk every worker thread also waits for a debugger, and main waits on its workers. Node 24 reports
    // waitingForDebugger: false for such a worker, which still runs only once released.
    if (message.method === 'NodeWorker.attachedToWorker') {
      const run = JSON.stringify({ id: 1, method: 'Runtime.runIfWaitingForDebugger' });
      socket.send(JSON.stringify({ id: nextId++, method: 'NodeWorker.sendMessageToWorker', params: { sessionId: message.params.sessionId, message: run } }));
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
    else waiter.resolve(message.result);
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)), { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { opened, send, close: () => socket.close() };
}

// Electron leaves its GPU, network and renderer processes running when only the main process is killed.
function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else process.kill(-child.pid, 'SIGKILL');
}

const options = parseArgs(process.argv.slice(2));
const userData = prepareUserData(options);
const out = options.out ?? userData;
fs.mkdirSync(out, { recursive: true });
console.log(`userData: ${userData}`);
const child = launch(userData);
try {
  const cdp = connect(await inspectorUrl(child));
  await cdp.opened;
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: options.intervalUs });
  await cdp.send('Profiler.start');
  await cdp.send('NodeWorker.enable', { waitForDebuggerOnStart: false });
  await cdp.send('Runtime.runIfWaitingForDebugger');
  console.log(`profiling the main process for ${options.seconds} s`);
  await new Promise((resolve) => setTimeout(resolve, options.seconds * 1000));
  const { profile } = await cdp.send('Profiler.stop');
  const file = path.join(out, 'main.cpuprofile');
  fs.writeFileSync(file, JSON.stringify(profile));
  console.log(`wrote ${file}`);
  cdp.close();
} finally {
  killTree(child);
}
