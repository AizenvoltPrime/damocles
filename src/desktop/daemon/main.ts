// dist/daemon.js: `serve` runs the per-user daemon, `attach [--home <path>]` the bridge for one connection, `self-test` the
// server package's check. --home is applied before any module that reads os.homedir() loads, so every path, ~/.damocles
// included, resolves inside it for the bridge, the daemon it starts and every child of that daemon.
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const [mode, ...rest] = process.argv.slice(2);
const home = rest[0] === '--home' ? rest[1] : undefined;

async function run(): Promise<void> {
  // the bundle is dist/daemon.js; its package root holds dist/, resources/ and node_modules/
  const root = path.resolve(__dirname, '..');
  if (home !== undefined) {
    if (!path.isAbsolute(home)) throw new Error(`--home needs an absolute path, not ${home}`);
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;
  }
  if (mode === 'serve' && home === undefined && rest.length === 0) {
    // before the daemon starts anything, so no child of it inherits them
    (await import('./process-starts')).closeInheritedFds();
    const { serve, EXIT_START_FAILED } = await import('./serve');
    await serve(root).catch((err: unknown) => {
      process.stderr.write(`[daemon] could not start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(EXIT_START_FAILED);
    });
    return;
  }
  if (mode === 'attach' && (rest.length === 0 || (home !== undefined && rest.length === 2))) {
    const { attach } = await import('./attach');
    await attach(root);
    return;
  }
  if (mode === 'self-test' && rest.length === 0) {
    // a throwaway home, so the check's Damocles Core never touches the user's ~/.damocles
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'damocles-self-test-'));
    process.env['HOME'] = scratch;
    process.env['USERPROFILE'] = scratch;
    const { selfTest } = await import('./self-test');
    const passed = await selfTest(root).catch((err: unknown) => {
      process.stdout.write(`self-test: FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      return false;
    });
    await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
    process.exit(passed ? 0 : 1);
  }
  process.stderr.write('usage: daemon.js serve | daemon.js attach [--home <absolute path>] | daemon.js self-test\n');
  process.exit(64);
}

void run();
