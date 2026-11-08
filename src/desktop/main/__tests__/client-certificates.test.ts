import { EventEmitter } from 'node:events';
import type { Certificate, CertificatePrincipal, Event, WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ WebContentsView: vi.fn(), session: {}, nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() }, protocol: {} }));

import { chooseClientCertificate, probeClientCertificates, refuseClientCertificates, type ChooseClientCertificateDeps, type ClientCertificateSource, type ProbeContents, type ProbeResult } from '../client-certificates';
import { parseClientCertificateRequest, parseOverlayAnswer, parseOverlayRequest } from '../overlay';
import type { OverlayAnswer, OverlayRequest } from '../../preload/overlay-channels';

const principal = (commonName: string, fields: Partial<CertificatePrincipal> = {}): CertificatePrincipal => ({ commonName, organizations: [], organizationUnits: [], locality: '', state: '', country: '', ...fields });

const certificate = (subject: CertificatePrincipal, issuer: CertificatePrincipal = principal('Corp CA'), fingerprint = `sha256/${subject.commonName}`): Certificate => ({
  data: '',
  fingerprint,
  issuer,
  issuerCert: undefined as unknown as Certificate,
  issuerName: issuer.commonName,
  serialNumber: '01',
  subject,
  subjectName: subject.commonName,
  validExpiry: 2_000_000_000,
  validStart: 1_700_000_000,
});

const ALICE = certificate(principal('alice', { organizations: ['Corp'] }));
const BOB = certificate(principal('bob', { organizations: ['Corp'] }));

const contents = (url: string): WebContents => ({ getURL: () => url }) as unknown as WebContents;

function appWithHandler(): EventEmitter {
  const app = new EventEmitter();
  refuseClientCertificates(app as unknown as ClientCertificateSource);
  return app;
}

function ask(app: EventEmitter, webContents: WebContents | object | null, list: readonly Certificate[] = [ALICE, BOB]) {
  const preventDefault = vi.fn();
  const callback = vi.fn();
  app.emit('select-client-certificate', { preventDefault } as unknown as Event, webContents, 'mtls.example.test:8443', [...list], callback);
  return { preventDefault, callback };
}

// a probe view's webContents as the probe drives it
function probeView(): ProbeContents & { failLoad(code: number, description: string, isMainFrame?: boolean): void; readonly close: ReturnType<typeof vi.fn<() => void>>; readonly loaded: string[] } {
  const emitter = new EventEmitter();
  const loaded: string[] = [];
  return {
    on: (event, listener) => emitter.on(event, listener),
    loadURL: async (url) => void loaded.push(url),
    close: vi.fn<() => void>(),
    loaded,
    failLoad: (code, description, isMainFrame = true) => void emitter.emit('did-fail-load', {}, code, description, 'https://mtls.example.test/', isMainFrame),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('refuseClientCertificates', () => {
  it.each([
    ['an HTML preview view', contents('damocles-preview://0123456789abcdef/index.html')],
    ['a design preview view', contents('damocles-design://run/screens/home.html')],
    ['a chat view', contents('app://damocles/panel/chat')],
    ['a browser page panel', contents('app://damocles/panel/page')],
    ['unknown contents', contents('https://example.test/')],
    ['no contents', null],
  ])('answers %s with no certificate, once, and keeps Electron from picking the first one', (_name, webContents) => {
    const { preventDefault, callback } = ask(appWithHandler(), webContents);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]).toEqual([]);
  });
});

