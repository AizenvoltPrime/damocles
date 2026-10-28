import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as tls from 'node:tls';
import type { ElectronApplication } from '@playwright/test';
import { createTestPki } from '../../desktop/support/certs';
import { startGitHttpServer, type GitHttpServer } from '../../desktop/support/git-http-server';
import type { HermeticHome } from '../../desktop/support/hermetic';
import { commitMessage, moreActions, setSection } from '../../desktop/support/scm';
import { overlayPage, shellPage } from '../../desktop/support/shell';
import { expect } from './remote';
import { containerReachableAddress, HOST_FROM_CONTAINER, runProgram } from './sshd';

// An HTTPS git server the targets reach, and this computer's git credential helper, both under the test's temp root.

export interface HttpsGitServer {
  /** https://host.docker.internal:<port>/<repoPath>, as a target reaches it */
  url(repoPath: string): string;
  /** `host.docker.internal:<port>`, the host field git's credential protocol carries */
  readonly host: string;
  /** the test CA that signed the server's certificate */
  readonly caPem: string;
  readonly requests: GitHttpServer['requests'];
  close(): Promise<void>;
}

/**
 * The smart-HTTP git server with basic auth behind TLS, listening where the containers reach it. The bare repository
 * `<name>.git` holds nothing yet.
 */
export async function startHttpsGitServer(home: Pick<HermeticHome, 'root'>, name: string, user: string, password: string): Promise<HttpsGitServer> {
  const root = path.join(home.root, 'git-server');
  fs.mkdirSync(root, { recursive: true });
  const init = await runProgram('git', ['init', '-q', '--bare', '-b', 'main', path.join(root, `${name}.git`)]);
  if (init.code !== 0) throw new Error(`git init --bare exited with ${init.code}: ${init.stderr}`);
  const backend = await startGitHttpServer({ root, user, password });
  const backendPort = Number(new URL(backend.url('')).port);
  const pki = createTestPki([HOST_FROM_CONTAINER]);
  const sockets = new Set<net.Socket>();
  const front = tls.createServer({ cert: pki.leafCertPem, key: pki.leafKeyPem }, (client) => {
    const upstream = net.connect(backendPort, '127.0.0.1');
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream).pipe(client);
  });
  const address = await containerReachableAddress();
  await new Promise<void>((resolve, reject) => {
    front.once('error', reject);
    front.listen(0, address, () => resolve());
  });
  const port = (front.address() as net.AddressInfo).port;
  const host = `${HOST_FROM_CONTAINER}:${port}`;
  return {
    url: (repoPath) => `https://${host}/${repoPath.replace(/^\/+/, '')}`,
    host,
    caPem: pki.caCertPem,
    requests: backend.requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => front.close(() => resolve()));
      await backend.close();
    },
  };
}

export interface ClientCredentialHelper {
  /** the operation of every helper call git made on this computer (`get`, `store`, `erase`), in order */
  calls(): string[];
  /** the credential-store file's bytes */
  stored(): string;
}

/**
 * This computer's git credential helpers in the temp home's ~/.gitconfig: a recorder of each call's operation, then
 * `credential-store` on a file in the temp root that holds `user`/`password` for `https://<host>`. The developer's own
 * credential manager is never configured (GIT_CONFIG_NOSYSTEM is set in every launch).
 */
export function clientCredentialHelper(home: Pick<HermeticHome, 'root' | 'home'>, host: string, user: string, password: string): ClientCredentialHelper {
  // forward slashes: git runs a helper through its POSIX shell, on Windows too
  const posix = (file: string): string => file.split(path.sep).join('/');
  const log = path.join(home.root, 'credential-calls.log');
  const store = path.join(home.root, 'git-credentials');
  fs.writeFileSync(log, '');
  // credential-store's own encoding of the host's port separator
  fs.writeFileSync(store, `https://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host.replace(':', '%3a')}\n`);
  const recorder = `!f() { printf '%s\\\\n' \\"$1\\" >> '${posix(log)}'; cat > /dev/null; }; f`;
  fs.writeFileSync(path.join(home.home, '.gitconfig'), `[credential]\n\thelper = "${recorder}"\n\thelper = "store --file '${posix(store)}'"\n`);
  return {
    calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
    stored: () => fs.readFileSync(store, 'utf8'),
  };
}

export const newGitPassword = (): string => `git-${randomBytes(9).toString('base64url')}`;

/**
 * Push from the Source Control view of the selected project. A branch the remote does not hold yet (`publish`) asks to be
 * published first, which this answers with Publish.
 */
export async function scmPush(app: ElectronApplication, publish: boolean): Promise<void> {
  const shell = await shellPage(app);
  await setSection(shell, 'scm-section', true);
  await expect(commitMessage(shell)).toBeVisible({ timeout: 60_000 });
  await moreActions(app, shell, 'push');
  if (!publish) return;
  const question = (await overlayPage(app)).getByRole('alertdialog').filter({ hasText: 'has no remote branch' });
  await question.getByTestId('overlay-message-action-0').click();
  await expect(question).toHaveCount(0);
}
