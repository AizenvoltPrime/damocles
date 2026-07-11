import { describe, it, expect } from 'vitest';
import { isPrivateOrLocalAddress, isBlockedFaviconHost } from '../net-guard';

describe('isPrivateOrLocalAddress', () => {
  it('flags IPv4 loopback, private, link-local, and cloud metadata ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata endpoint
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '224.0.0.1', // multicast
    ]) {
      expect(isPrivateOrLocalAddress(ip)).toBe(true);
    }
  });

  it('allows public IPv4 addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34']) {
      expect(isPrivateOrLocalAddress(ip)).toBe(false);
    }
  });

  it('flags IPv6 loopback, link-local, unique-local, and mapped-private', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:192.168.0.1']) {
      expect(isPrivateOrLocalAddress(ip)).toBe(true);
    }
  });

  it('allows public IPv6 and mapped-public addresses', () => {
    for (const ip of ['2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPrivateOrLocalAddress(ip)).toBe(false);
    }
  });

  it('returns false for non-IP strings (host resolution handles names)', () => {
    expect(isPrivateOrLocalAddress('example.com')).toBe(false);
  });
});

describe('isBlockedFaviconHost', () => {
  it('blocks localhost and its subdomains without DNS', async () => {
    expect(await isBlockedFaviconHost('localhost')).toBe(true);
    expect(await isBlockedFaviconHost('app.localhost')).toBe(true);
  });

  it('blocks IP-literal hosts in private ranges (incl. bracketed IPv6)', async () => {
    expect(await isBlockedFaviconHost('127.0.0.1')).toBe(true);
    expect(await isBlockedFaviconHost('192.168.0.5')).toBe(true);
    expect(await isBlockedFaviconHost('[::1]')).toBe(true);
    expect(await isBlockedFaviconHost('169.254.169.254')).toBe(true);
  });

  it('allows public IP-literal hosts', async () => {
    expect(await isBlockedFaviconHost('8.8.8.8')).toBe(false);
  });

  it('blocks a name that resolves into a private range (DNS rebinding)', async () => {
    const resolver = async () => '10.1.2.3';
    expect(await isBlockedFaviconHost('rebind.example.com', resolver)).toBe(true);
  });

  it('allows a name that resolves to a public address', async () => {
    const resolver = async () => '93.184.216.34';
    expect(await isBlockedFaviconHost('example.com', resolver)).toBe(false);
  });

  it('blocks hosts that fail to resolve (fail closed)', async () => {
    const resolver = async () => { throw new Error('ENOTFOUND'); };
    expect(await isBlockedFaviconHost('nonexistent.invalid', resolver)).toBe(true);
  });
});
