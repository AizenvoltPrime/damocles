import { describe, expect, it } from 'vitest';
import { isTargetLoopbackHost, rewriteInbound, rewriteOutbound, type ForwardingTunnels, type RewriteTarget, type RewriteTunnel } from '../url-rewrite';

const AUTHORITY = 'ssh-remote+prod-1';

// A TunnelManager double: list per authority, and forward choosing the next free local port from 5174.
function tunnels(initial: RewriteTunnel[] = []): ForwardingTunnels & { forwarded: RewriteTarget[]; all: RewriteTunnel[] } {
  const all = [...initial];
  const forwarded: RewriteTarget[] = [];
  return {
    all,
    forwarded,
    list: (authority) => (authority === AUTHORITY ? all : []),
    forward: async (authority, remote) => {
      expect(authority).toBe(AUTHORITY);
      forwarded.push(remote);
      const tunnel = { localPort: 5174 + all.length, remote };
      all.push(tunnel);
      return tunnel;
    },
  };
}

describe('isTargetLoopbackHost', () => {
  it('names the target for every loopback and all-interfaces form', () => {
    for (const host of ['localhost', 'LOCALHOST', 'localhost.', 'app.localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0', '[::1]', '::1', '[::]', '[::ffff:7f00:1]', '::ffff:127.0.0.1', '[::ffff:0:0]']) {
      expect(isTargetLoopbackHost(host), host).toBe(true);
    }
  });

  it('does not name another address or a name that only contains localhost', () => {
    for (const host of ['example.com', 'localhost.example.com', 'mylocalhost', '10.0.0.5', '0.0.0.1', '[::2]', '[fe80::1]', '[::ffff:a00:5]', '127.0.0.1.nip.io']) {
      expect(isTargetLoopbackHost(host), host).toBe(false);
    }
  });
});

describe('rewriteInbound', () => {
  it('keeps the URL whole when the local port equals the remote port', async () => {
    const t = tunnels([{ localPort: 5173, remote: { host: '127.0.0.1', port: 5173 } }]);
    expect(await rewriteInbound('http://localhost:5173/src/main.ts?t=1#top', AUTHORITY, t)).toBe('http://localhost:5173/src/main.ts?t=1#top');
    expect(t.forwarded).toEqual([]);
  });

  it('moves a target loopback URL to its forward, keeping path, query, fragment and userinfo', async () => {
    const t = tunnels([{ localPort: 5174, remote: { host: '::1', port: 5173 } }]);
    expect(await rewriteInbound('http://user:pa%40ss@localhost:5173/a/b?next=http://localhost:5173/x#frag', AUTHORITY, t))
      .toBe('http://user:pa%40ss@localhost:5174/a/b?next=http://localhost:5173/x#frag');
    expect(await rewriteInbound('http://127.0.0.1:5173/', AUTHORITY, t)).toBe('http://127.0.0.1:5174/');
    expect(await rewriteInbound('http://[::1]:5173/', AUTHORITY, t)).toBe('http://[::1]:5174/');
    expect(t.forwarded).toEqual([]);
  });

  it('opens every other loopback form as localhost', async () => {
    const t = tunnels([{ localPort: 8001, remote: { host: '127.0.0.1', port: 8000 } }]);
    for (const url of ['http://0.0.0.0:8000/', 'http://[::ffff:7f00:1]:8000/', 'http://[::]:8000/', 'http://127.0.0.2:8000/', 'http://app.localhost:8000/']) {
      expect(await rewriteInbound(url, AUTHORITY, t), url).toBe('http://localhost:8001/');
    }
    // the URL parser already reads a decimal literal as 127.0.0.1
    expect(await rewriteInbound('http://2130706433:8000/', AUTHORITY, t)).toBe('http://127.0.0.1:8001/');
  });

  it('forwards a port no tunnel has, once, then reuses it', async () => {
    const t = tunnels();
    expect(await rewriteInbound('https://localhost:8443/login', AUTHORITY, t)).toBe('https://localhost:5174/login');
    expect(await rewriteInbound('https://localhost:8443/again', AUTHORITY, t)).toBe('https://localhost:5174/again');
    expect(await rewriteInbound('http://localhost/', AUTHORITY, t)).toBe('http://localhost:5175/');
    expect(t.forwarded).toEqual([{ host: 'localhost', port: 8443 }, { host: 'localhost', port: 80 }]);
  });

  it('moves a URL naming a forwarded non-loopback target to its forward, and forwards nothing else', async () => {
    const t = tunnels([{ localPort: 4000, remote: { host: 'db', port: 8080 } }, { localPort: 4001, remote: { host: 'fd00::5', port: 80 } }]);
    expect(await rewriteInbound('http://DB:8080/admin', AUTHORITY, t)).toBe('http://localhost:4000/admin');
    expect(await rewriteInbound('http://[fd00::5]/', AUTHORITY, t)).toBe('http://localhost:4001/');
    expect(await rewriteInbound('http://db:8081/', AUTHORITY, t)).toBe('http://db:8081/');
    expect(await rewriteInbound('https://example.com/', AUTHORITY, t)).toBe('https://example.com/');
    expect(t.forwarded).toEqual([]);
  });

  it('leaves what is not an http address as written', async () => {
    const t = tunnels();
    for (const url of ['file:///C:/Users/me/.ssh/id_rsa', 'about:blank', 'javascript:alert(1)', 'ws://localhost:5173/', 'not a url', 'localhost:5173']) {
      expect(await rewriteInbound(url, AUTHORITY, t), url).toBe(url);
    }
    expect(t.forwarded).toEqual([]);
  });

  it('never reuses another authority\'s tunnel', async () => {
    const t = tunnels([{ localPort: 6000, remote: { host: '127.0.0.1', port: 3000 } }]);
    await expect(rewriteInbound('http://localhost:3000/', 'ssh-remote+other', { list: t.list, forward: async () => ({ localPort: 7000, remote: { host: 'localhost', port: 3000 } }) })).resolves.toBe('http://localhost:7000/');
  });
});

