// The askpass helper (plan AD4, "Askpass"): resources/askpass/askpass.sh and ssh-askpass.sh run this file under the app's
// binary as Node. It sends git's or ssh's prompt to main's askpass server and prints the answer for git, or exits 1.
// Plain Node: no electron import, and nothing it sends or receives is ever logged.
import * as net from 'node:net';
import { MAX_REPLY_BYTES, parseHelperArgs, parseReply, requestLine } from './helper-protocol';

function fail(): void {
  process.stderr.write('Damocles could not provide credentials.\n');
  process.exitCode = 1;
}

function main(): void {
  const request = parseHelperArgs(process.argv.slice(2));
  const handle = process.env['DAMOCLES_ASKPASS_HANDLE'];
  const nonce = process.env['DAMOCLES_ASKPASS_NONCE'];
  if (!request || !handle || !nonce || !/^[0-9a-f]{64}$/.test(nonce)) {
    fail();
    return;
  }
  const socket = net.connect(handle);
  const chunks: Buffer[] = [];
  let bytes = 0;
  let done = false;
  const finish = (answer: string | undefined): void => {
    if (done) return;
    done = true;
    socket.destroy();
    if (answer === undefined) {
      fail();
      return;
    }
    // exitCode rather than exit, so the pipe write finishes before the process ends
    process.stdout.write(`${answer}\n`);
    process.exitCode = 0;
  };
  socket.on('error', () => finish(undefined));
  socket.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_REPLY_BYTES) {
      finish(undefined);
      return;
    }
    chunks.push(chunk);
  });
  socket.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    finish(text.endsWith('\n') && text.indexOf('\n') === text.length - 1 ? parseReply(text.slice(0, -1)) : undefined);
  });
  socket.on('close', () => finish(undefined));
  socket.write(requestLine(nonce, request, process.env['SSH_ASKPASS_PROMPT']));
}

main();
