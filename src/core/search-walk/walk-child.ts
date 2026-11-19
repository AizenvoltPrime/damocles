// The walk process (dist/walk-child.js): runs the search walk for its host, so a share that stops answering holds only this
// process's libuv pool. Plain Node: desktop main forks it as a utility process and speaks over its parent port; every other host
// starts it on the launcher with ELECTRON_RUN_AS_NODE and speaks one JSON message a line on stdin and stdout.
import { portWalkChannel, stdioWalkChannel, type WalkParentPort } from './walk-channels';
import { serveWalks } from './walk-serve';

const port = (process as { parentPort?: WalkParentPort }).parentPort;
// The host closed stdin or died. process.exit, and the exit an uncaught EPIPE takes, would join libuv's pool threads on POSIX,
// which a hung read holds. A utility process ends with its host's channel instead.
const end = (): void => void process.kill(process.pid, 'SIGKILL');
serveWalks(port ? portWalkChannel(port) : stdioWalkChannel(process.stdin, process.stdout, end));
