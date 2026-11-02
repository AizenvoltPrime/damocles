import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { createUrlFinder, findUrls, MAX_LINE_CHARS, type UrlHit } from '../url-finder';

describe('the URL finder', () => {
  it.each([
    ['  VITE v5.0.0  ready in 300 ms\r', []],
    ['  ➜  Local:   http://localhost:5173/', [{ host: 'localhost', port: 5173 }]],
    ['Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...', [{ host: '0.0.0.0', port: 8000 }]],
    ['Serving HTTP on 127.0.0.1 port 8001 ...', [{ host: '127.0.0.1', port: 8001 }]],
    ['listening at 127.0.0.1:3000 and [::1]:3001', [{ host: '127.0.0.1', port: 3000 }, { host: 'localhost', port: 3001 }]],
    ['open https://devbox.internal:8443/app', [{ host: 'localhost', port: 8443 }]],
    ['\x1b[32mhttp://\x1b[1mlocalhost\x1b[22m:4000\x1b[39m', [{ host: 'localhost', port: 4000 }]],
    ['Debugger listening on ws://127.0.0.1:9230/abc', []],
    ['Debugger listening on ws://127.0.0.1:9229/abc', [{ host: '127.0.0.1', port: 9229 }]],
    ['port 70000 on localhost:70000 is no port', []],
    ['localhost:0 and localhost:1234x and xlocalhost:22', []],
    ['the time is 12:30:45 and db.example.com:5432 has no scheme', []],
    // a bracketed host counts only as the target's own loopback
    ['on [::]:4001 and [0:0:0:0:0:0:0:1]:4002', [{ host: 'localhost', port: 4001 }, { host: 'localhost', port: 4002 }]],
    ['mapped [::ffff:127.0.0.1]:4003 [::ffff:7f00:1]:4004 [::ffff:0.0.0.0]:4005', [{ host: 'localhost', port: 4003 }, { host: 'localhost', port: 4004 }, { host: 'localhost', port: 4005 }]],
    ['https://[2001:db8::1]:443 ssh [fe80::1]:22 [0]:80 [::ffff:10.0.0.1]:8080 [::2]:81', []],
  ] as const)('reads %j', (line, hits) => {
    expect(findUrls(line)).toEqual(hits);
  });

  it('joins a URL split across output chunks and reports it once its line ends', () => {
    const hits: UrlHit[] = [];
    const finder = createUrlFinder((hit) => hits.push(hit));
    finder.push('server at http://local');
    finder.push('host:51');
    expect(hits).toEqual([]);
    finder.push('73/ ready\nnext');
    expect(hits).toEqual([{ host: 'localhost', port: 5173 }]);
  });

  it('scans a line longer than its bound in pieces without cutting a URL, and keeps its memory bounded', () => {
    const hits: UrlHit[] = [];
    const finder = createUrlFinder((hit) => hits.push(hit));
    const filler = `${'x '.repeat(MAX_LINE_CHARS)}`;
    finder.push(`${filler}http://localhost:3333/ `);
    finder.push(`${filler}`);
    finder.push('\n');
    expect(hits).toEqual([{ host: 'localhost', port: 3333 }]);
  });

  // a regex with nested repetition takes time quadratic or worse in such input; the scanner's grows with its length
  it.each([
    ['colons after a long host', (n: number) => `${'a'.repeat(n)}${':1x'.repeat(n)}`],
    ['host characters with no colon', (n: number) => 'a.'.repeat(n)],
    ['one colon after a long run of host characters', (n: number) => `http://${'a'.repeat(n)}:`],
    ['unterminated escapes', (n: number) => '\x1b['.repeat(n)],
    ['brackets of hex digits', (n: number) => `[${'f:'.repeat(n)}]:`.repeat(4)],
    ['a long host before every port', (n: number) => `${'a'.repeat(250)}:1 `.repeat(Math.ceil(n / 253))],
  ])('runs in linear time on %s', (_name, make) => {
    const time = (n: number): number => {
      const input = make(n);
      const started = performance.now();
      for (let round = 0; round < 3; round++) findUrls(input);
      return performance.now() - started;
    };
    time(20_000);
    const small = Math.max(time(100_000), 1);
    const large = time(800_000);
    // eight times the input in at most about eight times the time; a quadratic scan would take sixty-four times
    expect(large / small).toBeLessThan(24);
  });
});
