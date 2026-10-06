// Keeps one dev desktop app running and runs the step files post.mjs sends against it; see README.md.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { devElectronDist } from '../dev-electron-binary.mjs';
import { createHelpers } from './helpers.mjs';
import { smokeDir, smokePort, TOKEN_HEADER, tokenFile } from './paths.mjs';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
if (process.platform === 'win32') {
  process.env.ELECTRON_OVERRIDE_DIST_PATH = devElectronDist(path.dirname(require.resolve('electron/package.json')));
}
const { _electron } = require('@playwright/test');

const dir = smokeDir();
fs.mkdirSync(dir, { recursive: true });
// Steps run as code inside the app's main process with the user's sign-in, so only a caller that can read this file may post them.
const token = randomBytes(32);
fs.writeFileSync(tokenFile(dir), token.toString('hex'), { mode: 0o600 });

let app;
const output = [];
const helpers = createHelpers(() => {
  if (!app) throw new Error('The app is not running; post --launch first.');
  return app;
}, dir);

async function launch() {
  if (app) return { ok: true, alreadyRunning: true };
  // A shell spawned from an editor's extension host inherits ELECTRON_RUN_AS_NODE=1, which would start the binary as plain Node.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    args: [path.join(repoRoot, 'dist', 'desktop', 'main.js'), '--user-data-dir', path.join(dir, 'userData')],
    cwd: repoRoot,
    env,
  });
  app.process().stdout?.on('data', (d) => output.push(String(d)));
  app.process().stderr?.on('data', (d) => output.push(String(d)));
  app.on('close', () => { app = undefined; });
  return { ok: true };
}

function authorized(req) {
  const sent = Buffer.from(String(req.headers[TOKEN_HEADER] ?? ''), 'hex');
  return sent.length === token.length && timingSafeEqual(sent, token);
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    if (req.method !== 'POST' || !authorized(req)) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    try {
      let result;
      if (req.url === '/launch') result = await launch();
      else if (req.url === '/log') result = output.splice(0).join('').slice(-8000);
      else if (req.url === '/quit') {
        await app?.close();
        res.end('"closed"');
        server.close();
        fs.rmSync(tokenFile(dir), { force: true });
        return;
      } else if (req.url === '/run') result = await new AsyncFunction('h', body)(helpers);
      else {
        res.statusCode = 404;
        res.end('unknown endpoint');
        return;
      }
      res.end(JSON.stringify(result ?? null, null, 1));
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err?.stack ?? err));
    }
  });
});

server.listen(smokePort(), '127.0.0.1', () => console.log(`smoke controller on 127.0.0.1:${smokePort()}, scratch folder ${dir}`));
