// The store's trust checks both ways: a list signed by a known key with a well-formed, fresh payload is accepted, and each way a
// list can be untrustworthy is refused with its own message; the download pin and the release hosts likewise.
import { createHash, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keyIdOf, STORE_KEYS, trustedStoreKeys } from '../../store-keys';
import { assertPinned, checkFreshness, releaseDownloadAllowed, StorePinError, verifyEnvelope, type StoreVerdict } from '../verify';
import { entry, payload, SEEDS, signed, testKey } from './store-fixtures';

const NOW = Date.UTC(2026, 10, 19, 12);
const key = testKey();
const keys = trustedStoreKeys(key.publicPem);

const reasonOf = (verdict: StoreVerdict): string => (verdict.ok ? 'accepted' : verdict.reason.message);
const accepted = (verdict: StoreVerdict) => {
  if (!verdict.ok) throw new Error(`refused: ${JSON.stringify(verdict.reason)}`);
  return verdict.payload;
};

describe('store keys', () => {
  it.each([
    ['current', '187953e23cec5c03'],
    ['next', '822af0c838fe5f14'],
  ] as const)('names the shipped %s key by the first 16 hex of the SHA-256 of its SPKI DER', (slot, keyId) => {
    const shipped = STORE_KEYS[slot]!;
    const der = createPublicKey(shipped.spkiPem).export({ type: 'spki', format: 'der' });
    expect(createHash('sha256').update(der).digest('hex').slice(0, 16)).toBe(keyId);
    expect(shipped.keyId).toBe(keyId);
    expect(keyIdOf(shipped.spkiPem)).toBe(keyId);
  });

  it('trusts both shipped keys, and the e2e test key only when it is passed', () => {
    expect([...trustedStoreKeys().keys()]).toEqual(['187953e23cec5c03', '822af0c838fe5f14']);
    expect([...keys.keys()].sort()).toEqual(['187953e23cec5c03', '822af0c838fe5f14', key.keyId].sort());
  });
});