describe('probeClientCertificates', () => {
  it('reports the certificates of its own view\'s request, which still gets no certificate, and closes the view', async () => {
    const app = appWithHandler();
    const view = probeView();
    const probed = probeClientCertificates(view, 'https://mtls.example.test:8443/');
    expect(view.loaded).toEqual(['https://mtls.example.test:8443/']);
    const { preventDefault, callback } = ask(app, view);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls).toEqual([[]]);
    await expect(probed).resolves.toEqual({ kind: 'offered', certificates: [ALICE, BOB] });
    expect(view.close).toHaveBeenCalledTimes(1);
  });

  it('reaches no probe from another webContents or main\'s net, even for the probed host:port, and answers them no certificate', async () => {
    vi.useFakeTimers();
    const app = appWithHandler();
    const view = probeView();
    const settled = vi.fn();
    void probeClientCertificates(view, 'https://mtls.example.test:8443/', 1000).then(settled);
    for (const other of [contents('https://mtls.example.test:8443/'), null]) {
      const { callback } = ask(app, other);
      expect(callback.mock.calls).toEqual([[]]);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    expect(view.close).not.toHaveBeenCalled();
  });

  it('answers none when the site asks for no certificate this computer holds, and a network failure or a timeout as failed', async () => {
    const quiet = probeView();
    const none = probeClientCertificates(quiet, 'https://plain.test/');
    quiet.failLoad(-20, 'ERR_BLOCKED_BY_CLIENT');
    await expect(none).resolves.toEqual({ kind: 'none' });

    const unreachable = probeView();
    const failed = probeClientCertificates(unreachable, 'https://gone.test/');
    // a subframe's failure is not the probe's
    unreachable.failLoad(-105, 'ERR_NAME_NOT_RESOLVED', false);
    unreachable.failLoad(-105, 'ERR_NAME_NOT_RESOLVED');
    await expect(failed).resolves.toEqual({ kind: 'failed', reason: 'network', error: 'ERR_NAME_NOT_RESOLVED' });

    vi.useFakeTimers();
    const slow = probeView();
    const timedOut = probeClientCertificates(slow, 'https://slow.test/', 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(timedOut).resolves.toEqual({ kind: 'failed', reason: 'timeout' });
    expect(slow.close).toHaveBeenCalledTimes(1);
  });

  it('settles once: a certificate request after the probe failed changes nothing and still gets no certificate', async () => {
    const app = appWithHandler();
    const view = probeView();
    const probed = probeClientCertificates(view, 'https://mtls.example.test/');
    view.failLoad(-105, 'ERR_CONNECTION_RESET');
    const { callback } = ask(app, view);
    expect(callback.mock.calls).toEqual([[]]);
    await expect(probed).resolves.toEqual({ kind: 'failed', reason: 'network', error: 'ERR_CONNECTION_RESET' });
    expect(view.close).toHaveBeenCalledTimes(1);
  });
});

function flow(options: { url?: string; local?: boolean; probe?: ProbeResult; answer?: (request: OverlayRequest) => OverlayAnswer } = {}) {
  const told: Array<[string, string]> = [];
  const asked: OverlayRequest[] = [];
  const probed: string[] = [];
  const used: unknown[][] = [];
  const deps: ChooseClientCertificateDeps = {
    page: () => ({ url: options.url ?? 'https://mtls.example.test/app#section', local: options.local ?? true }),
    probe: async (url) => {
      probed.push(url);
      return options.probe ?? { kind: 'offered', certificates: [ALICE, BOB] };
    },
    ask: async (request) => {
      asked.push(request);
      return options.answer ? options.answer(request) : { kind: 'dismissed' };
    },
    use: async (origin, filter) => void used.push([origin, filter]),
    tell: (severity, message) => void told.push([severity, message]),
    t: (message, ...args) => args.reduce((text, arg, index) => text.replace(`{${index}}`, arg), message),
  };
  return { deps, told, asked, probed, used };
}

describe('chooseClientCertificate', () => {
  it('offers the site\'s certificates with subject, issuer and validity, and an opaque id to answer with', async () => {
    const { deps, asked, probed } = flow();
    await chooseClientCertificate(deps);
    // the tab's own address without its fragment: a server may ask for a certificate on a path only
    expect(probed).toEqual(['https://mtls.example.test/app']);
    expect(asked).toEqual([{
      kind: 'clientCertificate',
      site: 'mtls.example.test',
      certificates: [
        { id: '0', subject: 'alice', issuer: 'Corp CA', validStart: 1_700_000_000, validExpiry: 2_000_000_000, distinct: true },
        { id: '1', subject: 'bob', issuer: 'Corp CA', validStart: 1_700_000_000, validExpiry: 2_000_000_000, distinct: true },
      ],
    }]);
  });

  it('has core write a filter that matches only the chosen certificate, for the exact origin', async () => {
    const { deps, used, told } = flow({ url: 'https://mtls.example.test:8443/x', answer: () => ({ kind: 'clientCertificate', id: '1' }) });
    await chooseClientCertificate(deps);
    expect(used).toEqual([['https://mtls.example.test:8443', { ISSUER: { CN: 'Corp CA' }, SUBJECT: { CN: 'bob', O: 'Corp' } }]]);
    expect(told).toEqual([['info', 'The browser sends bob to mtls.example.test:8443 until you quit Damocles.']]);
  });

  it('writes nothing for Cancel or Escape, or for an id main did not offer', async () => {
    for (const answer of [{ kind: 'dismissed' }, { kind: 'clientCertificate', id: '7' }] as const) {
      const { deps, used, told } = flow({ answer: () => answer });
      await chooseClientCertificate(deps);
      expect(used).toEqual([]);
      expect(told).toEqual([]);
    }
  });

  it('marks certificates Chrome could not tell apart, which cannot be chosen', async () => {
    const twin = certificate(principal('alice', { organizations: ['Corp'], country: 'GR' }), principal('Corp CA'), 'sha256/twin');
    const { deps, asked } = flow({ probe: { kind: 'offered', certificates: [ALICE, twin, BOB] } });
    await chooseClientCertificate(deps);
    const request = asked[0] as Extract<OverlayRequest, { kind: 'clientCertificate' }>;
    expect(request.certificates.map((row) => row.distinct)).toEqual([false, false, true]);
    expect(parseOverlayAnswer({ kind: 'clientCertificate', id: '0' }, request)).toBeUndefined();
  });

  it('probes nothing for a remote chat\'s page, whose Chrome reaches the network through its host\'s proxy', async () => {
    const { deps, probed, told } = flow({ local: false });
    await chooseClientCertificate(deps);
    expect(probed).toEqual([]);
    expect(told).toEqual([['error', 'Damocles chooses client certificates only for pages of chats on this computer.']]);
  });

  it('does nothing for a page that is not https', async () => {
    const { deps, probed, told } = flow({ url: 'http://plain.test/' });
    await chooseClientCertificate(deps);
    expect(probed).toEqual([]);
    expect(told).toEqual([]);
  });

  it('says so when the site asks for no certificate, or cannot be reached', async () => {
    const quiet = flow({ probe: { kind: 'none' } });
    await chooseClientCertificate(quiet.deps);
    expect(quiet.told).toEqual([['info', 'mtls.example.test does not ask for a client certificate that this computer holds.']]);
    expect(quiet.asked).toEqual([]);
    const down = flow({ probe: { kind: 'failed', reason: 'network', error: 'ERR_NAME_NOT_RESOLVED' } });
    await chooseClientCertificate(down.deps);
    expect(down.told).toEqual([['error', 'Damocles could not reach mtls.example.test (ERR_NAME_NOT_RESOLVED).']]);
    const slow = flow({ probe: { kind: 'failed', reason: 'timeout' } });
    await chooseClientCertificate(slow.deps);
    expect(slow.told).toEqual([['error', 'mtls.example.test did not answer within 15 seconds.']]);
  });
});

describe('the certificate picker\'s overlay request', () => {
  const row = { id: '0', subject: 'alice', issuer: 'Corp CA', validStart: 1, validExpiry: 2, distinct: true };

  it('takes main\'s rows within the overlay bounds, with unique ids, and copies only the shown fields', () => {
    expect(parseClientCertificateRequest('a.test', [{ ...row, extra: 'x' } as typeof row])).toEqual({ kind: 'clientCertificate', site: 'a.test', certificates: [row] });
    expect(parseClientCertificateRequest('a.test', [])).toBeUndefined();
    expect(parseClientCertificateRequest('a.test', [row, row])).toBeUndefined();
    expect(parseClientCertificateRequest('', [row])).toBeUndefined();
    expect(parseClientCertificateRequest('a.test', [{ ...row, validStart: 1.5 }])).toBeUndefined();
    expect(parseClientCertificateRequest('a.test', Array.from({ length: 101 }, (_, index) => ({ ...row, id: String(index) })))).toBeUndefined();
  });

  it('maps an answer to one distinct row it offered, and nothing else', () => {
    const request = parseClientCertificateRequest('a.test', [row, { ...row, id: '1', distinct: false }])!;
    expect(parseOverlayAnswer({ kind: 'clientCertificate', id: '0' }, request)).toEqual({ kind: 'clientCertificate', id: '0' });
    expect(parseOverlayAnswer({ kind: 'clientCertificate', id: '1' }, request)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'clientCertificate', id: '2' }, request)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'clientCertificate', id: '0', extra: 1 }, request)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'dismissed' }, request)).toEqual({ kind: 'dismissed' });
  });

  it('is never a request the shell may open', () => {
    expect(parseOverlayRequest({ kind: 'clientCertificate', site: 'a.test', certificates: [row] })).toBeUndefined();
  });
});
