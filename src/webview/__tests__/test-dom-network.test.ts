// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

// Guards the shared happy-dom settings in vitest.config.ts: markup a test renders never reaches the network.
describe('the test DOM', () => {
  let server: http.Server;
  let origin: string;
  const requests: string[] = [];

  beforeEach(async () => {
    requests.length = 0;
    server = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      res.end('');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    document.body.innerHTML = '';
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([
    ['an iframe page', (url: string) => `<iframe src="${url}/frame"></iframe>`],
    ['a script file', (url: string) => `<script src="${url}/script.js"></script>`],
    ['a stylesheet', (url: string) => `<link rel="stylesheet" href="${url}/style.css">`],
  ])('loads no %s', async (_name, markup) => {
    document.body.innerHTML = markup(origin);
    await (window as unknown as { happyDOM: { waitUntilComplete: () => Promise<void> } }).happyDOM.waitUntilComplete();
    expect(requests).toEqual([]);
  });
});
