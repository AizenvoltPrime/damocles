import { describe, expect, it } from 'vitest';
import { clientCertificateOriginOf, filterMatches, isClientCertificateOrigin, uniqueAutoSelectFilter, type CertificateNames, type CertificatePrincipalFields } from '../client-certificate';

const principal = (fields: Partial<CertificatePrincipalFields>): CertificatePrincipalFields => ({ commonName: '', locality: '', organizations: [], organizationUnits: [], ...fields });
const cert = (subject: Partial<CertificatePrincipalFields>, issuer: Partial<CertificatePrincipalFields> = { commonName: 'Corp CA' }): CertificateNames => ({ subject: principal(subject), issuer: principal(issuer) });

describe('uniqueAutoSelectFilter', () => {
  it('names the chosen certificate by its subject and issuer fields', () => {
    const alice = cert({ commonName: 'alice', organizations: ['Corp'] });
    const bob = cert({ commonName: 'bob', organizations: ['Corp'] });
    const filter = uniqueAutoSelectFilter(alice, [alice, bob]);
    expect(filter).toEqual({ ISSUER: { CN: 'Corp CA' }, SUBJECT: { CN: 'alice', O: 'Corp' } });
    expect(filterMatches(filter!, alice)).toBe(true);
    expect(filterMatches(filter!, bob)).toBe(false);
  });

  it('refuses two certificates that differ only in fields Chrome does not read (country, state, serial)', () => {
    // CertificateNames carries no country, state or serial, as Chrome's filter reads none of them, so these two are equal to it
    const here = cert({ commonName: 'device', organizations: ['Corp'] });
    const there = cert({ commonName: 'device', organizations: ['Corp'] });
    expect(uniqueAutoSelectFilter(here, [here, there])).toBeUndefined();
  });

  it('tells apart two certificates that differ in one of several OUs only by naming that OU', () => {
    const sales = cert({ commonName: 'device', organizationUnits: ['Laptops', 'Sales'] });
    const support = cert({ commonName: 'device', organizationUnits: ['Laptops', 'Support'] });
    const filter = uniqueAutoSelectFilter(sales, [sales, support]);
    expect(filter?.SUBJECT.OU).toBe('Sales');
    expect([sales, support].filter((candidate) => filterMatches(filter!, candidate))).toEqual([sales]);
  });

  it('tells apart two certificates by their issuer when their subjects are equal', () => {
    const fromA = cert({ commonName: 'device' }, { commonName: 'CA one' });
    const fromB = cert({ commonName: 'device' }, { commonName: 'CA two' });
    expect(uniqueAutoSelectFilter(fromB, [fromA, fromB])).toEqual({ ISSUER: { CN: 'CA two' }, SUBJECT: { CN: 'device' } });
  });

  it('writes no filter that names nothing, which would match any certificate', () => {
    const blank = cert({}, {});
    expect(uniqueAutoSelectFilter(blank, [blank])).toBeUndefined();
  });

  it('matches O and OU against any of the certificate values, and CN and L exactly', () => {
    const subject = cert({ commonName: 'a', locality: 'Athens', organizations: ['X', 'Y'], organizationUnits: ['U'] });
    expect(filterMatches({ ISSUER: {}, SUBJECT: { O: 'Y' } }, subject)).toBe(true);
    expect(filterMatches({ ISSUER: {}, SUBJECT: { CN: 'A' } }, subject)).toBe(false);
    expect(filterMatches({ ISSUER: {}, SUBJECT: { L: 'athens' } }, subject)).toBe(false);
  });
});

describe('client certificate origins', () => {
  it('spells the exact https origin with its port', () => {
    expect(clientCertificateOriginOf('https://Intranet.Example.com/app?x=1#y')).toBe('https://intranet.example.com:443');
    expect(clientCertificateOriginOf('https://example.com:8443/')).toBe('https://example.com:8443');
    expect(clientCertificateOriginOf('https://[::1]:9443/')).toBe('https://[::1]:9443');
  });

  it('has none for a page that is not https', () => {
    expect(clientCertificateOriginOf('http://example.com/')).toBeUndefined();
    expect(clientCertificateOriginOf('about:blank')).toBeUndefined();
    expect(clientCertificateOriginOf('not a url')).toBeUndefined();
  });

  it('accepts only the exact form, never a wildcard pattern', () => {
    expect(isClientCertificateOrigin('https://example.com:443')).toBe(true);
    expect(isClientCertificateOrigin('https://[*.]example.com:443')).toBe(false);
    expect(isClientCertificateOrigin('https://example.com')).toBe(false);
    expect(isClientCertificateOrigin('https://example.com:443/')).toBe(false);
    expect(isClientCertificateOrigin('https://example.com:65536')).toBe(false);
    expect(isClientCertificateOrigin('http://example.com:80')).toBe(false);
    expect(isClientCertificateOrigin('https://example.com:443,*')).toBe(false);
  });
});
