// Records where it runs (pid, parent, home, cwd) as one JSON line in argv[2], then: `hold <file>` waits for that file to
// exist, `mcp` serves mcp-stdio-server.cjs, and anything else exits. A hold exits after 5 minutes or once its parent is gone,
// so a test that never releases it leaves no process holding the hermetic root.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [out, mode, arg] = process.argv.slice(2);
fs.appendFileSync(out, `${JSON.stringify({ pid: process.pid, ppid: process.ppid, home: os.homedir(), cwd: process.cwd(), mode: mode ?? 'once' })}\n`);

if (mode === 'mcp') {
  require(path.join(__dirname, 'mcp-stdio-server.cjs'));
} else if (mode === 'hold') {
  const started = Date.now();
  // POSIX re-parents an orphan to init or a subreaper, which a signal check would find alive; Windows never re-parents
  const parent = process.ppid;
  const parentGone = () => {
    if (process.ppid !== parent) return true;
    try {
      process.kill(parent, 0);
      return false;
    } catch {
      return true;
    }
  };
  const timer = setInterval(() => {
    if (fs.existsSync(arg)) {
      clearInterval(timer);
      return;
    }
    if (Date.now() - started > 300_000 || parentGone()) process.exit(1);
  }, 100);
}
