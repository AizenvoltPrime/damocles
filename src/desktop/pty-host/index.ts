// The pty host (AD6): a child process (main's utility process locally) that owns every terminal's pty and its screen, so a
// native crash or a blocked read cannot take down its parent. The parent validated every request and resolved every path.
import * as os from 'node:os';
import { parentChannel } from '../local-services/parent-channel';
import { NODE_PTY_ARG_PREFIX, parseHostRequest, SELF_ACKNOWLEDGE_ARG } from './protocol';
import { createPtyScreen } from './screen';
import { createPtySessions } from './sessions';

const nodePtyPath = process.argv.find((arg) => arg.startsWith(NODE_PTY_ARG_PREFIX))?.slice(NODE_PTY_ARG_PREFIX.length);
if (!nodePtyPath) throw new Error(`the pty host was started without ${NODE_PTY_ARG_PREFIX}`);
// Loaded from the path main passes: packaged, that is inside app.asar, so node-pty's own app.asar.unpacked rewrite finds its binaries.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the package location is known only at run time
const nodePty = require(nodePtyPath) as typeof import('node-pty');
const channel = parentChannel();
if (!channel) throw new Error('the pty host runs only as a child process');
// A parent that went away can no longer kill the ptys; ending the host ends them.
channel.onDisconnect(() => process.exit(0));

const sessions = createPtySessions({
  spawn: (file, args, options) => nodePty.spawn(file, [...args], { ...options, env: { ...options.env } }),
  post: (message) => channel.postMessage(message),
  throttleConpty: process.platform === 'win32',
  readProcessName: process.platform !== 'win32',
  selfAcknowledge: process.argv.includes(SELF_ACKNOWLEDGE_ARG),
  log: (line) => process.stderr.write(`${line}\n`),
  // the shell's xterm sets the same windowsPty from main's os.release()
  screen: (options) => createPtyScreen(process.platform === 'win32' ? { ...options, windowsPty: { backend: 'conpty', buildNumber: Number(/^\d+\.\d+\.(\d+)/.exec(os.release())?.[1] ?? 0) } } : options),
});

channel.on('message', (event) => {
  const request = parseHostRequest(event.data);
  // Main builds every request; one outside the contract is a bug, and this exit marks every terminal exited in main.
  if (!request) throw new Error('the pty host received a malformed request');
  // A request that failed leaves the host in a state main cannot see; ending it makes main mark every terminal exited.
  sessions.handle(request).then(() => {
    if (request.type === 'shutdown') process.exit(0);
  }, (error: unknown) => {
    // Main logs the end of this stderr when the host exits; exiting before the write flushes would lose it.
    const reason = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`the pty host failed a ${request.type} request: ${reason}\n`, () => process.exit(1));
  });
});
