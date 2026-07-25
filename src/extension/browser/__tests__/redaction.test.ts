import { describe, it, expect } from 'vitest';
import { redactSecrets, redactUrl, redactAttributes, redactMarkup } from '../redaction';
import { ConsoleCollector, NetworkCollector } from '../collectors';

/**
 * Every "the secret is gone" assertion here is paired with a check that the surrounding NON-secret
 * text survived. A redactor that returned a constant string would satisfy the first half of each
 * test and fail the second, which is the point: the feature's value is debugging the user's own app,
 * so over-redaction is a real failure mode, not a safe default.
 */

describe('redactSecrets — named keys', () => {
  it('redacts a value whose key names a credential, keeping the key and the rest of the line', () => {
    const out = redactSecrets('GET /login?user=ada&password=hunter2&next=/home failed');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('password=[redacted]');
    // Non-secret context is preserved — this is what makes the capture still useful.
    expect(out).toContain('user=ada');
    expect(out).toContain('next=/home');
    expect(out).toContain('failed');
  });

  it('matches key fragments, so prefixed and camelCase variants are covered', () => {
    for (const line of [
      'X-Api-Key=abc123def456',
      'refreshToken=abc123def456',
      'user_password=abc123def456',
      'SESSION_ID=abc123def456',
    ]) {
      expect(redactSecrets(line)).not.toContain('abc123def456');
    }
  });

  it('redacts JSON string values under a credential key', () => {
    const out = redactSecrets('auth response {"user":"ada","access_token":"abc123def456","ttl":300}');
    expect(out).not.toContain('abc123def456');
    expect(out).toContain('"[redacted]"');
    expect(out).toContain('"user":"ada"');
    expect(out).toContain('"ttl":300');
  });

  it('leaves ordinary debugging output completely untouched', () => {
    // POSITIVE CONTROL for the whole module: if this ever changes, redaction has become too broad and
    // the feature it protects is worthless.
    const lines = [
      'render complete in 42ms',
      'GET /api/users/1234 200',
      'state {"count":3,"items":["a","b"],"userId":998877}',
      'Uncaught TypeError: Cannot read properties of null (reading \'x\')',
      'commit 9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f09',
    ];
    for (const line of lines) expect(redactSecrets(line)).toBe(line);
  });
});

