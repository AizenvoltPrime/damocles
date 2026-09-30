import { X509Certificate } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCaCertificates } from '../ca-certificates';

let dir: string;
const saved = process.env['NODE_EXTRA_CA_CERTS'];
const lines: string[] = [];
const log = (line: string): void => {
  lines.push(line);
};

const fingerprints = (pems: readonly string[]): Set<string> => new Set(pems.map((pem) => new X509Certificate(pem).fingerprint256));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-ca-'));
  lines.length = 0;
});

afterEach(() => {
  if (saved === undefined) delete process.env['NODE_EXTRA_CA_CERTS'];
  else process.env['NODE_EXTRA_CA_CERTS'] = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('installCaCertificates', () => {
  it('trusts the bundled roots, the OS store and the NODE_EXTRA_CA_CERTS file set after process start', () => {
    // Any real certificate works as the "private CA"; an unused one from the OS store is not guaranteed, so reuse a bundled one.
    const extra = tls.getCACertificates('bundled')[0]!;
    const file = path.join(dir, 'corp-ca.pem');
    fs.writeFileSync(file, `# corporate bundle\n${extra}\n-----BEGIN CERTIFICATE-----\nnot base64 at all!\n-----END CERTIFICATE-----\n`);
    process.env['NODE_EXTRA_CA_CERTS'] = file;

    installCaCertificates(log);

    const trusted = fingerprints(tls.getCACertificates('default'));
    const expected = fingerprints([...tls.getCACertificates('bundled'), ...tls.getCACertificates('system'), extra]);
    expect(trusted).toEqual(expected);
    expect(lines.some((line) => line.includes('extra 1'))).toBe(true);
  });

  it('logs an unreadable NODE_EXTRA_CA_CERTS and still installs the bundled and OS roots', () => {
    process.env['NODE_EXTRA_CA_CERTS'] = path.join(dir, 'missing.pem');
    installCaCertificates(log);
    expect(lines.some((line) => line.includes('is unreadable'))).toBe(true);
    expect(fingerprints(tls.getCACertificates('default'))).toEqual(
      fingerprints([...tls.getCACertificates('bundled'), ...tls.getCACertificates('system')]),
    );
  });
});
