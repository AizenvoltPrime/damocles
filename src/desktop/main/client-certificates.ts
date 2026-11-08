import { randomUUID } from 'node:crypto';
import { session, WebContentsView, type Certificate, type CertificatePrincipal, type Event, type WebContents } from 'electron';
import { clientCertificateOriginOf, uniqueAutoSelectFilter, type CertificateNames, type CertificatePrincipalFields, type ClientCertificateFilter } from '../../shared/client-certificate';
import { MAX_OVERLAY_LABEL_LENGTH, type ClientCertificateRow, type OverlayAnswer, type OverlayRequest } from '../preload/overlay-channels';
import { clientCertificateChoice, parseClientCertificateRequest } from './overlay';

type SelectClientCertificateListener = (event: Event, webContents: WebContents | null, url: string, certificateList: Certificate[], callback: (certificate?: Certificate) => void) => void;

export interface ClientCertificateSource {
  on(event: 'select-client-certificate', listener: SelectClientCertificateListener): unknown;
}

// A probe's own view, whose request reports the certificates Chromium offers; any other webContents is none of these.
const probes = new WeakMap<object, (certificates: readonly Certificate[]) => void>();

/**
 * Answers every TLS client-certificate request of every webContents with no certificate. Without a handler that calls
 * preventDefault, Electron answers with the first certificate the OS store lists. No Electron webContents is the user's
 * browsing: browser pages run in the system Chrome core drives (src/core/browser).
 */
export function refuseClientCertificates(source: ClientCertificateSource): void {
  source.on('select-client-certificate', (event, webContents, _url, certificateList, callback) => {
    event.preventDefault();
    callback();
    // matched by the view, never by host:port, so a request of another webContents or of main's net (null) shows no picker
    if (webContents !== null) probes.get(webContents)?.(certificateList);
  });
}

export type ProbeResult =
  | { readonly kind: 'offered'; readonly certificates: readonly Certificate[] }
  // the site asked for no certificate, or for none this computer holds (Chromium then raises no request)
  | { readonly kind: 'none' }
  | { readonly kind: 'failed'; readonly reason: 'timeout' }
  | { readonly kind: 'failed'; readonly reason: 'network'; readonly error: string };

/** The part of a probe view's webContents the probe drives. */
export interface ProbeContents {
  on(event: 'did-fail-load', listener: (event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => void): unknown;
  loadURL(url: string): Promise<void>;
  close(): void;
}

export const PROBE_TIMEOUT_MS = 15_000;
// net::ERR_BLOCKED_BY_CLIENT: the probe session cancelled the response, so the handshake ended without a certificate request
const ERR_BLOCKED_BY_CLIENT = -20;

/**
 * Loads url in contents and resolves with the certificates Chromium offers when the site asks for one. The request is answered
 * with no certificate and contents closes once the probe settles.
 */
export function probeClientCertificates(contents: ProbeContents, url: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probes.delete(contents);
      contents.close();
      resolve(result);
    };
    const timer = setTimeout(() => settle({ kind: 'failed', reason: 'timeout' }), timeoutMs);
    probes.set(contents, (certificates) => settle({ kind: 'offered', certificates }));
    contents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (isMainFrame) settle(errorCode === ERR_BLOCKED_BY_CLIENT ? { kind: 'none' } : { kind: 'failed', reason: 'network', error: errorDescription });
    });
    // its rejection repeats the did-fail-load above
    contents.loadURL(url).catch(() => undefined);
  });
}

/**
 * A hidden view for one probe, on a fresh in-memory session with the system proxy, as local chats' Chrome runs: no script, no
 * cookies, and only its first main-frame request goes out, whose response is cancelled before any of it is read.
 */
