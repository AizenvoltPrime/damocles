import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'os';
import { join } from 'path';
import { installLogSink } from '../../logger';

const launchPersistentContext = vi.fn<(userDataDir: string) => Promise<unknown>>(async () => ({}));

vi.mock('patchright', () => ({
  chromium: { launchPersistentContext: (userDataDir: string) => launchPersistentContext(userDataDir) },
}));

import { clearDownloadHistory, launchBrowserContext } from '../launcher';

let userDataDir: string;
let logged: string[];

function historyPath(): string {
  return join(userDataDir, 'Default', 'History');
}

function seedHistory({ slices = true } = {}): void {
  mkdirSync(join(userDataDir, 'Default'), { recursive: true });
  const db = new DatabaseSync(historyPath());
  db.exec(`
    CREATE TABLE downloads (id INTEGER PRIMARY KEY, guid TEXT);
    CREATE TABLE downloads_url_chains (id INTEGER, chain_index INTEGER, url TEXT);
    CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER);
    INSERT INTO downloads VALUES (1, 'a'), (2, 'b');
    INSERT INTO downloads_url_chains VALUES (1, 0, 'http://x/a'), (2, 0, 'http://x/b');
    INSERT INTO visits VALUES (1, 1), (2, 2);
  `);
  if (slices) db.exec('CREATE TABLE downloads_slices (download_id INTEGER, offset INTEGER); INSERT INTO downloads_slices VALUES (1, 0);');
  db.close();
}

function count(table: string): number {
  const db = new DatabaseSync(historyPath(), { readOnly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'dl-history-'));
  logged = [];
  installLogSink({ appendLine: (line: string) => void logged.push(line), show: () => undefined, dispose: () => undefined });
  launchPersistentContext.mockClear();
});

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

describe('clearDownloadHistory', () => {
  it('empties every download table and leaves the rest of History alone', () => {
    seedHistory();
    clearDownloadHistory(userDataDir);
    expect(count('downloads')).toBe(0);
    expect(count('downloads_url_chains')).toBe(0);
    expect(count('downloads_slices')).toBe(0);
    expect(count('visits')).toBe(2);
  });

  it('clears a schema without downloads_slices', () => {
    seedHistory({ slices: false });
    clearDownloadHistory(userDataDir);
    expect(count('downloads')).toBe(0);
    expect(count('downloads_url_chains')).toBe(0);
  });

  it.each([
    ['rolled back the transaction itself', 'ROLLBACK'],
    ['left the transaction open', 'ABORT'],
  ])('keeps every row and does not throw when a delete fails and SQLite %s', (_label, raise) => {
    seedHistory();
    const db = new DatabaseSync(historyPath());
    db.exec(`CREATE TRIGGER refuse BEFORE DELETE ON downloads_slices BEGIN SELECT RAISE(${raise}, 'refused'); END;`);
    db.close();

    expect(() => clearDownloadHistory(userDataDir)).not.toThrow();
    expect(count('downloads_url_chains')).toBe(2);
    expect(count('downloads_slices')).toBe(1);
    expect(count('downloads')).toBe(2);
    expect(logged.join('\n')).toContain('Download history left in place');
  });

  it('creates nothing in a profile that has no History yet', () => {
    clearDownloadHistory(userDataDir);
    expect(existsSync(historyPath())).toBe(false);
  });

  // Chrome holds History locked while it runs; the purge must back off rather than wait or write.
  it('leaves a locked History untouched and says why', () => {
    seedHistory();
    const holder = new DatabaseSync(historyPath());
    holder.exec('BEGIN EXCLUSIVE');
    try {
      expect(() => clearDownloadHistory(userDataDir)).not.toThrow();
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    expect(count('downloads')).toBe(2);
    expect(logged.some((line) => line.includes('Download history left in place') && line.includes('locked'))).toBe(true);
  });

  it('runs before Chrome is launched on the profile', async () => {
    seedHistory();
    let rowsAtLaunch = -1;
    launchPersistentContext.mockImplementationOnce(async () => {
      rowsAtLaunch = count('downloads');
      return {};
    });
    await launchBrowserContext({ userDataDir, headless: true, viewport: { width: 800, height: 600 }, deviceScaleFactor: 1, devToolsPort: false });
    expect(rowsAtLaunch).toBe(0);
  });
});
