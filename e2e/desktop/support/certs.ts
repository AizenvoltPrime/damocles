import * as crypto from 'node:crypto';

// Minimal DER writer for X.509 v3 certificates (RFC 5280), enough for a test CA and a TLS leaf.

function der(tag: number, content: Buffer): Buffer {
  const len = content.length;
  let header: Buffer;
  if (len < 0x80) header = Buffer.from([tag, len]);
  else {
    const bytes: number[] = [];
    for (let n = len; n > 0; n >>= 8) bytes.unshift(n & 0xff);
    header = Buffer.from([tag, 0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([header, content]);
}

const seq = (...parts: Buffer[]): Buffer => der(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => der(0x31, Buffer.concat(parts));
const explicit = (n: number, inner: Buffer): Buffer => der(0xa0 + n, inner);
const octets = (b: Buffer): Buffer => der(0x04, b);
const bitString = (b: Buffer, unusedBits = 0): Buffer => der(0x03, Buffer.concat([Buffer.from([unusedBits]), b]));
const bool = (v: boolean): Buffer => der(0x01, Buffer.from([v ? 0xff : 0x00]));
const utf8 = (s: string): Buffer => der(0x0c, Buffer.from(s, 'utf8'));

function integer(b: Buffer): Buffer {
  return der(0x02, b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
}

function oid(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number);
  const out: number[] = [40 * arcs[0]! + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [];
    let v = arc;
    do {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i]! |= 0x80;
    out.push(...chunk);
  }
  return der(0x06, Buffer.from(out));
}

function utcTime(d: Date): Buffer {
  const p = (n: number): string => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(s, 'ascii'));
}

const name = (cn: string): Buffer => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const extension = (id: string, critical: boolean, value: Buffer): Buffer =>
  seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function keyId(publicKey: crypto.KeyObject): Buffer {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  // RFC 7093 allows any consistent key id method; the leaf's AKID only has to equal the CA's SKI.
  return crypto.createHash('sha1').update(spki).digest();
}

function ipBytes(ip: string): Buffer {
  return Buffer.from(ip.split('.').map(Number));
}

interface CertSpec {
  subject: string;
  publicKey: crypto.KeyObject;
  issuer: string;
  issuerKey: crypto.KeyObject;
  issuerPublicKey: crypto.KeyObject;
  isCa: boolean;
  dnsNames?: string[];
  ips?: string[];
}

function issue(spec: CertSpec): string {
  const now = Date.now();
  const serial = crypto.randomBytes(16);
  // DER INTEGER: positive and minimal, so the first byte is neither 0x00 nor above 0x7f.
  serial[0] = 0x01 + (serial[0]! % 0x7f);
  const extensions: Buffer[] = [
    extension('2.5.29.19', true, spec.isCa ? seq(bool(true)) : seq()),
    // keyUsage: keyCertSign|cRLSign for the CA, digitalSignature for the leaf.
    extension('2.5.29.15', true, spec.isCa ? bitString(Buffer.from([0x06]), 1) : bitString(Buffer.from([0x80]), 7)),
    extension('2.5.29.14', false, octets(keyId(spec.publicKey))),
    extension('2.5.29.35', false, seq(der(0x80, keyId(spec.issuerPublicKey)))),
  ];
  if (!spec.isCa) {
    extensions.push(extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))));
    const altNames = [
      ...(spec.dnsNames ?? []).map((d) => der(0x82, Buffer.from(d, 'ascii'))),
      ...(spec.ips ?? []).map((ip) => der(0x87, ipBytes(ip))),
    ];
    extensions.push(extension('2.5.29.17', false, seq(...altNames)));
  }
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    ECDSA_SHA256,
    name(spec.issuer),
    seq(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 7 * 86_400_000))),
    name(spec.subject),
    spec.publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...extensions)),
  );
  const signature = crypto.sign('sha256', tbs, spec.issuerKey);
  const cert = seq(tbs, ECDSA_SHA256, bitString(signature));
  const b64 = cert.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd();
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

export interface TestPki {
  caCertPem: string;
  leafCertPem: string;
  leafKeyPem: string;
}

/** A fresh CA and a server certificate it signs, valid for the given host names and loopback IP. */
export function createTestPki(dnsNames: string[]): TestPki {
  const ca = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const leaf = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const caName = `Damocles E2E Test CA ${crypto.randomBytes(4).toString('hex')}`;
  const caCertPem = issue({
    subject: caName,
    publicKey: ca.publicKey,
    issuer: caName,
    issuerKey: ca.privateKey,
    issuerPublicKey: ca.publicKey,
    isCa: true,
  });
  const leafCertPem = issue({
    subject: dnsNames[0] ?? 'localhost',
    publicKey: leaf.publicKey,
    issuer: caName,
    issuerKey: ca.privateKey,
    issuerPublicKey: ca.publicKey,
    isCa: false,
    dnsNames,
    ips: ['127.0.0.1'],
  });
  const caX509 = new crypto.X509Certificate(caCertPem);
  const leafX509 = new crypto.X509Certificate(leafCertPem);
  if (!leafX509.verify(caX509.publicKey) || !leafX509.checkIssued(caX509)) {
    throw new Error('createTestPki: generated leaf does not verify against its CA');
  }
  return {
    caCertPem,
    leafCertPem,
    leafKeyPem: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