describe('verifyEnvelope', () => {
  it('accepts a list signed by a known key and keeps its entries', () => {
    const list = accepted(verifyEnvelope(signed(key, payload(NOW)), keys));
    expect(list.sequence).toBe(5);
    expect(list.entries.map((e) => e.id)).toEqual(['aurora']);
    expect(list.entries[0]!.colors.dark).toEqual(SEEDS);
    expect(list.expiresAt).toBe(NOW + 29 * 24 * 60 * 60 * 1000);
  });

  it('cleans outside text to one line without control or bidi characters, cut to its limit, and drops unknown keys', () => {
    const list = accepted(verifyEnvelope(signed(key, payload(NOW, {
      future: true,
      entries: [entry({ name: 'Evil\u202e\nName\u0007', author: `${'a'.repeat(250)}`, description: 'one\r\ntwo', licenses: ['MIT\u2066'], extra: 1 })],
      removed: [{ id: 'gone', reason: 'Taken\u2028down', note: 'x' }],
    })), keys));
    const [e] = list.entries;
    expect(e!.name).toBe('Evil Name');
    expect([...e!.author]).toHaveLength(200);
    expect(e!.description).toBe('one two');
    expect(e!.licenses).toEqual(['MIT']);
    expect(e).not.toHaveProperty('extra');
    expect(list).not.toHaveProperty('future');
    expect(list.removed).toEqual([{ id: 'gone', reason: 'Taken down' }]);
  });

  it.each([
    ['not an object', 'unsigned'],
    ['no signature', { format: 1, keyId: 'x', payload: '{}' }],
    ['no keyId', { format: 1, payload: '{}', signature: 'AA==' }],
    ['no payload', { format: 1, keyId: 'abcdabcdabcdabcd', signature: 'AA==' }],
    ['a signature that is not base64 of 64 bytes', { format: 1, keyId: 'abcdabcdabcdabcd', payload: '{}', signature: 'AA==' }],
  ])('refuses an unsigned list: %s', (_name, envelope) => {
    expect(reasonOf(verifyEnvelope(envelope, keys))).toBe('The community store list is not signed, so Damocles did not use it.');
  });

  it('refuses another format', () => {
    expect(reasonOf(verifyEnvelope(signed(key, payload(NOW), { format: 2 }), keys))).toBe('The community store list has a format this Damocles does not read, so Damocles did not use it. A newer Damocles may read it.');
  });

  it('refuses a keyId Damocles does not know', () => {
    const stranger = testKey();
    const verdict = verifyEnvelope(signed(stranger, payload(NOW)), keys);
    expect(reasonOf(verdict)).toBe('The community store list is signed with a key Damocles does not know ({0}), so Damocles did not use it.');
    expect(verdict.ok ? undefined : verdict.reason.args).toEqual([stranger.keyId]);
  });

  it('refuses the test key once it is not passed', () => {
    expect(reasonOf(verifyEnvelope(signed(key, payload(NOW)), trustedStoreKeys()))).toBe('The community store list is signed with a key Damocles does not know ({0}), so Damocles did not use it.');
  });

  it('refuses a wrong signature: another key under a known keyId, and a payload changed after signing', () => {
    const forger = testKey();
    const mismatch = 'The community store list\'s signature does not match its contents, so Damocles did not use it.';
    expect(reasonOf(verifyEnvelope(signed(forger, payload(NOW), { keyId: key.keyId }), keys))).toBe(mismatch);
    const good = signed(key, payload(NOW));
    const changed = { ...good, payload: (good['payload'] as string).replace('"sequence":5', '"sequence":9') };
    expect(reasonOf(verifyEnvelope(changed, keys))).toBe(mismatch);
    expect(reasonOf(verifyEnvelope({ ...good, keyId: '187953e23cec5c03' }, keys))).toBe(mismatch);
  });

  const thumb = (panel: string): Record<string, unknown> => ({ panel, url: 'https://raw.githubusercontent.com/x', sha256: 'b'.repeat(64) });
  // each row: the fixture, and how the detail the refusal carries starts, so a row cannot pass for another row's reason
  it.each([
    ['payload that is not JSON', '{"sequence":', 'Unexpected end of JSON input'],
    ['missing entries', payload(NOW, { entries: undefined }), '/:'],
    ['an http file url', payload(NOW, { entries: [entry({ file: { url: 'http://github.com/a', sha256: 'a'.repeat(64), bytes: 1 } })] }), '/entries/0/file/url:'],
    ['a file url off the GitHub release hosts', payload(NOW, { entries: [entry({ file: { url: 'https://themes.example/aurora.damocles-theme', sha256: 'a'.repeat(64), bytes: 1 } })] }), '/entries/0/file/url: not on a GitHub release host'],
    ['a file url on the e2e host without the hooks', payload(NOW, { entries: [entry({ file: { url: 'https://e2e.test/aurora.damocles-theme', sha256: 'a'.repeat(64), bytes: 1 } })] }), '/entries/0/file/url: not on a GitHub release host'],
    ['a file sha256 that is not hex64', payload(NOW, { entries: [entry({ file: { url: 'https://github.com/a', sha256: 'A'.repeat(64), bytes: 1 } })] }), '/entries/0/file/sha256:'],
    ['a file over 100 MB', payload(NOW, { entries: [entry({ file: { url: 'https://github.com/a', sha256: 'a'.repeat(64), bytes: 100 * 1024 * 1024 + 1 } })] }), '/entries/0/file/bytes:'],
    ['a file size that is not an integer', payload(NOW, { entries: [entry({ file: { url: 'https://github.com/a', sha256: 'a'.repeat(64), bytes: 1.5 } })] }), '/entries/0/file/bytes:'],
    ['an entry listed twice', payload(NOW, { entries: [entry(), entry()] }), '/entries/1/id: aurora is listed twice'],
    ['a kind named twice', payload(NOW, { entries: [entry({ kinds: ['dark', 'dark'] })] }), '/entries/0/kinds: names a kind twice'],
    ['a kind without its colors', payload(NOW, { entries: [entry({ kinds: ['dark', 'light'] })] }), '/entries/0/colors/light: missing'],
    ['a color that is not #rrggbb', payload(NOW, { entries: [entry({ colors: { dark: { ...SEEDS, accent: 'red' } } })] }), '/entries/0/colors/dark/accent:'],
    ['a name of only control characters', payload(NOW, { entries: [entry({ name: '\u0000\u202e' })] }), '/entries/0: name, author or version is empty'],
    ['an entry without hasMoving', payload(NOW, { entries: [entry({ hasMoving: undefined })] }), '/entries/0:'],
    ['a thumbnail panel the app does not have', payload(NOW, { entries: [entry({ thumbnails: { dark: [thumb('span')] } })] }), '/entries/0/thumbnails/dark/0/panel:'],
    ['a look that names one panel twice', payload(NOW, { entries: [entry({ thumbnails: { dark: [thumb('chat'), thumb('sidebar'), thumb('chat')] } })] }), '/entries/0/thumbnails/dark: names a panel twice'],
    ['a removed entry without a reason', payload(NOW, { removed: [{ id: 'gone' }] }), '/removed/0:'],
    ['a sequence of 0', payload(NOW, { sequence: 0 }), '/sequence:'],
    ['an issuedAt that is not an ISO time', payload(NOW, { issuedAt: 'yesterday' }), '/issuedAt:'],
    ['an issuedAt in a month no year has', payload(NOW, { issuedAt: '2026-13-01T00:00:00Z' }), '/issuedAt: not a time'],
    ['an expiresAt in a month no year has', payload(NOW, { expiresAt: '2026-13-01T00:00:00Z' }), '/expiresAt: not a time'],
    ['an expiresAt before issuedAt', payload(NOW, { expiresAt: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString() }), '/expiresAt: not after issuedAt'],
    ['a minAppVersion that is not x.y.z', payload(NOW, { entries: [entry({ minAppVersion: 'next' })] }), '/entries/0/minAppVersion:'],
    ['more entries than a list may hold', payload(NOW, { entries: Array.from({ length: 2001 }, (_, i) => entry({ id: `entry-${i}` })) }), '/entries:'],
  ])('refuses a malformed payload: %s', (_name, body, detail) => {
    const verdict = verifyEnvelope(signed(key, body as Record<string, unknown> | string), keys);
    expect(reasonOf(verdict)).toBe('The community store list is signed but malformed ({0}), so Damocles did not use it.');
    const said = verdict.ok ? undefined : verdict.reason.args?.[0];
    const text = typeof said === 'object' && 'args' in said ? String(said.args?.[0]) : '';
    expect(text.slice(0, detail.length)).toBe(detail);
  });

  it('takes a file on the e2e host as a release file only with the hooks on, and a list of exactly 2000 entries', () => {
    const onE2e = payload(NOW, { entries: [entry({ file: { url: 'https://e2e.test/aurora.damocles-theme', sha256: 'a'.repeat(64), bytes: 1 } })] });
    expect(reasonOf(verifyEnvelope(signed(key, onE2e), keys, true))).toBe('accepted');
    const full = payload(NOW, { entries: Array.from({ length: 2000 }, (_, i) => entry({ id: `entry-${i}` })) });
    expect(accepted(verifyEnvelope(signed(key, full), keys)).entries).toHaveLength(2000);
  });
});

