import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkHostName, HOST_STORE_FILE, HostStore, prefillHostName, uniqueHostName } from '../host-store';

let userData: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-host-names-'));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

const open = (): Promise<HostStore> => HostStore.open(userData, () => undefined);

describe('checkHostName', () => {
  it('trims and normalizes to NFC', () => {
    // "é" as e + combining acute becomes the single code point
    expect(checkHostName('  cafe\u0301  ', [])).toEqual({ ok: true, name: 'caf\u00e9' });
  });

  it('refuses an empty name and one past 64 characters, counting code points', () => {
    expect(checkHostName('   ', [])).toEqual({ ok: false, reason: 'empty' });
    expect(checkHostName('a'.repeat(64), [])).toEqual({ ok: true, name: 'a'.repeat(64) });
    expect(checkHostName('a'.repeat(65), [])).toEqual({ ok: false, reason: 'tooLong' });
    // 64 astral characters are 128 UTF-16 units and still fit
    expect(checkHostName('\u{1F600}'.repeat(64), []).ok).toBe(true);
  });

  it('refuses control characters and bidirectional overrides and isolates', () => {
    expect(checkHostName('prod\u0007', [])).toEqual({ ok: false, reason: 'controlChars' });
    expect(checkHostName('pro\nd', [])).toEqual({ ok: false, reason: 'controlChars' });
    expect(checkHostName('pro\u009Bd', [])).toEqual({ ok: false, reason: 'controlChars' });
    for (const bidi of ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069']) {
      expect(checkHostName(`prod${bidi}1`, [])).toEqual({ ok: false, reason: 'bidiChars' });
    }
    for (const mark of ['\u200E', '\u200F', '\u061C']) expect(checkHostName(`prod${mark}1`, [])).toEqual({ ok: false, reason: 'bidiChars' });
    // zero-width and other format characters would let a look-alike pass the uniqueness check
    for (const invisible of ['\u200B', '\u2060', '\uFEFF', '\u00AD', '\u2028', '\u2029']) {
      expect(checkHostName(`billing${invisible}-prod`, [{ name: 'billing-prod' }])).toEqual({ ok: false, reason: 'controlChars' });
    }
    expect(checkHostName('prod 1 é ünïcode', []).ok).toBe(true);
  });

  it('refuses another host\'s name ignoring case, after NFC', () => {
    expect(checkHostName('Billing-Prod', [{ name: 'billing-prod' }])).toEqual({ ok: false, reason: 'taken', clashWith: 'billing-prod' });
    expect(checkHostName('CAFE\u0301', [{ name: 'caf\u00e9' }])).toEqual({ ok: false, reason: 'taken', clashWith: 'caf\u00e9' });
  });

  it('runs both ways: a name against other hosts\' aliases, and an alias against other hosts\' names', () => {
    expect(checkHostName('PROD-1', [{ name: 'Production', alias: 'prod-1' }])).toEqual({ ok: false, reason: 'taken', clashWith: 'prod-1' });
    expect(checkHostName('anything', [{ name: 'Prod-1' }], 'prod-1')).toEqual({ ok: false, reason: 'taken', clashWith: 'Prod-1' });
    // a host's own alias never blocks its own name
    expect(checkHostName('prod-1', [], 'prod-1')).toEqual({ ok: true, name: 'prod-1' });
  });
});

describe('prefills', () => {
  it('removes refused characters and keeps the name within bounds', () => {
    expect(prefillHostName(' prod\u202E-1\u0000 ')).toBe('prod-1');
    expect(prefillHostName('x'.repeat(80))).toBe('x'.repeat(64));
    expect(checkHostName(prefillHostName('\u2066evil\u2069\t'), []).ok).toBe(true);
  });

  it('adds a numeric suffix until the name is free', () => {
    expect(uniqueHostName('prod', [{ name: 'Prod' }, { name: 'x', alias: 'prod 2' }])).toBe('prod 3');
    expect(uniqueHostName('y'.repeat(64), [{ name: 'y'.repeat(64) }])).toBe(`${'y'.repeat(62)} 2`);
  });
});

describe('the host store applies the rule on every write', () => {
  it('refuses a duplicate on save and on rename, so a stale renderer cannot write one', async () => {
    const store = await open();
    const first = await store.addHost({ destination: { kind: 'address', host: '10.0.0.9', user: 'deploy', options: [] }, name: 'billing-prod' });
    expect(first.ok).toBe(true);
    expect(await store.addHost({ destination: { kind: 'address', host: '10.0.0.10', options: [] }, name: 'Billing-Prod' })).toEqual({ ok: false, check: { ok: false, reason: 'taken', clashWith: 'billing-prod' } });
    expect(await store.addHost({ destination: { kind: 'alias', alias: 'BILLING-PROD' }, name: 'other' })).toEqual({ ok: false, check: { ok: false, reason: 'taken', clashWith: 'billing-prod' } });
    const second = await store.addHost({ destination: { kind: 'alias', alias: 'staging' }, name: 'staging' });
    if (!first.ok || !second.ok) throw new Error('setup');
    expect(await store.renameHost(second.host.id, ' billing-PROD ')).toEqual({ ok: false, reason: 'taken', clashWith: 'billing-prod' });
    expect(await store.renameHost(second.host.id, 'stag\u202Eing')).toEqual({ ok: false, reason: 'bidiChars' });
    expect(await store.renameHost(first.host.id, 'STAGING')).toEqual({ ok: false, reason: 'taken', clashWith: 'staging' });
    // renaming a host to its own name in another case is no clash
    expect(await store.renameHost(first.host.id, 'Billing-Prod')).toEqual({ ok: true, name: 'Billing-Prod' });
    const reread = await open();
    expect(reread.hosts().map((host) => host.name)).toEqual(['Billing-Prod', 'staging']);
    expect(reread.checkName('billing-prod', first.host.id)).toEqual({ ok: true, name: 'billing-prod' });
    expect(reread.checkName('billing-prod')).toEqual({ ok: false, reason: 'taken', clashWith: 'Billing-Prod' });
  });

  it('gives records without a name, or with one the rule refuses, their alias or host name made unique', async () => {
    fs.writeFileSync(path.join(userData, HOST_STORE_FILE), JSON.stringify({
      version: 1,
      authorities: {},
      order: [],
      hosts: {
        a: { kind: 'ssh', destination: { kind: 'alias', alias: 'prod' }, name: 'prod', recentFolders: [], settings: {} },
        b: { kind: 'ssh', destination: { kind: 'alias', alias: 'PROD' }, recentFolders: [], settings: {} },
        c: { kind: 'ssh', destination: { kind: 'address', host: '10.0.0.9', options: [] }, recentFolders: [], settings: {} },
        d: { kind: 'ssh', destination: { kind: 'address', host: 'box', options: [] }, name: 'bad\u202Ename', recentFolders: [], settings: {} },
      },
    }));
    const store = await open();
    expect(store.hosts().map((host) => [host.id, host.name])).toEqual([['a', 'prod'], ['b', 'PROD 2'], ['c', '10.0.0.9'], ['d', 'box']]);
  });
});
