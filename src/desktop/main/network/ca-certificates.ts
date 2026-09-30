import { X509Certificate } from 'node:crypto';
import * as fs from 'node:fs';
import * as tls from 'node:tls';
import type { StartupLog } from '../shell-env';

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/g;

/** The certificates in the PEM file NODE_EXTRA_CA_CERTS names; an unreadable file or block is logged and skipped. */
function extraCertificates(log: StartupLog): string[] {
  const file = process.env['NODE_EXTRA_CA_CERTS'];
  if (!file) return [];
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log(`[network] NODE_EXTRA_CA_CERTS=${file} is unreadable, ignoring it: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const certificates: string[] = [];
  for (const pem of text.match(PEM_CERTIFICATE) ?? []) {
    try {
      new X509Certificate(pem);
      certificates.push(pem);
    } catch (err) {
      log(`[network] skipping an invalid certificate in ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (certificates.length === 0) log(`[network] NODE_EXTRA_CA_CERTS=${file} holds no certificate`);
  return certificates;
}

/**
 * Trust Node's bundled roots, the OS store and the NODE_EXTRA_CA_CERTS file for every later TLS connection
 * in this process. Must run after `mergeLoginShellEnv`, which is where NODE_EXTRA_CA_CERTS can first
 * appear on macOS and Linux, and before any TLS connection opens.
 */
export function installCaCertificates(log: StartupLog): void {
  const bundled = tls.getCACertificates('bundled');
  const system = tls.getCACertificates('system');
  const extra = extraCertificates(log);
  // The OS store repeats most bundled roots in another PEM layout, so identity is the DER fingerprint.
  const byFingerprint = new Map<string, string>();
  for (const pem of [...bundled, ...system, ...extra]) {
    const fingerprint = new X509Certificate(pem).fingerprint256;
    if (!byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, pem);
  }
  tls.setDefaultCACertificates([...byFingerprint.values()]);
  log(`[network] trusting ${byFingerprint.size} CA certificates (bundled ${bundled.length}, system ${system.length}, extra ${extra.length})`);
}
