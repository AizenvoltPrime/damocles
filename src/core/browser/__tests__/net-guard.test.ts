import { describe, it, expect } from 'vitest';
import { publicAddresses } from '../net-guard';
import type { AddressResolver } from '../client-network-policy';

const answering = (...addresses: string[]): AddressResolver => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('publicAddresses', () => {
  it('refuses loopback, private, link-local, shared and cloud metadata literals', async () => {
    for (const host of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '[::1]', '[::]', '[fe80::1]', '[fd12:3456::1]']) {
      expect(await publicAddresses(host), host).toBeUndefined();
    }
  });

  it('refuses the IPv4-mapped literals in the canonical hex form the URL parser gives them', async () => {
    for (const written of ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:192.168.1.1]/', 'http://[::ffff:169.254.169.254]/']) {
      const host = new URL(written).hostname;
      expect(['[::ffff:7f00:1]', '[::ffff:c0a8:101]', '[::ffff:a9fe:a9fe]']).toContain(host);
      expect(await publicAddresses(host), host).toBeUndefined();
    }
  });

  it('passes public literals as written', async () => {
    expect(await publicAddresses('93.184.216.34')).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(await publicAddresses('[2606:4700:4700::1111]')).toEqual([{ address: '2606:4700:4700::1111', family: 6 }]);
  });

  it('refuses a name with any blocked answer, mapped forms included, even beside a public one', async () => {
    expect(await publicAddresses('rebind.example', answering('10.1.2.3'))).toBeUndefined();
    expect(await publicAddresses('mixed.example', answering('93.184.216.34', '::ffff:7f00:1'))).toBeUndefined();
  });

  it('passes every public answer of a name, in the resolver\'s order', async () => {
    expect(await publicAddresses('example.com', answering('2606:2800:220:1::1', '93.184.216.34'))).toEqual([
      { address: '2606:2800:220:1::1', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ]);
  });

  it('refuses a name that resolves to nothing or fails to resolve', async () => {
    expect(await publicAddresses('empty.invalid', answering())).toBeUndefined();
    expect(await publicAddresses('nonexistent.invalid', async () => { throw new Error('ENOTFOUND'); })).toBeUndefined();
  });
});
