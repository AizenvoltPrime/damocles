// The askpass helper (plan AD4, "Askpass"): resources/askpass/askpass.sh and ssh-askpass.sh run this file under the app's
// binary as Node, and on a target resources/git-credential/git-credential-relay runs it as git's credential helper. It
// sends one JSON line to core's or main's askpass server and prints what git or ssh reads, or exits 1.
// Plain Node: no electron import, and nothing it sends or receives is ever logged.
import * as net from 'node:net';
import {
  credentialFields,
  credentialOutput,
  credentialRequestLine,
  erasedPasswordHash,
  MAX_CREDENTIAL_INPUT_BYTES,
  MAX_REPLY_BYTES,
  parseCredentialOp,
  parseCredentialReply,
  parseHelperArgs,
  parseReply,
  readBounded,
  requestLine,
} from './helper-protocol';

const NONCE_HEX = /^[0-9a-f]{64}$/;

function fail(): void {
  process.stderr.write('Damocles could not provide credentials.\n');
  process.exitCode = 1;
}

// One request line out, one reply line back; the reply is undefined on any failure.
function exchange(handle: string, line: string, onReply: (reply: string | undefined) => void): void {
  const socket = net.connect(handle);
  const chunks: Buffer[] = [];
  let bytes = 0;
  let done = false;
  const finish = (reply: string | undefined): void => {
    if (done) return;
    done = true;
    socket.destroy();
    onReply(reply);
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
    finish(text.endsWith('\n') && text.indexOf('\n') === text.length - 1 ? text.slice(0, -1) : undefined);
  });
  socket.on('close', () => finish(undefined));
  socket.write(line);
}

// The working folder, or undefined when it was deleted, where process.cwd() throws.
function workingFolder(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

// git's credential helper: store is dropped here, so a credential git approves never leaves the target.
function credential(args: readonly string[]): void {
  const op = parseCredentialOp(args);
  const handle = process.env['DAMOCLES_ASKPASS_HANDLE'];
  const nonce = process.env['DAMOCLES_CREDENTIAL_NONCE'];
  // git's description on stdin, read to its end
  readBounded(process.stdin, MAX_CREDENTIAL_INPUT_BYTES, (input) => {
    if (op === 'store') return;
    const fields = input === undefined ? undefined : credentialFields(input);
    // git takes a helper's empty answer as "nothing here" and asks its next helper or the user
    if (op !== undefined && fields === 'noHost') return;
    const cwd = workingFolder();
    if (op === undefined || !fields || fields === 'noHost' || !handle || !nonce || !NONCE_HEX.test(nonce) || cwd === undefined) {
      fail();
      return;
    }
    const passwordHash = op === 'erase' && input !== undefined ? erasedPasswordHash(input) : undefined;
    exchange(handle, credentialRequestLine(nonce, op, cwd, fields, passwordHash), (reply) => {
      const answer = reply === undefined ? undefined : parseCredentialReply(reply);
      if (!answer) {
        fail();
        return;
      }
      const { stdout, stderr } = credentialOutput(answer);
      if (stderr !== '') process.stderr.write(stderr);
      // exitCode rather than exit, so the pipe write finishes before the process ends
      if (stdout !== '') process.stdout.write(stdout);
      process.exitCode = 0;
    });
  });
}

function prompt(args: readonly string[]): void {
  const request = parseHelperArgs(args);
  const handle = process.env['DAMOCLES_ASKPASS_HANDLE'];
  const nonce = process.env['DAMOCLES_ASKPASS_NONCE'];
  if (!request || !handle || !nonce || !NONCE_HEX.test(nonce)) {
    fail();
    return;
  }
  exchange(handle, requestLine(nonce, request, process.env['SSH_ASKPASS_PROMPT']), (reply) => {
    const answer = reply === undefined ? undefined : parseReply(reply);
    if (answer === undefined) {
      fail();
      return;
    }
    process.stdout.write(`${answer}\n`);
    process.exitCode = 0;
  });
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'credential') credential(rest);
else prompt(process.argv.slice(2));
