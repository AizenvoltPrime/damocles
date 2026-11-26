// A bridge's start of the daemon, bundled and run by inherited-fds.test.ts: argv is the daemon's folder, then its entry and args.
import { startDetached } from '../process-starts';

const [folder, ...daemon] = process.argv.slice(2);
void startDetached(process.execPath, daemon, process.env as Record<string, string>, folder!, (line) => console.error(line)).then(() => process.exit(0));
