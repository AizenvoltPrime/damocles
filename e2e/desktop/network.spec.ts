import * as fs from 'node:fs';
import * as path from 'node:path';
import { mainLog } from './support/app';
import { createTestPki } from './support/certs';
import { startConnectProxy } from './support/connect-proxy';
import { chatTab, expect, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { chatRequests, startOpenAIStub } from './support/openai-stub';
import { chatInput, sendAndAwaitEcho } from './support/ui';

// A reserved name (RFC 6761) that never resolves, so only the test proxy can reach the stub under it.
const STUB_HOST = 'stub.damocles.test';

test.describe('network configuration', () => {
  test('NODE_EXTRA_CA_CERTS: a TLS stub signed by a test CA is accepted', async ({ home, launch }) => {
    const pki = createTestPki([STUB_HOST, 'localhost']);
    const caFile = path.join(home.root, 'test-ca.pem');
    fs.writeFileSync(caFile, pki.caCertPem);
    const stub = await startOpenAIStub({ tls: { cert: pki.leafCertPem, key: pki.leafKeyPem } });
    try {
      seedStubModel(home, stub.baseUrl);
      expect(stub.baseUrl).toMatch(/^https:\/\/127\.0\.0\.1:/);
      const desktop = await launch({ env: { NODE_EXTRA_CA_CERTS: caFile } });
      const tab = await chatTab(desktop.app);
      await expect(chatInput(tab)).toBeVisible();
      await sendAndAwaitEcho(tab, 'over tls with the test ca');
      expect(chatRequests(stub).length).toBeGreaterThan(0);
      await expect.poll(() => mainLog(home)).toMatch(/\[network\] trusting \d+ CA certificates \(bundled \d+, system \d+, extra 1\)/);
    } finally {
      await stub.close();
    }
  });

  test('HTTPS_PROXY: a chat request reaches the stub only through the local proxy', async ({ home, launch }) => {
    const pki = createTestPki([STUB_HOST]);
    const caFile = path.join(home.root, 'test-ca.pem');
    fs.writeFileSync(caFile, pki.caCertPem);
    const stub = await startOpenAIStub({ tls: { cert: pki.leafCertPem, key: pki.leafKeyPem }, hostName: STUB_HOST });
    const authority = `${STUB_HOST}:${stub.port}`;
    const proxy = await startConnectProxy({ [authority]: stub.port });
    try {
      seedStubModel(home, stub.baseUrl);
      const desktop = await launch({ env: { HTTPS_PROXY: proxy.url, NODE_EXTRA_CA_CERTS: caFile } });
      const tab = await chatTab(desktop.app);
      await expect(chatInput(tab)).toBeVisible();
      await sendAndAwaitEcho(tab, 'through the proxy');

      const chats = chatRequests(stub);
      expect(chats.length).toBeGreaterThan(0);
      for (const request of chats) expect(request.host).toBe(authority);
      expect(proxy.connects).toContain(authority);
      // Nothing else went out through the proxy: pi runs offline and the stub is the only configured endpoint.
      expect(new Set(proxy.connects)).toEqual(new Set([authority]));
    } finally {
      await proxy.close();
      await stub.close();
    }
  });
});