describe('redactSecrets — self-identifying token shapes', () => {
  it('redacts tokens that carry no key at all', () => {
    const cases: Array<[string, string]> = [
      ['token is eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abc123', 'eyJhbGciOiJIUzI1NiJ9'],
      ['Authorization: Bearer sk-abcdefghijklmnop', 'sk-abcdefghijklmnop'],
      ['using ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
      ['key AKIAIOSFODNN7EXAMPLE here', 'AKIAIOSFODNN7EXAMPLE'],
      ['slack xoxb-1234567890-abcdefghij', 'xoxb-1234567890-abcdefghij'],
      ['stripe sk_live_abcdefghijklmnop', 'sk_live_abcdefghijklmnop'],
    ];
    for (const [line, secret] of cases) {
      const out = redactSecrets(line);
      expect(out).not.toContain(secret);
      expect(out).toContain('[redacted]');
    }
  });

  it('does NOT redact a bare hex/base64 run, which is usually a hash or an id', () => {
    // Deliberate scope limit: over-redacting these would gut the debugging value for no real gain.
    const line = 'etag d41d8cd98f00b204e9800998ecf8427e size 1024';
    expect(redactSecrets(line)).toBe(line);
  });
});

describe('redactUrl', () => {
  it('redacts a sensitive query parameter by NAME, keeping the rest of the URL intact', () => {
    const out = redactUrl('https://api.example.com/v1/me?access_token=abc123def456&fields=id,name');
    expect(out).not.toContain('abc123def456');
    expect(out).toContain('access_token=[redacted]');
    // Everything a developer needs to identify the request survives.
    expect(out).toContain('api.example.com');
    expect(out).toContain('/v1/me');
    expect(out).toContain('fields=id%2Cname');
  });

  it('redacts a userinfo password', () => {
    const out = redactUrl('https://ada:hunter2@example.com/private');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('ada');
    expect(out).toContain('example.com');
  });

  it('redacts a token in the fragment, which searchParams cannot see', () => {
    const out = redactUrl('https://example.com/cb#access_token=abc123def456&state=xyz');
    expect(out).not.toContain('abc123def456');
    expect(out).toContain('state=xyz');
  });

  it('leaves an ordinary URL byte-identical', () => {
    const url = 'https://example.com/assets/app.js?v=3';
    expect(redactUrl(url)).toBe(url);
  });

  it('falls back to text rules for an unparseable URL instead of throwing', () => {
    const out = redactUrl('/relative/path?api_key=abc123def456');
    expect(out).not.toContain('abc123def456');
    expect(out).toContain('/relative/path');
  });
});

describe('runs in linear time on hostile input', () => {
  /**
   * THE GUARD THAT MATTERS MOST IN THIS FILE. `redactSecrets` runs SYNCHRONOUSLY on the extension host
   * against text a page fully controls, so a backtracking pattern is a remote freeze of the editor,
   * not a slow log line. The previous JSON-value matcher `(?:\\.|(?!\2)[^\\])*` was quadratic: an
   * ORDINARY 40KB CDN URL cost 1.6s and 160KB cost 73s, with no credential keyword anywhere in the
   * input — and `recordRequestFailed` receives raw `data:` URLs straight from Chromium.
   *
   * Asserted as a GROWTH RATIO rather than a wall-clock budget, so it means the same thing on a fast
   * laptop and a loaded CI box: quadratic growth is 16x per 4x of input and cannot hide under a
   * generous constant, whereas linear growth is ~4x.
   */
  function timeOn(text: string): number {
    const started = performance.now();
    redactSecrets(text);
    return performance.now() - started;
  }

  it('scales linearly, not quadratically, with input size', () => {
    const build = (kb: number): string => 'https://cdn.example.com/' + 'a'.repeat(kb * 1024);
    // Warm up so JIT compilation is not counted as growth.
    timeOn(build(10));
    const small = Math.max(timeOn(build(20)), 0.5);
    const large = timeOn(build(80));
    // 4x the input. Linear ≈ 4x; the old quadratic form was ~16x and, at these sizes, seconds.
    expect(large / small).toBeLessThan(10);
    expect(large).toBeLessThan(1000);
  });

  it('stays fast on the adversarial shapes that have no terminator', () => {
    // Each of these invites a matcher to scan to the end of the buffer looking for a close that never
    // comes — an unterminated quote, an unterminated PEM block, a dense run of sensitive keys.
    const cases = [
      'authorization: "' + 'a'.repeat(160 * 1024),
      '-----BEGIN RSA PRIVATE KEY-----' + 'a'.repeat(160 * 1024),
      '{"password":"' + 'a'.repeat(160 * 1024),
      '{"password":"x"},'.repeat(9000),
      'Cookie: a=1; b=2\n'.repeat(9000),
    ];
    for (const text of cases) expect(timeOn(text)).toBeLessThan(1000);
  });
});

describe('redactSecrets — credential shapes that used to slip through', () => {
  /**
   * A redactor is only as good as the formats it recognises, and "every input we tested is one the
   * implementation already handles" is how a table of green tests hides a leak. Each row below was
   * verified UNREDACTED against the previous implementation.
   */
  it.each([
    ['single-quoted JSON value', "{token: 'abc123def456'}", 'abc123def456'],
    ['unquoted header-style key', 'x-api-key:abc123def456', 'abc123def456'],
    ['cookie jar under a non-obvious name', 'Cookie: PHPSESSID=abc123def456; theme=dark', 'abc123def456'],
    ['Set-Cookie response header', 'Set-Cookie: sid=abc123def456; HttpOnly', 'abc123def456'],
    ['bare authorization value', 'authorization: abc123def456xyz', 'abc123def456xyz'],
    ['GitHub fine-grained PAT', 'using github_pat_11ABCDEFG0abcdefghijklmno', 'github_pat_11ABCDEFG0abcdefghijklmno'],
    ['OpenAI project key', 'key sk-proj-abcdefghijklmnopqrst', 'sk-proj-abcdefghijklmnopqrst'],
    ['npm automation token', 'npm_abcdefghijklmnopqrstuvwxyz012345', 'npm_abcdefghijklmnopqrstuvwxyz012345'],
    ['ssh public key', 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQabcdefghijkl user@host', 'AAAAB3NzaC1yc2EAAAADAQABAAABgQabcdefghijkl'],
    ['PEM private key block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEabcdef\n-----END RSA PRIVATE KEY-----', 'MIIEabcdef'],
    ['JSON array value', '{"tokens": ["abc123def456", "ghi789"]}', 'abc123def456'],
    ['embedded userinfo in a logged URL', 'fetching https://ada:hunter2@example.com/p', 'hunter2'],
  ])('redacts %s', (_label, line, secret) => {
    const out = redactSecrets(line);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('still leaves the shapes it must not touch', () => {
    // POSITIVE CONTROL for the table above: widening the rules must not have turned the redactor into
    // one that replaces everything, which would satisfy every `not.toContain` in this file.
    for (const line of [
      'GET https://cdn.example.com/app.js 404',
      '{"userId": 12345, "name": "alice"}',
      'Content-Type: application/json',
      'clicked #login-button',
      'ssh-rsa is not a key on its own',
    ]) {
      expect(redactSecrets(line)).toBe(line);
    }
  });

  it('does not leave a percent-encoded marker in a userinfo password', () => {
    // `URL.password = '[redacted]'` re-encodes on write, so the marker came out as `%5Bredacted%5D`.
    // The old test only asserted the secret was absent, so it passed on the mangled output.
    const out = redactUrl('https://ada:hunter2@example.com/private');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('%5B');
  });
});

describe('redaction for a picked element', () => {
  /**
   * The picker attachment is broadcast into the chat transcript and persisted in the session file, so
   * it is an exfiltration path in exactly the way console output is. `redaction.ts` named it as the
   * ORIGINAL leak, and the first fix landed only on the collectors — a picked
   * `<input type=password value=…>` still shipped a live password to the model.
   */
  it('masks a password field value by NAME, since no pattern can recognise a password', () => {
    const attributes = { type: 'password', value: 'hunter2', id: 'pw' };
    const redacted = redactAttributes(attributes);
    expect(redacted['value']).toBe('[redacted]');
    // Structure the developer needs survives — this is an attachment for debugging a form.
    expect(redacted['type']).toBe('password');
    expect(redacted['id']).toBe('pw');
  });

  it('masks the value inside the serialized markup too, quoted or not', () => {
    for (const html of [
      '<input type=password value=hunter2 id=pw>',
      '<input type="password" value="hunter2" id="pw">',
      "<input type='password' value='hunter2'>",
    ]) {
      const out = redactMarkup(html, { type: 'password', value: 'hunter2' });
      expect(out).not.toContain('hunter2');
      expect(out).toContain('[redacted]');
    }
  });

  it('honours the same one-time-code and data-sensitive markers BrowserQuery uses', () => {
    for (const attributes of [
      { autocomplete: 'one-time-code', value: '123456' },
      { autocomplete: 'current-password', value: '123456' },
      { 'data-sensitive': '', value: '123456' },
    ]) {
      expect(redactAttributes(attributes)['value']).toBe('[redacted]');
    }
  });

  it('still redacts credentials in NON-sensitive attributes and leaves ordinary ones alone', () => {
    const attributes = { href: '/cb?access_token=abc123def456', class: 'btn primary', value: 'search' };
    const redacted = redactAttributes(attributes);
    expect(redacted['href']).not.toContain('abc123def456');
    // POSITIVE CONTROL: a non-password element keeps its value, so the masking above is targeted.
    expect(redacted['value']).toBe('search');
    expect(redacted['class']).toBe('btn primary');
  });
});

describe('collectors redact at capture, so the secret never enters the buffer', () => {
  it('ConsoleCollector stores the redacted text', () => {
    const collector = new ConsoleCollector();
    collector.record('log', 'auth ok {"access_token":"abc123def456"}');
    const stored = collector.getMessages();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.text).not.toContain('abc123def456');
    // POSITIVE CONTROL: the entry is really there, so the absence above is redaction rather than a
    // collector that dropped the message.
    expect(stored[0]!.text).toContain('auth ok');
    expect(stored[0]!.level).toBe('log');
  });

  it('NetworkCollector redacts a failing response URL', () => {
    const collector = new NetworkCollector();
    collector.recordResponse('https://api.example.com/me?token=abc123def456', 401, 'Unauthorized');
    const [entry] = collector.getErrors();
    expect(entry!.url).not.toContain('abc123def456');
    expect(entry!.url).toContain('api.example.com');
    expect(entry!.status).toBe(401);
  });

  it('NetworkCollector redacts a failed-request URL and keeps the error text', () => {
    const collector = new NetworkCollector();
    collector.recordRequestFailed('https://api.example.com/x?api_key=abc123def456', 'net::ERR_FAILED');
    const [entry] = collector.getErrors();
    expect(entry!.url).not.toContain('abc123def456');
    expect(entry!.url).toContain('net::ERR_FAILED');
  });

  it('bounds every entry by BYTES, not just by count', () => {
    // The ring buffers cap the number of entries at 100 but capped no entry's size, and the only
    // per-entry text cap lived IN THE PAGE — where a hostile page can edit it out. 100 x 500KB is both
    // a heap problem and an unbounded model-context cost, since these are re-sent every turn.
    const collector = new ConsoleCollector();
    collector.record('log', 'x'.repeat(500_000));
    const [entry] = collector.getMessages();
    expect(entry!.text.length).toBeLessThan(10_000);
    // POSITIVE CONTROL: the entry is really recorded, and the cut is MARKED so a reader never mistakes
    // a clipped value for the whole one.
    expect(entry!.text).toContain('truncated');

    const network = new NetworkCollector();
    network.recordRequestFailed(`data:text/plain,${'y'.repeat(500_000)}`, 'z'.repeat(5_000));
    const [failure] = network.getErrors();
    expect(failure!.url.length).toBeLessThan(2_000);
  });
});
