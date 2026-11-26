// A stand-in daemon, bundled by inherited-fds.test.ts: it closes the fds its start named, writes its pid and those fds to the
// report file argv names, then stays up for the milliseconds argv gives.
import { writeFileSync } from 'node:fs';
import { closeInheritedFds } from '../process-starts';

const [report, holdMs] = process.argv.slice(2);
const named = process.env['DAMOCLES_INHERITED_FDS'] ?? '';
closeInheritedFds();
writeFileSync(report!, JSON.stringify({ pid: process.pid, named }));
setTimeout(() => undefined, Number(holdMs));