describe('checkFreshness', () => {
  const list = accepted(verifyEnvelope(signed(key, payload(NOW)), keys));

  it('refuses a sequence below the highest seen and accepts an equal or higher one', () => {
    const rollback = checkFreshness(list, { highestSequence: 6, now: NOW });
    expect(rollback?.message).toBe('The community store list is older (number {0}) than one Damocles already saw (number {1}), so Damocles kept the newer list.');
    expect(rollback?.args).toEqual(['5', '6']);
    expect(checkFreshness(list, { highestSequence: 5, now: NOW })).toBeUndefined();
    expect(checkFreshness(list, { highestSequence: 4, now: NOW })).toBeUndefined();
    expect(checkFreshness(list, { highestSequence: undefined, now: NOW })).toBeUndefined();
  });

  it('refuses a list whose expiresAt has passed and accepts it until then', () => {
    const expired = checkFreshness(list, { highestSequence: undefined, now: list.expiresAt });
    expect(expired?.message).toBe('The community store list expired on {0}, so Damocles did not use it.');
    expect(expired?.args).toEqual(['2026-12-18']);
    expect(checkFreshness(list, { highestSequence: undefined, now: list.expiresAt - 1 })).toBeUndefined();
  });
});

describe('releaseDownloadAllowed', () => {
  it.each([
    ['https://github.com/ada/aurora/releases/download/v1/a.damocles-theme', false, true],
    ['https://release-assets.githubusercontent.com/github-production-release-asset/1/2', false, true],
    ['https://objects.githubusercontent.com/github-production-release-asset-2e65be/1', false, true],
    ['http://github.com/ada/aurora/releases/download/v1/a', false, false],
    ['https://github.com.evil.example/a', false, false],
    ['https://evil.example/github.com', false, false],
    ['https://github.com:8443/a', false, false],
    ['https://user:pw@github.com/a', false, false],
    ['https://e2e.test/aurora.damocles-theme', false, false],
    ['https://e2e.test/aurora.damocles-theme', true, true],
    ['not a url', true, false],
  ])('%s with e2e %s: %s', (url, e2e, allowed) => {
    expect(releaseDownloadAllowed(url, e2e)).toBe(allowed);
  });
});

describe('assertPinned', () => {
  const bytes = new TextEncoder().encode('theme bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const downloaded = { bytes: bytes.byteLength, sha256 };

  it('accepts a download whose byte count and SHA-256 equal the pin', () => {
    expect(() => assertPinned(downloaded, { sha256, bytes: bytes.byteLength })).not.toThrow();
  });

  it('refuses a byte count other than the pin', () => {
    const refusal = (() => {
      try {
        assertPinned(downloaded, { sha256, bytes: bytes.byteLength + 1 });
      } catch (err) {
        return err;
      }
      return undefined;
    })();
    expect(refusal).toBeInstanceOf(StorePinError);
    expect((refusal as StorePinError).text.message).toBe('The downloaded theme is {0} bytes, but the community store list pins {1} bytes, so nothing was installed.');
  });

  it('refuses a download of the pinned count whose SHA-256 differs', () => {
    const other = { bytes: bytes.byteLength, sha256: createHash('sha256').update('theme bytez').digest('hex') };
    expect(() => assertPinned(other, { sha256, bytes: bytes.byteLength })).toThrow(StorePinError);
    try {
      assertPinned(other, { sha256, bytes: bytes.byteLength });
    } catch (err) {
      expect((err as StorePinError).text.message).toBe('The downloaded theme\'s SHA-256 does not match the community store list\'s pin, so nothing was installed.');
    }
  });
});