describe('rewriteOutbound', () => {
  const mapped: RewriteTunnel[] = [
    { localPort: 5174, remote: { host: '127.0.0.1', port: 5173 } },
    { localPort: 5175, remote: { host: 'localhost', port: 5174 } },
    { localPort: 3000, remote: { host: '127.0.0.1', port: 3000 } },
    { localPort: 4000, remote: { host: 'db', port: 8080 } },
    { localPort: 4001, remote: { host: 'fd00::5', port: 80 } },
  ];

  it('puts page, console and network URLs back in target form, in one pass', () => {
    expect(rewriteOutbound('[vite] connecting to ws://localhost:5174/?token=a and http://127.0.0.1:5175/x', mapped))
      .toBe('[vite] connecting to ws://localhost:5173/?token=a and http://127.0.0.1:5174/x');
    expect(rewriteOutbound('GET https://[::1]:5174/api 200; wss://LOCALHOST:5174', mapped)).toBe('GET https://[::1]:5173/api 200; wss://LOCALHOST:5173');
    expect(rewriteOutbound('http://user:p@localhost:5174/#h', mapped)).toBe('http://user:p@localhost:5173/#h');
  });

  it('shows a non-loopback forward as its target', () => {
    expect(rewriteOutbound('http://localhost:4000/admin and http://localhost:4001/', mapped)).toBe('http://db:8080/admin and http://[fd00::5]:80/');
  });

  it('leaves ports that are not forwarded, longer ports, other hosts and bare host:port text alone', () => {
    const text = 'http://localhost:9999/ http://localhost:51740/ http://example.com:5174/ localhost:5174 http://localhost/ http://127.0.0.2:5174/';
    expect(rewriteOutbound(text, mapped)).toBe(text);
    expect(rewriteOutbound('http://localhost:5174/', [])).toBe('http://localhost:5174/');
    expect(rewriteOutbound('http://localhost:517400/', [{ localPort: 51740, remote: { host: 'localhost', port: 51739 } }])).toBe('http://localhost:517400/');
  });

  it('stays linear on adversarial page output', () => {
    const hostile = `${'http://'.repeat(20_000)}${'a'.repeat(200_000)}${' http://x@'.repeat(20_000)}`;
    const started = performance.now();
    expect(rewriteOutbound(hostile, mapped)).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
