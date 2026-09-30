import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installFakePlatform, type FakePanelHost, type FakePlatform } from '../../../src/__mocks__/fake-platform';
import { ChatPanelProvider } from '../../../src/core/chat-panel';
import { installLogSink } from '../../../src/core/logger';
import { PI_AGENT_DIR } from '../../../src/core/pi-session/agent-dir';
import type { ChildCommand, ChildEvent, ChildReply } from './protocol';

// A headless second Damocles host: core with fake platform objects, driven over the fork IPC channel.

const [folder, appRoot, settingsJson] = process.argv.slice(2);
if (!folder || !appRoot || !settingsJson) throw new Error('usage: child <folder|-> <appRoot> <user settings JSON>');

installLogSink({
  appendLine: (line) => process.stderr.write(`[second-process] ${line}\n`),
  show: () => {},
  dispose: () => {},
});

const platform: FakePlatform = installFakePlatform({
  // '-' opens no folder, so the panel targets the home directory as a host with no project does.
  folders: folder === '-' ? [] : [{ fsPath: folder, name: path.basename(folder) }],
  appRoot,
  trusted: true,
  settings: { user: JSON.parse(settingsJson) as Record<string, unknown> },
  version: '0.0.0-second-process',
});

const provider = new ChatPanelProvider(platform, {
  subscriptions: [],
  createCompassViews: () => ({ register: () => {}, setActive: () => {}, dispose: () => {} }),
});

function send(message: ChildEvent | ChildReply): void {
  process.send?.(message);
}

function panel(): FakePanelHost {
  const p = platform.window.panels.at(-1);
  if (!p) throw new Error('no panel open; send openPanel first');
  return p;
}

// Every panel message is forwarded to the parent as it is posted, so specs can wait on it.
function forwardPosts<T extends { postMessage(message: unknown): unknown }>(host: T): T {
  const post = host.postMessage.bind(host);
  host.postMessage = (message: unknown) => {
    const result = post(message);
    send({ kind: 'posted', message });
    return result;
  };
  return host;
}
const createPanel = platform.window.createPanel.bind(platform.window);
const createPanelInOwnColumn = platform.window.createPanelInOwnColumn.bind(platform.window);
Object.assign(platform.window, {
  createPanel: (opts: Parameters<typeof createPanel>[0]) => forwardPosts(createPanel(opts)),
  createPanelInOwnColumn: async (opts: Parameters<typeof createPanelInOwnColumn>[0]) => forwardPosts(await createPanelInOwnColumn(opts)),
});

type AuthBackend = { withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T };
async function authBackend(): Promise<AuthBackend> {
  // pi's own locked writer; its package exports map hides the module, so it is imported by file URL.
  const file = path.join(appRoot!, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'auth-storage.js');
  const mod = (await import(pathToFileURL(file).href)) as { FileAuthStorageBackend: new (authPath: string) => AuthBackend };
  return new mod.FileAuthStorageBackend(path.join(PI_AGENT_DIR, 'auth.json'));
}

async function run(cmd: ChildCommand): Promise<unknown> {
  switch (cmd.cmd) {
    case 'openPanel':
      await provider.show();
      panel().fireMessage({ type: 'ready' });
      return { panels: platform.window.panels.length };
    case 'webviewMessage':
      panel().fireMessage(cmd.message);
      return null;
    case 'notifications':
      return platform.notifications.calls.map((c) => c.message);
    case 'writeAuth': {
      const backend = await authBackend();
      backend.withLock((current) => {
        const parsed = current ? (JSON.parse(current) as Record<string, unknown>) : {};
        return { result: undefined, next: JSON.stringify({ ...parsed, [cmd.provider]: cmd.credential }, null, 2) };
      });
      return fs.readFileSync(path.join(PI_AGENT_DIR, 'auth.json'), 'utf8').length;
    }
    case 'dispose':
      await provider.dispose();
      return null;
  }
}

process.on('message', (raw: unknown) => {
  const cmd = raw as ChildCommand & { id: number };
  run(cmd).then(
    (result) => {
      send({ kind: 'reply', id: cmd.id, ok: true, result });
    },
    (err: unknown) => send({ kind: 'reply', id: cmd.id, ok: false, error: err instanceof Error ? (err.stack ?? err.message) : String(err) }),
  );
});

send({ kind: 'ready', pid: process.pid });
