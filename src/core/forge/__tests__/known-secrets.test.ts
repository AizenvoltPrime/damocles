import { afterEach, describe, expect, it } from 'vitest';
import { ANSWERED_WINDOW_MS, createKnownSecrets, knownSecrets, MASK, MIN_PARTIAL_CHARS, resetKnownSecretsForTests, secretForms } from '../known-secrets';
import { maskToolResult, partialResultText, registerKnownSecretMasking, UNCHECKED_RESULT } from '../../pi-session/known-secret-masking';
import { createDamoclesExtensionFactory } from '../../pi-session/damocles-extension';
import { createSubagentExtensionFactory } from '../../pi-session/subagents/subagent-extension-factory';

const TOKEN = 'glpat-AbCdEfGhIjKlMnOpQrSt';
const REFRESH = 'ghr_1234567890abcdefghijklmnopqrstuvwxyzABCDEF';

describe('known secrets', () => {
  afterEach(() => resetKnownSecretsForTests());

  it('masks a live token exactly, wherever it stands and however often', () => {
    const secrets = createKnownSecrets(() => 0);
    secrets.setLive('a', [TOKEN, REFRESH]);
    expect(secrets.mask(`token=${TOKEN}\n${TOKEN}${TOKEN} and ${REFRESH}.`)).toBe(`token=${MASK}\n${MASK} and ${MASK}.`);
    expect(secrets.mask('nothing here')).toBe('nothing here');
  });

  it('masks the base64 forms at every alignment, the basic auth header included', () => {
    const secrets = createKnownSecrets(() => 0);
    secrets.setLive('a', [TOKEN]);
    for (const user of ['oauth2', 'ab', 'x-access-token', 'a']) {
      const header = Buffer.from(`${user}:${TOKEN}`).toString('base64');
      const masked = secrets.mask(`Authorization: Basic ${header}`);
      expect(masked, user).toContain(MASK);
      // what is left of the header is at most the user's part and a character on each side of the token
      expect(masked.replace(`Authorization: Basic `, '').replace(MASK, '').length, user).toBeLessThanOrEqual(Math.ceil(((user.length + 1) * 4) / 3) + 4);
    }
    for (const prefix of ['', 'x', 'xy']) {
      const encoded = Buffer.from(`${prefix}${TOKEN}`).toString('base64url');
      expect(secrets.mask(encoded), prefix).toContain(MASK);
    }
    expect(secretForms(TOKEN)).toContain(TOKEN);
  });

  it('keeps an answered token masked for its window only, and forgets a signed-out account at once', () => {
    let now = 1000;
    const secrets = createKnownSecrets(() => now);
    secrets.answered(TOKEN);
    expect(secrets.mask(TOKEN)).toBe(MASK);
    now += ANSWERED_WINDOW_MS - 1;
    expect(secrets.mask(TOKEN)).toBe(MASK);
    now += 1;
    expect(secrets.mask(TOKEN)).toBe(TOKEN);
    secrets.setLive('b', [REFRESH]);
    expect(secrets.holds()).toBe(true);
    secrets.setLive('b', []);
    expect(secrets.holds()).toBe(false);
    expect(secrets.mask(REFRESH)).toBe(REFRESH);
  });

  it('masks a token cut by a streamed snapshot at its end or its start, from the minimum length on', () => {
    const secrets = createKnownSecrets(() => 0);
    secrets.setLive('a', [TOKEN]);
    expect(secrets.maskPartial(`out: ${TOKEN.slice(0, 10)}`)).toBe(`out: ${MASK}`);
    expect(secrets.maskPartial(`${TOKEN.slice(-10)} more`)).toBe(`${MASK} more`);
    expect(secrets.maskPartial(`${TOKEN.slice(-12)} ${TOKEN} ${TOKEN.slice(0, 7)}`)).toBe(`${MASK} ${MASK} ${MASK}`);
    const short = TOKEN.slice(0, MIN_PARTIAL_CHARS - 1);
    expect(secrets.maskPartial(`out: ${short}`)).toBe(`out: ${short}`);
    // a snapshot sequence never shows a whole prefix of the token across two snapshots
    let tail = '';
    for (const chunk of ['line 1\nghp ', TOKEN.slice(0, 9), TOKEN.slice(9), '\ndone']) {
      tail += chunk;
      expect(secrets.maskPartial(tail)).not.toContain(TOKEN.slice(0, 9));
    }
  });

  it('masks text that continues over calls, keeping back what may start a token until the next call or the end', () => {
    const secrets = createKnownSecrets(() => 0);
    expect(secrets.maskStreamed('nothing held', false)).toEqual({ text: 'nothing held', held: '' });
    secrets.setLive('a', [TOKEN]);
    const longest = Math.max(...secretForms(TOKEN).map((form) => form.length));
    let held = '';
    let sent = '';
    for (const chunk of [`${'x'.repeat(100)}\nexport T=${TOKEN.slice(0, 9)}`, `${TOKEN.slice(9)}\n${'y'.repeat(30)}`]) {
      const out = secrets.maskStreamed(held + chunk, false);
      expect(out.text).not.toContain(TOKEN.slice(0, 6));
      sent += out.text;
      held = out.held;
    }
    sent += secrets.maskStreamed(held, true).text;
    expect(sent).toBe(`${'x'.repeat(100)}\nexport T=${MASK}\n${'y'.repeat(30)}`);
    // a token that ends past the cut is held whole, and a surrogate pair is never split
    expect(secrets.maskStreamed(`a${TOKEN}${'z'.repeat(longest - 4)}`, false).held.startsWith(TOKEN)).toBe(true);
    const pair = `${'q'.repeat(10)}😀${'r'.repeat(longest - 1)}`;
    expect(secrets.maskStreamed(pair, false).held.startsWith('😀')).toBe(true);
  });

  it('lets a longer match that starts earlier swallow a shorter one inside it', () => {
    const secrets = createKnownSecrets(() => 0);
    secrets.setLive('a', ['XXabcdefghYY', 'abcdefgh']);
    expect(secrets.mask('-XXabcdefghYY-')).toBe(`-${MASK}-`);
  });

  it('masks a cut-off piece of a secret whole when a shorter secret sits inside it', () => {
    const secrets = createKnownSecrets(() => 0);
    secrets.setLive('a', ['XXabcdefghYYZZ', 'abcdefgh']);
    expect(secrets.maskPartial('out XXabcdefghYY')).toBe(`out ${MASK}`);
    expect(secrets.maskPartial('abcdefghYYZZ rest')).toBe(`${MASK} rest`);
  });

  it('matches in one pass however many tokens are held', () => {
    const secrets = createKnownSecrets(() => 0);
    const many = Array.from({ length: 300 }, (_, index) => `ghp_${String(index).padStart(36, '0')}`);
    secrets.setLive('many', many);
    const text = `${'x'.repeat(200_000)}${many[150]}`;
    const started = performance.now();
    expect(secrets.mask(text).endsWith(MASK)).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('tool result masking', () => {
  afterEach(() => resetKnownSecretsForTests());

  it('masks text content, details and structured content, and returns nothing when the result holds no secret', () => {
    knownSecrets().setLive('a', [TOKEN]);
    const masked = maskToolResult({ content: [{ type: 'text', text: `password=${TOKEN}` }], details: { output: [TOKEN], n: 1 }, structuredContent: { token: TOKEN } });
    expect(masked).toEqual({ content: [{ type: 'text', text: `password=${MASK}` }], details: { output: [MASK], n: 1 }, structuredContent: { token: MASK } });
    expect(maskToolResult({ content: [{ type: 'text', text: 'clean' }], details: undefined })).toBeUndefined();
  });

  it('masks object keys and a result nested at any depth, withholds one that contains itself, and masks a cut-off token in truncated output', async () => {
    knownSecrets().setLive('a', [TOKEN]);
    expect(maskToolResult({ content: [], details: { [TOKEN]: 1 } })).toMatchObject({ details: { [MASK]: 1 } });
    let deep: unknown = TOKEN;
    let maskedDeep: unknown = MASK;
    for (let level = 0; level < 500; level++) {
      deep = { deep };
      maskedDeep = { deep: maskedDeep };
    }
    expect(maskToolResult({ content: [{ type: 'text', text: 'x' }], details: deep })).toEqual({ content: [{ type: 'text', text: 'x' }], details: maskedDeep });
    const cyclic: Record<string, unknown> = { text: 'x' };
    cyclic['self'] = { cyclic };
    expect(maskToolResult({ content: [{ type: 'text', text: 'x' }], details: cyclic })).toEqual({ content: [{ type: 'text', text: UNCHECKED_RESULT }], details: {} });
    const shared = { text: TOKEN };
    expect(maskToolResult({ content: [], details: { a: shared, b: shared } })).toEqual({ content: [], details: { a: { text: MASK }, b: { text: MASK } } });
    const handlers: Array<(event: unknown) => unknown> = [];
    registerKnownSecretMasking({ on: (_name: string, handler: (event: unknown) => unknown) => handlers.push(handler) } as never);
    const tail = { type: 'tool_result', content: [{ type: 'text', text: `${TOKEN.slice(-9)}\nrest` }], details: { truncation: { truncated: true } } };
    expect(await handlers[0]!(tail)).toMatchObject({ content: [{ type: 'text', text: `${MASK}\nrest` }] });
  });

  it("leaves an image block's data as it is and masks the text beside it", () => {
    knownSecrets().setLive('a', [TOKEN]);
    const image = { type: 'image' as const, data: `AAAA${TOKEN}AAAA`, mimeType: 'image/png' };
    const masked = maskToolResult({ content: [image, { type: 'text', text: TOKEN }], details: undefined });
    expect(masked?.content).toEqual([image, { type: 'text', text: MASK }]);
    expect(masked?.content?.[0]).toBe(image);
  });

  it('withholds the text rather than pass a result it could not check', () => {
    const masked = maskToolResult({ content: [{ type: 'text', text: 'x' }], details: undefined }, () => {
      throw new Error('boom');
    });
    expect(masked).toEqual({ content: [{ type: 'text', text: UNCHECKED_RESULT }], details: {} });
  });

  it('masks a streamed partial', () => {
    knownSecrets().setLive('a', [TOKEN]);
    expect(partialResultText({ content: [{ type: 'text', text: `x ${TOKEN.slice(0, 12)}` }] })).toBe(`x ${MASK}`);
  });

  it('is the first tool_result handler the Damocles and nested-agent extensions register', () => {
    knownSecrets().setLive('a', [TOKEN]);
    const firstOf = (factory: (pi: never) => void): ((event: unknown) => unknown) => {
      const handlers: Array<(event: unknown) => unknown> = [];
      const pi = new Proxy({}, { get: (_target, name) => (name === 'on' ? (event: string, handler: (event: unknown) => unknown) => {
        if (event === 'tool_result') handlers.push(handler);
      } : () => undefined) });
      factory(pi as never);
      return handlers[0]!;
    };
    const event = { type: 'tool_result', toolCallId: 't', toolName: 'bash', input: {}, content: [{ type: 'text', text: TOKEN }], details: undefined, isError: false };
    const reader = { get: () => undefined, values: () => [] };
    const main = firstOf(createDamoclesExtensionFactory(reader as never, reader as never, { config: { hasEntries: () => true, getEntries: () => [] }, workspaceRoot: '/w', userHome: '/h' } as never) as never);
    expect(main(event)).toMatchObject({ content: [{ type: 'text', text: MASK }] });
    const nested = firstOf(createSubagentExtensionFactory({ deferrableToolNames: [], hooks: { config: { hasEntries: () => true, getEntries: () => [] }, workspaceRoot: '/w', userHome: '/h' } } as never) as never);
    expect(nested(event)).toMatchObject({ content: [{ type: 'text', text: MASK }] });
  });
});
