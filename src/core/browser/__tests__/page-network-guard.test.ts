import { describe, it, expect, vi } from 'vitest';
import { installLogSink } from '../../logger';
import { PageController } from '../page-controller';
import { foreignGrantPort, grantRefusalMessage, installPageNetworkGuard, redirectRefusalMessage, redirectVerdict, PAGE_GUARD_PATTERNS, type RefusedRedirect } from '../page-network-guard';

const REQUEST = 'https://site.example/start?x=1';
const OWNS_NONE = (): boolean => false;
const LABEL_A = '0123456789abcdef0123456789abcdef';
const LABEL_B = 'fedcba9876543210fedcba9876543210';
const GRANT_A = `http://${LABEL_A}.localhost:5000`;

function redirect(location: string, status = 302) {
  return { request: { url: REQUEST }, responseStatusCode: status, responseHeaders: [{ name: 'Location', value: location }] };
}

const refusedTo = (scheme: string | undefined, hop = REQUEST): RefusedRedirect => ({ kind: 'redirect', hop, scheme });

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Chrome's Fetch.RequestPattern.urlPattern match over the whole URL: '*' zero or more characters, '?' exactly one, '\' escapes.
function cdpPatternMatches(pattern: string, url: string): boolean {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '\\') source += escapeRegExp(pattern[++i] ?? '');
    else if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`, 's').test(url);
}

describe('redirectVerdict', () => {
  it('lets a redirect to http, https or exactly about:blank through', () => {
    expect(redirectVerdict(redirect('https://other.example/'))).toBeUndefined();
    expect(redirectVerdict(redirect('http://other.example/'))).toBeUndefined();
    expect(redirectVerdict(redirect('about:blank'))).toBeUndefined();
  });

  it('resolves a relative Location against the request URL', () => {
    expect(redirectVerdict(redirect('/next'))).toBeUndefined();
    expect(redirectVerdict(redirect('next?y=2'))).toBeUndefined();
    expect(redirectVerdict(redirect('//cdn.example/x'))).toBeUndefined();
  });

  it('refuses every other scheme, naming it', () => {
    for (const [location, scheme] of [
      ['mailto:someone@example.com', 'mailto:'],
      ['ms-settings:privacy', 'ms-settings:'],
      ['damocles-it-unregistered:probe', 'damocles-it-unregistered:'],
      ['javascript:alert(1)', 'javascript:'],
      ['data:text/html,hi', 'data:'],
      ['file:///C:/Windows/win.ini', 'file:'],
      ['about:blank#x', 'about:'],
      ['about:blank?x', 'about:'],
      ['about:srcdoc', 'about:'],
      ['chrome://settings', 'chrome:'],
    ] as const) {
      expect(redirectVerdict(redirect(location)), location).toEqual(refusedTo(scheme));
    }
  });

  it('reads the scheme case-blind, as Chrome does', () => {
    expect(redirectVerdict(redirect('MailTo:someone@example.com'))).toEqual(refusedTo('mailto:'));
    expect(redirectVerdict(redirect('HTTPS://other.example/'))).toBeUndefined();
  });

  it('checks a Location under any header-name case and every Location header', () => {
    expect(redirectVerdict({ ...redirect('x'), responseHeaders: [{ name: 'location', value: 'mailto:a@b' }] })).toEqual(refusedTo('mailto:'));
    const two = { ...redirect('x'), responseHeaders: [{ name: 'Location', value: '/ok' }, { name: 'LOCATION', value: 'mailto:a@b' }] };
    expect(redirectVerdict(two)).toEqual(refusedTo('mailto:'));
  });

  it('refuses a Location that does not resolve to a URL', () => {
    expect(redirectVerdict(redirect('http://[::1'))).toEqual(refusedTo(undefined));
  });

  it('records the URL of the hop that sent the refused redirect', () => {
    const hop = 'https://b.example/next?token=secret';
    expect(redirectVerdict({ ...redirect('mailto:a@b'), request: { url: hop } })).toEqual(refusedTo('mailto:', hop));
  });

  it('applies to the statuses Chrome follows a Location for, and to nothing else', () => {
    for (const status of [301, 302, 303, 307, 308]) expect(redirectVerdict(redirect('mailto:a@b', status)), String(status)).toEqual(refusedTo('mailto:'));
    for (const status of [200, 201, 300, 304, 404]) expect(redirectVerdict(redirect('mailto:a@b', status)), String(status)).toBeUndefined();
    expect(redirectVerdict({ request: { url: REQUEST } })).toBeUndefined();
    expect(redirectVerdict({ request: { url: REQUEST }, responseStatusCode: 302, responseHeaders: [] })).toBeUndefined();
    // an empty Location resolves to the request URL; Chrome reads it as no redirect at all
    expect(redirectVerdict(redirect(''))).toBeUndefined();
  });

  it('words the refusal with the scheme, or as an incomplete URL', () => {
    expect(redirectRefusalMessage('https://site.example', refusedTo('mailto:'))).toBe(
      'https://site.example redirected to a mailto: address; the browser opens only http and https URLs and about:blank, at every redirect.',
    );
    expect(redirectRefusalMessage('https://site.example', refusedTo(undefined))).toContain('redirected to an address that is not a complete URL');
  });

  it('words a refused served page as belonging to another chat', () => {
    expect(grantRefusalMessage('a served page on port 5000')).toBe('Navigation to a served page on port 5000 failed: that served page belongs to another chat (net::ERR_BLOCKED_BY_CLIENT).');
  });
});

describe('foreignGrantPort', () => {
  const ownsA = (origin: string): boolean => origin === GRANT_A;

  it("names the port of a served grant host the page's chat does not hold", () => {
    expect(foreignGrantPort(`http://${LABEL_B}.localhost:5000/index.html`, ownsA)).toBe('5000');
    expect(foreignGrantPort(`http://${LABEL_A}.localhost:5001/index.html`, ownsA)).toBe('5001');
    expect(foreignGrantPort(`http://${LABEL_A}.localhost.:5000/index.html`, ownsA)).toBe('5000');
    expect(foreignGrantPort(`https://${LABEL_A}.localhost:5000/index.html`, ownsA)).toBe('5000');
    expect(foreignGrantPort(`${GRANT_A}/x`, OWNS_NONE)).toBe('5000');
  });

  it("passes the chat's own grant origin, whatever the path or query, and every host that is no grant's", () => {
    expect(foreignGrantPort(`${GRANT_A}/__damocles_preview/open?t=x&p=index.html`, ownsA)).toBeUndefined();
    expect(foreignGrantPort(`http://${LABEL_A.toUpperCase()}.LOCALHOST:5000/a.css`, ownsA)).toBeUndefined();
    for (const url of ['http://localhost:5000/', 'http://app.localhost:5000/', 'http://127.0.0.1:5000/', `http://${LABEL_B}.example:5000/`, 'https://site.example/', 'not a url']) {
      expect(foreignGrantPort(url, OWNS_NONE), url).toBeUndefined();
    }
  });
});

