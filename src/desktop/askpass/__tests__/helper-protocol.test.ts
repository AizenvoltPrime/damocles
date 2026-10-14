import { describe, expect, it } from 'vitest';
import { MAX_ASKPASS_ARG_CHARS, MAX_ASKPASS_ARGS, parseAskpassRequest } from '../../../core/scm/askpass/askpass-server';
import { MAX_HELPER_ARG_CHARS, MAX_HELPER_ARGS, parseHelperArgs, parseReply, requestLine } from '../helper-protocol';

describe('the askpass helper', () => {
  it('takes its kind and then the prompt git or ssh passed, as one argument each', () => {
    expect(parseHelperArgs(['askpass', "Username for 'https://example.com': "])).toEqual({ kind: 'askpass', argv: ["Username for 'https://example.com': "] });
    expect(parseHelperArgs(['ssh', 'Enter passphrase for key:'])).toEqual({ kind: 'ssh', argv: ['Enter passphrase for key:'] });
    expect(parseHelperArgs(['ssh', 'a', 'b'])).toEqual({ kind: 'ssh', argv: ['a', 'b'] });
  });

  it('refuses another kind, no prompt, too many arguments or one past the bound', () => {
    expect(parseHelperArgs([])).toBeUndefined();
    expect(parseHelperArgs(['askpass'])).toBeUndefined();
    expect(parseHelperArgs(['https', 'Username:'])).toBeUndefined();
    expect(parseHelperArgs(['askpass', ...Array.from({ length: 17 }, () => 'x')])).toBeUndefined();
    expect(parseHelperArgs(['askpass', 'x'.repeat(4097)])).toBeUndefined();
  });

  it('prints only an answer the reply holds alone, and nothing for a cancel or anything malformed', () => {
    expect(parseReply(JSON.stringify({ answer: 'secret' }))).toBe('secret');
    expect(parseReply(JSON.stringify({ answer: '' }))).toBe('');
    expect(parseReply(JSON.stringify({ cancel: true }))).toBeUndefined();
    expect(parseReply(JSON.stringify({ answer: 'a\nb' }))).toBeUndefined();
    expect(parseReply(JSON.stringify({ answer: 'a', cancel: true }))).toBeUndefined();
    expect(parseReply(JSON.stringify({ answer: 7 }))).toBeUndefined();
    expect(parseReply('not json')).toBeUndefined();
    expect(parseReply(JSON.stringify(['secret']))).toBeUndefined();
  });

  it('bounds its arguments exactly as the server does', () => {
    expect([MAX_HELPER_ARGS, MAX_HELPER_ARG_CHARS]).toEqual([MAX_ASKPASS_ARGS, MAX_ASKPASS_ARG_CHARS]);
  });

  it('forwards SSH_ASKPASS_PROMPT for ssh when it is confirm or none, in a line the server accepts', () => {
    const nonce = 'a'.repeat(64);
    const ssh = { kind: 'ssh', argv: ['Confirm user presence for key ED25519-SK SHA256:x'] } as const;
    for (const hint of ['confirm', 'none'] as const) {
      const line = requestLine(nonce, ssh, hint);
      expect(JSON.parse(line)).toEqual({ nonce, ...ssh, sshPrompt: hint });
      expect(parseAskpassRequest(Buffer.from(line.slice(0, -1)))).toEqual({ nonce, ...ssh, sshPrompt: hint });
    }
    expect(JSON.parse(requestLine(nonce, ssh, 'other'))).toEqual({ nonce, ...ssh });
    expect(JSON.parse(requestLine(nonce, { kind: 'askpass', argv: ['Username: '] }, 'none'))).toEqual({ nonce, kind: 'askpass', argv: ['Username: '] });
  });
});
