// node scripts/smoke-desktop/post.mjs <step.js | --launch | --log | --quit> [timeout seconds, default 55]
import fs from 'node:fs';
import { smokeDir, smokePort, TOKEN_HEADER, tokenFile } from './paths.mjs';

const [target, seconds = '55'] = process.argv.slice(2);
if (!target) {
  console.error('usage: post.mjs <step.js | --launch | --log | --quit> [timeout seconds]');
  process.exit(2);
}

const endpoint = { '--launch': '/launch', '--log': '/log', '--quit': '/quit' }[target] ?? '/run';
const body = endpoint === '/run' ? fs.readFileSync(target, 'utf8') : '';
if (endpoint === '/run') {
  // Fails here on a syntax error instead of inside the app.
  new (Object.getPrototypeOf(async () => {}).constructor)('h', body);
}

let token;
try {
  token = fs.readFileSync(tokenFile(smokeDir()), 'utf8').trim();
} catch {
  console.error('No controller is running: start scripts/smoke-desktop/controller.mjs first.');
  process.exit(1);
}

try {
  const res = await fetch(`http://127.0.0.1:${smokePort()}${endpoint}`, {
    method: 'POST',
    headers: { [TOKEN_HEADER]: token },
    body,
    signal: AbortSignal.timeout(Number(seconds) * 1000),
  });
  console.log(await res.text());
  process.exit(res.ok ? 0 : 1);
} catch (err) {
  console.error(err.name === 'TimeoutError' ? `No answer within ${seconds}s; the step may still be running. Check with a short status step.` : String(err));
  process.exit(1);
}
