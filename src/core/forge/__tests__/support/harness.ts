import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import { createTestPki } from '../../../../../e2e/desktop/support/certs';
import { createFakeSecretsStore, type FakeSecretsStore } from '../../../../__mocks__/fake-platform';
import type { Disposable } from '../../../../platform/disposable';
import type { SettingsChange } from '../../../../platform/settings-store';
import { createForgeService, type ForgeService, type ForgeServiceDeps, type ForgeViewMessage } from '../..';
import { startForgeStub, type ForgeStub, type StubServer } from './forge-stub';

// The forge tests' world: the stub over TLS with a fresh test CA, a fetch that trusts it, an in-memory SecretsStore and a
// temporary forge folder. Every log line is kept, so a test can scan it for secrets.

export interface Harness {
  readonly stub: ForgeStub;
  readonly ca: string;
  readonly fetch: typeof fetch;
  readonly forgeDir: string;
  secrets: FakeSecretsStore;
  readonly logs: string[];
  /** Every URL the service asked to open in the browser. */
  readonly opened: string[];
  readonly clipboard: string[];
  readonly revealed: string[];
  readonly messages: ForgeViewMessage[];
  settings: Record<string, unknown>;
  /** The browser completes an authorize URL of the stub by itself while set. */
  autoBrowser: boolean;
  /** A service over this world; a second call over the same secrets and folder is a core restart. */
  service(overrides?: Partial<ForgeServiceDeps>): ForgeService;
  /** The ForgeService deps the harness builds, for tests that build the parts themselves. */
  deps(overrides?: Partial<ForgeServiceDeps>): ForgeServiceDeps;
  close(): Promise<void>;
}

const stubServerFor = (stub: ForgeStub, url: string): StubServer | undefined =>
  [stub.github, stub.gitlab, stub.indigital, stub.ghes].find((server) => url.startsWith(`${server.webUrl}/`));

/** now: the clock of the stub's CI and of every service, which a test moves itself. */
export async function createHarness(options: { readonly gitRoot?: string; readonly now?: () => number } = {}): Promise<Harness> {
  const pki = createTestPki(['localhost']);
  const stub = await startForgeStub({ cert: pki.leafCertPem, key: pki.leafKeyPem, ca: pki.caCertPem, ...(options.gitRoot !== undefined ? { gitRoot: options.gitRoot } : {}), ...(options.now !== undefined ? { now: options.now } : {}) });
  const agent = new Agent({ connect: { ca: pki.caCertPem } });
  const tlsFetch = ((input: string, init?: RequestInit) => undiciFetch(input, { ...(init as object), dispatcher: agent })) as unknown as typeof fetch;
  const forgeDir = mkdtempSync(path.join(tmpdir(), 'damocles-forge-'));
  const services: ForgeService[] = [];
  const settingsListeners = new Set<(change: SettingsChange) => void>();
  const harness: Harness = {
    stub,
    ca: pki.caCertPem,
    fetch: tlsFetch,
    forgeDir,
    secrets: createFakeSecretsStore(),
    logs: [],
    opened: [],
    clipboard: [],
    revealed: [],
    messages: [],
    settings: {},
    autoBrowser: true,
    deps: (overrides = {}) => ({
      forgeDir,
      secrets: harness.secrets,
      settings: {
        get: ((key: string, fallback?: unknown) => (key in harness.settings ? harness.settings[key] : fallback)) as ForgeServiceDeps['settings']['get'],
        onDidChange: (_section: string, listener: (change: SettingsChange) => void): Disposable => {
          settingsListeners.add(listener);
          return { dispose: () => settingsListeners.delete(listener) };
        },
      },
      fetch: tlsFetch,
      userAgent: 'Damocles/0.0.0-test',
      openExternal: async (url) => {
        harness.opened.push(url);
        const server = stubServerFor(stub, url);
        if (harness.autoBrowser && server && /\/(?:login\/oauth|oauth)\/authorize\?/.test(url)) void server.completeBrowser(url);
        return true;
      },
      writeClipboard: async (text) => {
        harness.clipboard.push(text);
      },
      revealPath: async (absolutePath) => {
        harness.revealed.push(absolutePath);
      },
      buildOAuth: {},
      overrides: {
        'github.com': { webUrl: stub.github.webUrl, apiUrl: stub.github.apiUrl, oauth: { clientId: stub.github.spec.clientId, clientSecret: stub.github.spec.clientSecret! } },
        'gitlab.com': { webUrl: stub.gitlab.webUrl, apiUrl: stub.gitlab.apiUrl, oauth: { clientId: stub.gitlab.spec.clientId } },
      },
      log: (line) => harness.logs.push(line),
      ...(options.now !== undefined ? { now: options.now } : {}),
      // the SSRF guard refuses 127.0.0.1; GitHub's log storage stand-in is the one other origin the stub runs
      publicFetch: async (url, init) => {
        if (new URL(url).origin !== stub.logStorage.url) throw new Error(`${new URL(url).origin} is not a public address`);
        return tlsFetch(url, init);
      },
      sleep: (ms, signal) => new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error('aborted'));
        const timer = setTimeout(resolve, Math.min(ms, 20));
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        }, { once: true });
      }),
      ...overrides,
    }),
    service: (overrides = {}) => {
      const service = createForgeService(harness.deps(overrides));
      service.onMessage((message) => harness.messages.push(message));
      services.push(service);
      return service;
    },
    close: async () => {
      for (const service of services) service.dispose();
      await stub.close();
      await agent.close();
      rmSync(forgeDir, { recursive: true, force: true });
    },
  };
  return harness;
}

/** The newest forgeAccountsChanged state the harness saw. */
export function lastState(harness: Harness): Extract<ForgeViewMessage, { type: 'forgeAccountsChanged' }>['state'] {
  const message = [...harness.messages].reverse().find((item) => item.type === 'forgeAccountsChanged');
  if (message?.type !== 'forgeAccountsChanged') throw new Error('no forgeAccountsChanged yet');
  return message.state;
}

/** The sign-in states a server went through, in order. */
export function signInStates(harness: Harness, serverId: string): Extract<ForgeViewMessage, { type: 'forgeSignInState' }>['state'][] {
  return harness.messages.flatMap((message) => (message.type === 'forgeSignInState' && message.serverId === serverId ? [message.state] : []));
}