export async function openProbeContents(): Promise<WebContents> {
  const probeSession = session.fromPartition(`client-certificate-probe-${randomUUID()}`, { cache: false });
  await probeSession.setProxy({ mode: 'system' });
  let requested = false;
  // by type, not by spelling: Chromium may normalize the address differently from WHATWG URL
  probeSession.webRequest.onBeforeRequest((details, callback) => {
    const first = !requested && details.resourceType === 'mainFrame';
    requested = true;
    callback({ cancel: !first });
  });
  probeSession.webRequest.onHeadersReceived((_details, callback) => callback({ cancel: true }));
  const view = new WebContentsView({
    webPreferences: { session: probeSession, javascript: false, images: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, disableDialogs: true, focusOnNavigation: false },
  });
  return view.webContents;
}

const fieldsOf = (principal: CertificatePrincipal): CertificatePrincipalFields => ({
  commonName: principal.commonName,
  locality: principal.locality,
  organizations: principal.organizations,
  organizationUnits: principal.organizationUnits,
});
const namesOf = (certificate: Certificate): CertificateNames => ({ subject: fieldsOf(certificate.subject), issuer: fieldsOf(certificate.issuer) });

export interface ChooseClientCertificateDeps {
  // the active browser tab: its address, and whether it is a local chat's page, whose Chrome runs with the system proxy
  readonly page: () => { readonly url: string; readonly local: boolean } | undefined;
  readonly probe: (url: string) => Promise<ProbeResult>;
  readonly ask: (request: OverlayRequest) => Promise<OverlayAnswer>;
  // core writes the rule into local chats' browser profile and restarts a running browser
  readonly use: (origin: string, filter: ClientCertificateFilter) => Promise<void>;
  readonly tell: (severity: 'info' | 'error', message: string) => void;
  readonly t: (message: string, ...args: string[]) => string;
}

/**
 * Choose Client Certificate for This Site...: offers the certificates the active page's site accepts and has local chats'
 * Chrome send the chosen one to that origin until the app quits. A remote chat's page is refused: its Chrome reaches the
 * network only through its authority's client-network proxy in core, which a probe from main would bypass.
 */
export async function chooseClientCertificate(deps: ChooseClientCertificateDeps): Promise<void> {
  const page = deps.page();
  const origin = page && clientCertificateOriginOf(page.url);
  if (!page || origin === undefined) return;
  const site = new URL(page.url).host;
  if (!page.local) {
    deps.tell('error', deps.t('Damocles chooses client certificates only for pages of chats on this computer.'));
    return;
  }
  // the tab's own address, as a server may ask for a certificate on a path only (TLS 1.2 renegotiation); the rule stays per origin
  const address = new URL(page.url);
  address.hash = '';
  const result = await deps.probe(address.href);
  if (result.kind === 'none') {
    deps.tell('info', deps.t('{0} does not ask for a client certificate that this computer holds.', site));
    return;
  }
  if (result.kind === 'failed') {
    deps.tell('error', result.reason === 'timeout' ? deps.t('{0} did not answer within {1} seconds.', site, String(PROBE_TIMEOUT_MS / 1000)) : deps.t('Damocles could not reach {0} ({1}).', site, result.error));
    return;
  }
  const names = result.certificates.map(namesOf);
  const filters = names.map((certificate) => uniqueAutoSelectFilter(certificate, names));
  const rows = result.certificates.map((certificate, index): ClientCertificateRow => ({
    id: String(index),
    subject: certificate.subjectName.slice(0, MAX_OVERLAY_LABEL_LENGTH),
    issuer: certificate.issuerName.slice(0, MAX_OVERLAY_LABEL_LENGTH),
    validStart: certificate.validStart,
    validExpiry: certificate.validExpiry,
    distinct: filters[index] !== undefined,
  }));
  const request = parseClientCertificateRequest(site, rows);
  if (!request) {
    deps.tell('error', deps.t('Damocles cannot list the client certificates {0} accepts.', site));
    return;
  }
  const id = clientCertificateChoice(await deps.ask(request));
  const index = rows.findIndex((row) => row.id === id);
  const filter = filters[index];
  if (filter === undefined) return;
  await deps.use(origin, filter);
  deps.tell('info', deps.t('The browser sends {0} to {1} until you quit Damocles.', rows[index]!.subject, site));
}
