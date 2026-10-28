import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

// An ssh-agent holding one ed25519 key, on a named pipe on Windows (Win32-OpenSSH's agent transport) and a unix socket
// elsewhere, so forwarding never reaches the developer's own agent or its keys. It speaks the agent protocol's identity
// list and sign requests (draft-miller-ssh-agent) and refuses every other request.

const FAILURE = 5;
const REQUEST_IDENTITIES = 11;
const IDENTITIES_ANSWER = 12;
const SIGN_REQUEST = 13;
const SIGN_RESPONSE = 14;

export interface SshAgentStub {
  /** SSH_AUTH_SOCK for ssh on this computer */
  readonly socket: string;
  /** `ssh-ed25519 AAAA... comment`, for an authorized_keys line */
  readonly publicKey: string;
  /** sign requests answered so far */
  readonly signatures: number;
  close(): Promise<void>;
}

const sshString = (bytes: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};

const packet = (type: number, body: Buffer = Buffer.alloc(0)): Buffer => sshString(Buffer.concat([Buffer.from([type]), body]));

export async function startSshAgentStub(folder: string, comment = 'damocles-e2e-agent'): Promise<SshAgentStub> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // the raw 32-byte key ends the SPKI DER
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const blob = Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(raw)]);
  const counts = { signatures: 0 };

  const answer = (request: Buffer): Buffer => {
    const type = request[0];
    if (type === REQUEST_IDENTITIES) {
      const count = Buffer.alloc(4);
      count.writeUInt32BE(1);
      return packet(IDENTITIES_ANSWER, Buffer.concat([count, sshString(blob), sshString(Buffer.from(comment))]));
    }
    if (type === SIGN_REQUEST) {
      const keyLength = request.readUInt32BE(1);
      const key = request.subarray(5, 5 + keyLength);
      const dataLength = request.readUInt32BE(5 + keyLength);
      const data = request.subarray(9 + keyLength, 9 + keyLength + dataLength);
      if (!key.equals(blob)) return packet(FAILURE);
      counts.signatures++;
      const signature = Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(sign(null, data, privateKey))]);
      return packet(SIGN_RESPONSE, sshString(signature));
    }
    return packet(FAILURE);
  };

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
        const length = pending.readUInt32BE(0);
        socket.write(answer(pending.subarray(4, 4 + length)));
        pending = pending.subarray(4 + length);
      }
    });
  });
  const name = `damocles-e2e-agent-${randomBytes(6).toString('hex')}`;
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(folder, `${name}.sock`);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => resolve());
  });
  if (process.platform !== 'win32') fs.chmodSync(socket, 0o600);
  return {
    socket,
    publicKey: `ssh-ed25519 ${blob.toString('base64')} ${comment}`,
    get signatures() {
      return counts.signatures;
    },
    close: async () => {
      for (const open of sockets) open.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
