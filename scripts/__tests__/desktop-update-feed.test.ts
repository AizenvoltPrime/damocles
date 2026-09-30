import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { feedFile, startFeedServer } from '../desktop-update-feed.mjs';
import { overrideYaml, parseFlatYaml, writeOverride } from '../desktop-update-override.mjs';

const PACKAGED_YML = 'owner: AizenvoltPrime\nrepo: damocles\nprovider: github\nchannel: latest-x64\nupdaterCacheDirName: damocles-updater\n';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'feed-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function get(url: string, method = 'GET', rawPath?: string): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: target.hostname, port: target.port, path: rawPath ?? target.pathname, method }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('desktop update feed server', () => {
  it('serves files of its directory on 127.0.0.1 only', async () => {
    const dir = join(root, 'feed');
    mkdirSync(dir);
    writeFileSync(join(dir, 'latest-x64.yml'), 'version: 2.37.0\n');
    writeFileSync(join(root, 'secret.txt'), 'outside');
    const feed = await startFeedServer({ dir, log: () => undefined });
    try {
      expect(feed.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(await get(`${feed.url}latest-x64.yml`)).toEqual({ status: 200, body: 'version: 2.37.0\n' });
      expect((await get(`${feed.url}latest-x64.yml`, 'HEAD')).body).toBe('');
      expect((await get(feed.url, 'GET', '/../secret.txt')).status).toBe(404);
      expect((await get(feed.url, 'GET', '/%2e%2e/secret.txt')).status).toBe(404);
      expect((await get(feed.url, 'GET', '/%E0%A4%A')).status).toBe(404);
      expect((await get(`${feed.url}missing.yml`)).status).toBe(404);
      expect((await get(`${feed.url}latest-x64.yml`, 'PUT')).status).toBe(405);
    } finally {
      await feed.close();
    }
  });

  it('refuses paths that leave the directory or are not files', () => {
    const dir = join(root, 'feed');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'a.blockmap'), 'x');
    expect(feedFile(dir, '/sub/a.blockmap')).toBe(join(dir, 'sub', 'a.blockmap'));
    expect(feedFile(dir, '/sub')).toBeUndefined();
    expect(feedFile(dir, '/')).toBeUndefined();
    expect(feedFile(dir, '/sub/../../x')).toBeUndefined();
    expect(feedFile(dir, '/a%00b')).toBeUndefined();
  });
});

describe('app-update.yml override for an installed test app', () => {
  it('replaces the github provider with a loopback generic feed and keeps the cache dir and channel', () => {
    expect(parseFlatYaml(overrideYaml(PACKAGED_YML, 'http://127.0.0.1:4567/'))).toEqual({
      provider: 'generic',
      url: 'http://127.0.0.1:4567/',
      updaterCacheDirName: 'damocles-updater',
      channel: 'latest-x64',
    });
  });

  it.each(['http://localhost:4567/', 'https://127.0.0.1:4567/', 'http://127.0.0.1/', 'http://127.0.0.1:4567/feed/', 'http://0.0.0.0:4567/', 'http://127.0.0.1:99999/', 'http://127.0.0.1:4567@evil.com/'])('refuses the feed URL %s', (url) => {
    expect(() => overrideYaml(PACKAGED_YML, url)).toThrow();
  });

  it('refuses a file that is not the packaged github config', () => {
    expect(() => overrideYaml('provider: generic\nurl: http://127.0.0.1:1/\nupdaterCacheDirName: x\n', 'http://127.0.0.1:4567/')).toThrow(/provider/);
    expect(() => overrideYaml('provider: github\n', 'http://127.0.0.1:4567/')).toThrow(/updaterCacheDirName/);
    expect(() => overrideYaml('provider: github\nlist:\n  - a\n', 'http://127.0.0.1:4567/')).toThrow(/Unexpected/);
  });

  it('writes only into an existing installed resources/app-update.yml', () => {
    const install = join(root, 'app');
    expect(() => writeOverride(install, 'http://127.0.0.1:4567/')).toThrow(/does not exist/);
    mkdirSync(join(install, 'resources'), { recursive: true });
    writeFileSync(join(install, 'resources', 'app-update.yml'), PACKAGED_YML);
    writeOverride(install, 'http://127.0.0.1:4567/');
    expect(readFileSync(join(install, 'resources', 'app-update.yml'), 'utf8')).toContain('provider: generic\nurl: http://127.0.0.1:4567/\n');
  });
});
