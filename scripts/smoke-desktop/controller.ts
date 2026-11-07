// Keeps one dev desktop app running and runs the step files post.ts sends against it; see README.md.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { devElectronDist } from '../dev-electron-binary.ts';
import { createHelpers, type Helpers } from './helpers.ts';
import { smokeEnv, type SmokeHome } from './hermetic.ts';
import { smokeDir, smokePort, TOKEN_HEADER, tokenFile } from './paths.ts';
import { createSmokeSession, killTree } from './session.ts';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
if (process.platform === 'win32') {
  process.env.ELECTRON_OVERRIDE_DIST_PATH = devElectronDist(path.dirname(require.resolve('electron/package.json')));
}
// Loaded after ELECTRON_OVERRIDE_DIST_PATH is set, which a hoisted import would precede.
const { _electron }: typeof import('@playwright/test') = require('@playwright/test');

const dir = smokeDir();
fs.mkdirSync(dir, { recursive: true });
// Steps run as code inside the app's main process with the user's sign-in, so only a caller that can read this file may post them.
const token = randomBytes(32);
fs.writeFileSync(tokenFile(dir), token.toString('hex'), { mode: 0o600 });

const output: string[] = [];

async function launchApp(home: SmokeHome) {
  // The allowlisted environment leaves out ELECTRON_RUN_AS_NODE, which would start the binary as plain Node.
  const electron = await _electron.launch({
    args: [path.join(repoRoot, 'dist', 'desktop', 'main.js'), '--user-data-dir', home.userData],
    cwd: home.root,
    env: smokeEnv(home),
  });
  const proc = electron.process();
  proc.stdout?.on('data', (d: Buffer) => output.push(String(d)));
  proc.stderr?.on('data', (d: Buffer) => output.push(String(d)));
  const exited = proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise((resolve) => proc.once('exit', resolve));
  return { electron, exited, close: () => electron.close(), kill: () => killTree(proc, exited) };
}

const session = createSmokeSession({ dir, realHome: os.homedir(), realLocalAppData: process.env.LOCALAPPDATA, launchApp });
const helpers = createHelpers(() => {
  const app = session.current()?.electron;
  if (!app) throw new Error('The app is not running; post --launch or --relaunch first.');
  return app;
}, dir, session.home);

function authorized(req: http.IncomingMessage): boolean {
  const sent = Buffer.from(String(req.headers[TOKEN_HEADER] ?? ''), 'hex');
  return sent.length === token.length && timingSafeEqual(sent, token);
}

const AsyncFunction: new (param: string, body: string) => (h: Helpers) => Promise<unknown> = Object.getPrototypeOf(async () => {}).constructor;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => { body += chunk; });
  req.on('end', async () => {
    if (req.method !== 'POST' || !authorized(req)) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    try {
      let result: unknown;
      if (req.url === '/launch') {
        const launched = await session.launch();
        if ('notices' in launched) for (const notice of launched.notices) console.warn(notice);
        result = launched;
      } else if (req.url === '/relaunch') result = await session.relaunch();
      else if (req.url === '/log') result = output.splice(0).join('').slice(-8000);
      else if (req.url === '/quit') {
        server.close();
        fs.rmSync(tokenFile(dir), { force: true });
        result = await session.quit();
      } else if (req.url === '/run') result = await new AsyncFunction('h', body)(helpers);
      else {
        res.statusCode = 404;
        res.end('unknown endpoint');
        return;
      }
      res.end(JSON.stringify(result ?? null, null, 1));
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err instanceof Error ? (err.stack ?? err) : err));
    }
  });
});

server.listen(smokePort(), '127.0.0.1', () => console.log(`smoke controller on 127.0.0.1:${smokePort()}, scratch folder ${dir}`));
