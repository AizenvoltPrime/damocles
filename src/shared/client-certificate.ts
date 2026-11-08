// Chrome's client-certificate auto-selection rule (the AutoSelectCertificateForUrls filter format), as Damocles writes it into
// a browser profile for one site: chrome/browser/enterprise/util/managed_browser_utils.cc and
// components/certificate_matching/certificate_principal_pattern.cc.

/** A certificate's subject or issuer as Chrome's matcher reads it (Electron's CertificatePrincipal carries the same fields). */
export interface CertificatePrincipalFields {
  readonly commonName: string;
  readonly locality: string;
  readonly organizations: readonly string[];
  readonly organizationUnits: readonly string[];
}

export interface CertificateNames {
  readonly subject: CertificatePrincipalFields;
  readonly issuer: CertificatePrincipalFields;
}

/** Chrome reads only these four keys; an absent key matches anything. */
export interface PrincipalFilter {
  readonly CN?: string;
  readonly L?: string;
  readonly O?: string;
  readonly OU?: string;
}

export interface ClientCertificateFilter {
  readonly ISSUER: PrincipalFilter;
  readonly SUBJECT: PrincipalFilter;
}

// a name field longer than this is refused rather than written into the profile
export const MAX_CERTIFICATE_FIELD_CHARS = 1024;
// bounds the filter search: each O and OU list is tried value by value
const MAX_FILTER_CANDIDATES = 16;

/** CertificatePrincipalPattern::Matches: CN and L compare exactly, O and OU match any of the certificate's values. */
export function principalMatches(filter: PrincipalFilter, principal: CertificatePrincipalFields): boolean {
  if (filter.CN !== undefined && filter.CN !== principal.commonName) return false;
  if (filter.L !== undefined && filter.L !== principal.locality) return false;
  if (filter.O !== undefined && !principal.organizations.includes(filter.O)) return false;
  if (filter.OU !== undefined && !principal.organizationUnits.includes(filter.OU)) return false;
  return true;
}

export function filterMatches(filter: ClientCertificateFilter, certificate: CertificateNames): boolean {
  return principalMatches(filter.ISSUER, certificate.issuer) && principalMatches(filter.SUBJECT, certificate.subject);
}

// An empty field is no constraint in Chrome's pattern, so it is left out.
function principalFilters(principal: CertificatePrincipalFields): PrincipalFilter[] {
  const choices = (values: readonly string[]): ReadonlyArray<string | undefined> => (values.length === 0 ? [undefined] : values.slice(0, MAX_FILTER_CANDIDATES));
  const base = { ...(principal.commonName !== '' ? { CN: principal.commonName } : {}), ...(principal.locality !== '' ? { L: principal.locality } : {}) };
  return choices(principal.organizations).flatMap((organization) => choices(principal.organizationUnits).map((unit): PrincipalFilter => ({
    ...base,
    ...(organization !== undefined && organization !== '' ? { O: organization } : {}),
    ...(unit !== undefined && unit !== '' ? { OU: unit } : {}),
  })));
}

/** Whether the filter names any field; one naming nothing would match whatever certificate the site is offered later. */
export function namesCertificate(filter: ClientCertificateFilter): boolean {
  return Object.keys({ ...filter.ISSUER, ...filter.SUBJECT }).length > 0;
}

const fitsField = (value: string | undefined): boolean => value === undefined || value.length <= MAX_CERTIFICATE_FIELD_CHARS;
const fitsFilter = (filter: PrincipalFilter): boolean => fitsField(filter.CN) && fitsField(filter.L) && fitsField(filter.O) && fitsField(filter.OU);

/**
 * A filter Chrome matches to `chosen` and to no other certificate of `offered` (which holds `chosen`), or undefined when Chrome
 * could not tell `chosen` from another one by the fields its filter reads.
 */
export function uniqueAutoSelectFilter(chosen: CertificateNames, offered: readonly CertificateNames[]): ClientCertificateFilter | undefined {
  for (const SUBJECT of principalFilters(chosen.subject)) {
    for (const ISSUER of principalFilters(chosen.issuer)) {
      const filter: ClientCertificateFilter = { ISSUER, SUBJECT };
      if (!fitsFilter(ISSUER) || !fitsFilter(SUBJECT) || !namesCertificate(filter)) continue;
      if (offered.filter((certificate) => filterMatches(filter, certificate)).length === 1) return filter;
    }
  }
  return undefined;
}

// Chrome's content-setting pattern for one exact origin: a host (no "[*.]" wildcard) and an explicit port.
const ORIGIN = /^https:\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+):([1-9][0-9]{0,4})$/;

/** Whether `origin` is the exact `https://host:port` form an auto-selection rule is written for. */
export function isClientCertificateOrigin(origin: string): boolean {
  const match = ORIGIN.exec(origin);
  return match !== null && Number(match[2]) <= 65_535;
}

/** The https origin of a page address as `https://host:port`, the port spelled even when it is 443; undefined for any other scheme. */
export function clientCertificateOriginOf(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname === '') return undefined;
  const origin = `https://${parsed.hostname}:${parsed.port === '' ? '443' : parsed.port}`;
  return isClientCertificateOrigin(origin) ? origin : undefined;
}