type Paused = { requestId: string; networkId?: string; request: { url: string }; responseStatusCode?: number; responseHeaders?: Array<{ name: string; value: string }> };

function fakeSession(send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
  let listener: ((event: Paused) => void) | undefined;
  const order: string[] = [];
  const session = {
    on: (event: string, handler: (event: Paused) => void) => {
      order.push(`on ${event}`);
      listener = handler;
    },
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      order.push(method);
      return send(method, params);
    }),
  };
  return { session, order, pause: (event: Paused) => listener!(event) };
}

describe('installPageNetworkGuard', () => {
  it('listens, bypasses service workers, then enables Fetch, with the Document Response-stage and grant-host Request-stage patterns', async () => {
    const { session, order } = fakeSession(async () => ({}));
    await installPageNetworkGuard(session as never, new PageController({} as never, session as never), OWNS_NONE);
    expect(order).toEqual(['on Fetch.requestPaused', 'Network.enable', 'Network.setBypassServiceWorker', 'Fetch.enable']);
    // Chrome ignores the bypass on a session whose Network domain is off; this session keeps no response bodies
    expect(session.send).toHaveBeenCalledWith('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
    expect(session.send).toHaveBeenCalledWith('Network.setBypassServiceWorker', { bypass: true });
    expect(session.send).toHaveBeenCalledWith('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Response' }, { urlPattern: 'http://*????????????????????????????????.localhost:*', requestStage: 'Request' }] });
    expect(session.send).toHaveBeenCalledWith('Fetch.enable', { patterns: PAGE_GUARD_PATTERNS });
  });

  it('pauses at the Request stage every request to a grant-shaped host, userinfo included, and no *.localhost server with a shorter name', () => {
    const pattern = PAGE_GUARD_PATTERNS[1].urlPattern;
    // a name of 32 characters or more pauses too, and the verdict continues it
    for (const url of ['http://my-long-dev-server-name-frontend-app.localhost:3000/', `${GRANT_A}/`, `${GRANT_A}/__damocles_preview/open?t=x&p=index.html`, `http://${LABEL_B}.localhost:65535/a/b.css`, `http://user:pass@${LABEL_A}.localhost:5000/`, `http://user@${LABEL_A}.localhost:5000/x`]) {
      expect(cdpPatternMatches(pattern, url), url).toBe(true);
    }
    for (const url of ['http://app.localhost:5173/', 'http://localhost:5000/', 'http://127.0.0.1:5000/', `http://${LABEL_A.slice(1)}.localhost:5000/`, `https://${LABEL_A}.localhost:5000/`, `http://${LABEL_A}.example:5000/`]) {
      expect(cdpPatternMatches(pattern, url), url).toBe(false);
    }
  });

  it('sends the three install commands before any answers, and resolves only once all have', async () => {
    const answers: Array<() => void> = [];
    const { session, order } = fakeSession(() => new Promise((resolve) => answers.push(() => resolve({}))));
    let installed = false;
    const install = installPageNetworkGuard(session as never, new PageController({} as never, session as never), OWNS_NONE).then(() => { installed = true; });
    await Promise.resolve();
    expect(order).toEqual(['on Fetch.requestPaused', 'Network.enable', 'Network.setBypassServiceWorker', 'Fetch.enable']);
    answers[0]!();
    answers[1]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(installed).toBe(false);
    answers[2]!();
    await install;
    expect(installed).toBe(true);
  });

  it("fails a request to a served grant host the page's chat does not hold, read at each request, and continues the rest", async () => {
    const logged: string[] = [];
    installLogSink({ appendLine: (line: string) => void logged.push(line), show: () => undefined, dispose: () => undefined });
    const { session, pause } = fakeSession(async () => ({}));
    const owned = new Set<string>();
    const guard = await installPageNetworkGuard(session as never, new PageController({} as never, session as never), (origin) => owned.has(origin));
    session.send.mockClear();

    pause({ requestId: 'r1', networkId: 'L1', request: { url: `${GRANT_A}/index.html` } });
    // recorded by networkId, so the navigation that made it can name the reason
    expect(guard.refusal('L1')).toEqual({ kind: 'foreignGrant', url: `${GRANT_A}/index.html` });
    owned.add(GRANT_A);
    pause({ requestId: 'r2', networkId: 'L2', request: { url: `${GRANT_A}/index.html` } });
    pause({ requestId: 'r3', networkId: 'L3', request: { url: `${GRANT_A}/app.js` } });
    pause({ requestId: 'r4', networkId: 'L4', request: { url: `http://${LABEL_B}.localhost:5000/index.html` } });
    pause({ requestId: 'r5', networkId: 'L5', request: { url: `http://${LABEL_B}.localhost:5000/other.html` } });
    pause({ requestId: 'r6', networkId: 'L6', request: { url: 'http://app.localhost:5173/' } });
    // a refused grant request is no refused redirect: its Response-stage pause never comes, and a redirect to it is still checked
    pause({ requestId: 'r7', networkId: 'L7', request: { url: `http://${LABEL_B}.localhost:5000/x` }, responseStatusCode: 302, responseHeaders: [{ name: 'Location', value: 'mailto:a@b' }] });

    expect(session.send.mock.calls).toEqual([
      ['Fetch.failRequest', { requestId: 'r1', errorReason: 'BlockedByClient' }],
      ['Fetch.continueRequest', { requestId: 'r2' }],
      ['Fetch.continueRequest', { requestId: 'r3' }],
      ['Fetch.failRequest', { requestId: 'r4', errorReason: 'BlockedByClient' }],
      ['Fetch.failRequest', { requestId: 'r5', errorReason: 'BlockedByClient' }],
      ['Fetch.continueRequest', { requestId: 'r6' }],
      ['Fetch.failRequest', { requestId: 'r7', errorReason: 'BlockedByClient' }],
    ]);
    expect(guard.refusal('L1')).toBeUndefined();
    expect(guard.refusal('L7')).toEqual({ kind: 'foreignGrant', url: `http://${LABEL_B}.localhost:5000/x` });
    // one line per port, naming the port and never a label
    const refusals = logged.filter((line) => line.includes("Refused a page's request to a served page"));
    expect(refusals).toEqual([expect.stringMatching(/\] \[Browser\] Refused a page's request to a served page on port 5000, which its chat does not hold$/)]);
    expect(logged.join('\n')).not.toMatch(/[0-9a-f]{32}/);
  });

  it('answers each paused request exactly once: fails a refused redirect, continues everything else', async () => {
    const { session, pause } = fakeSession(async () => ({}));
    const guard = await installPageNetworkGuard(session as never, new PageController({} as never, session as never), OWNS_NONE);
    session.send.mockClear();

    pause({ requestId: 'r1', networkId: 'L1', request: { url: REQUEST }, responseStatusCode: 302, responseHeaders: [{ name: 'location', value: 'mailto:a@b' }] });
    pause({ requestId: 'r2', networkId: 'L2', request: { url: REQUEST }, responseStatusCode: 302, responseHeaders: [{ name: 'location', value: '/next' }] });
    pause({ requestId: 'r3', networkId: 'L2', request: { url: REQUEST }, responseStatusCode: 200, responseHeaders: [] });

    expect(session.send.mock.calls).toEqual([
      ['Fetch.failRequest', { requestId: 'r1', errorReason: 'BlockedByClient' }],
      ['Fetch.continueRequest', { requestId: 'r2' }],
      ['Fetch.continueRequest', { requestId: 'r3' }],
    ]);
    expect(guard.refusal('L1')).toEqual(refusedTo('mailto:'));
    expect(guard.refusal('L2')).toBeUndefined();
  });

  it('logs an answer Chrome rejects and sends no second one', async () => {
    const logged: string[] = [];
    installLogSink({ appendLine: (line: string) => void logged.push(line), show: () => undefined, dispose: () => undefined });
    const { session, pause } = fakeSession(async (method) => {
      if (method === 'Fetch.continueRequest') throw new Error('Invalid InterceptionId.');
      return {};
    });
    await installPageNetworkGuard(session as never, new PageController({} as never, session as never), OWNS_NONE);
    session.send.mockClear();

    pause({ requestId: 'r1', request: { url: REQUEST }, responseStatusCode: 200 });
    await vi.waitFor(() => expect(logged.some((line) => line.includes('Invalid InterceptionId.'))).toBe(true));
    expect(session.send).toHaveBeenCalledTimes(1);
  });

  it('keeps only the latest refusal, matched by the navigation\'s loaderId', async () => {
    const { session, pause } = fakeSession(async () => ({}));
    const guard = await installPageNetworkGuard(session as never, new PageController({} as never, session as never), OWNS_NONE);
    pause({ requestId: 'r1', networkId: 'L1', request: { url: REQUEST }, responseStatusCode: 301, responseHeaders: [{ name: 'Location', value: 'ms-settings:' }] });
    pause({ requestId: 'r2', networkId: 'L2', request: { url: REQUEST }, responseStatusCode: 307, responseHeaders: [{ name: 'Location', value: 'data:,x' }] });
    expect(guard.refusal('L1')).toBeUndefined();
    expect(guard.refusal('L2')).toEqual(refusedTo('data:'));
  });

  it('logs a refused redirect once per scheme, naming only the scheme', async () => {
    const logged: string[] = [];
    installLogSink({ appendLine: (line: string) => void logged.push(line), show: () => undefined, dispose: () => undefined });
    const { session, pause } = fakeSession(async () => ({}));
    await installPageNetworkGuard(session as never, new PageController({} as never, session as never), OWNS_NONE);
    const hop = (requestId: string, location: string): void =>
      pause({ requestId, request: { url: 'https://a.example/go?token=secret' }, responseStatusCode: 302, responseHeaders: [{ name: 'Location', value: location }] });
    hop('r1', 'mailto:a@b');
    hop('r2', 'mailto:c@d');
    hop('r3', 'ms-settings:privacy');
    hop('r4', 'http://[::1');
    hop('r5', 'http://[::2');
    expect(logged.filter((line) => line.includes("Refused a page's redirect")).map((line) => line.replace(/^.*\] \[Browser\] /, ''))).toEqual([
      "Refused a page's redirect to a mailto: address",
      "Refused a page's redirect to a ms-settings: address",
      "Refused a page's redirect to an address that is not a complete URL",
    ]);
    expect(logged.join('\n')).not.toContain('secret');
  });

  it('fails a request whose verdict throws, logging once, and keeps judging the rest', async () => {
    const logged: string[] = [];
    installLogSink({ appendLine: (line: string) => void logged.push(line), show: () => undefined, dispose: () => undefined });
    const { session, pause } = fakeSession(async () => ({}));
    const guard = await installPageNetworkGuard(session as never, new PageController({} as never, session as never), () => {
      throw new Error('served pages unavailable');
    });
    session.send.mockClear();

    expect(() => pause({ requestId: 'r1', networkId: 'L1', request: { url: `${GRANT_A}/index.html` } })).not.toThrow();
    pause({ requestId: 'r2', networkId: 'L2', request: { url: `${GRANT_A}/app.js` } });
    pause({ requestId: 'r3', networkId: 'L3', request: { url: REQUEST }, responseStatusCode: 200 });

    expect(session.send.mock.calls).toEqual([
      ['Fetch.failRequest', { requestId: 'r1', errorReason: 'BlockedByClient' }],
      ['Fetch.failRequest', { requestId: 'r2', errorReason: 'BlockedByClient' }],
      ['Fetch.continueRequest', { requestId: 'r3' }],
    ]);
    expect(guard.refusal('L1')).toBeUndefined();
    const failures = logged.filter((line) => line.includes('could not judge'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/Navigation guard refused a request it could not judge — served pages unavailable$/);
    expect(logged.join('\n')).not.toMatch(/[0-9a-f]{32}/);
  });

  it('rejects when Chrome refuses Fetch.enable, so the caller never shows an unguarded page', async () => {
    const { session } = fakeSession(async (method) => {
      if (method === 'Fetch.enable') throw new Error('Target closed');
      return {};
    });
    await expect(installPageNetworkGuard(session as never, new PageController({} as never, session as never), OWNS_NONE)).rejects.toThrow('Target closed');
  });

  it.each(['Network.enable', 'Network.setBypassServiceWorker'])('rejects when Chrome refuses %s, so no page a service worker could answer is shown', async (refused) => {
    const { session } = fakeSession(async (method) => {
      if (method === refused) throw new Error('Target closed');
      return {};
    });
    await expect(installPageNetworkGuard(session as never, new PageController({} as never, session as never), OWNS_NONE)).rejects.toThrow('Target closed');
  });
});
