import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MAX_ASKPASS_ARG_CHARS, MAX_ASKPASS_ARGS, parseAskpassRequest } from '../../../core/scm/askpass/askpass-server';
import {
  credentialOutput,
  MAX_HELPER_ARG_CHARS,
  MAX_HELPER_ARGS,
  MAX_REPLY_BYTES,
  NOT_CONNECTED_MESSAGE,
  parseCredentialOp,
  parseCredentialReply,
  parseHelperArgs,
  parseReply,
  readBounded,
  requestLine,
} from '../helper-protocol';

// The `const int <name> = <product>;` constants of the Windows ssh trampoline, evaluated.
function trampolineConstants(): Record<string, number> {
  const source = readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'resources', 'askpass', 'ssh-askpass.cs'), 'utf8');
  return Object.fromEntries([...source.matchAll(/const int (\w+) = ([\d\s*]+);/g)].map(([, name, value]) => [name!, value!.split('*').reduce((product, factor) => product * Number(factor.trim()), 1)]));
}

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

  it('has the bounds of the Windows ssh trampoline, which copies them', () => {
    const { MaxArgs, MaxArgChars, MaxReplyBytes } = trampolineConstants();
    expect({ MaxArgs, MaxArgChars, MaxReplyBytes }).toEqual({ MaxArgs: MAX_ASKPASS_ARGS, MaxArgChars: MAX_ASKPASS_ARG_CHARS, MaxReplyBytes: MAX_REPLY_BYTES });
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

describe('the git credential relay helper', () => {
  it('runs for exactly one of get, store and erase', () => {
    expect(['get', 'store', 'erase'].map((op) => parseCredentialOp([op]))).toEqual(['get', 'store', 'erase']);
    for (const args of [[], ['get', 'extra'], ['fill'], ['GET']]) expect(parseCredentialOp(args), JSON.stringify(args)).toBeUndefined();
  });

  it('takes exactly one answer of the three kinds, a credential with a non-empty password and no line break', () => {
    expect(parseCredentialReply(JSON.stringify({ kind: 'credential', username: 'ada', password: 'tok' }))).toEqual({ kind: 'credential', username: 'ada', password: 'tok' });
    expect(parseCredentialReply(JSON.stringify({ kind: 'credential', username: '', password: 'tok' }))).toEqual({ kind: 'credential', username: '', password: 'tok' });
    expect(parseCredentialReply(JSON.stringify({ kind: 'none' }))).toEqual({ kind: 'none' });
    expect(parseCredentialReply(JSON.stringify({ kind: 'notConnected' }))).toEqual({ kind: 'notConnected' });
    const refused = [
      { kind: 'credential', username: 'ada', password: '' },
      { kind: 'credential', username: 'ada', password: 'a\nb' },
      { kind: 'credential', username: 'a\rb', password: 'tok' },
      { kind: 'credential', username: 'ada', password: 'tok', host: 'github.com' },
      { kind: 'credential', username: 'ada' },
      { kind: 'none', username: 'ada' },
      { kind: 'password', username: 'ada', password: 'tok' },
      ['credential'],
      null,
    ];
    for (const reply of refused) expect(parseCredentialReply(JSON.stringify(reply)), JSON.stringify(reply)).toBeUndefined();
    expect(parseCredentialReply('not json')).toBeUndefined();
  });

  it('prints a credential for git on stdout, the not-connected line on stderr, and nothing for none', () => {
    expect(credentialOutput({ kind: 'credential', username: 'ada', password: 'tok' })).toEqual({ stdout: 'username=ada\npassword=tok\n', stderr: '' });
    expect(credentialOutput({ kind: 'notConnected' })).toEqual({ stdout: '', stderr: `${NOT_CONNECTED_MESSAGE}\n` });
    expect(credentialOutput({ kind: 'none' })).toEqual({ stdout: '', stderr: '' });
  });

  it('reads its input once, nothing past the bound, and answers once when the stream both fails and ends', () => {
    const read = (events: (stream: EventEmitter) => void, max = 8) => {
      const stream = new EventEmitter();
      const onInput = vi.fn();
      readBounded(stream, max, onInput);
      events(stream);
      return onInput.mock.calls;
    };
    expect(read((s) => (s.emit('data', Buffer.from('ab')), s.emit('data', Buffer.from('cd')), s.emit('end')))).toEqual([['abcd']]);
    expect(read((s) => (s.emit('data', Buffer.from('123456789')), s.emit('end')))).toEqual([[undefined]]);
    expect(read((s) => (s.emit('data', Buffer.from('ab')), s.emit('error', new Error('EPIPE')), s.emit('end')))).toEqual([[undefined]]);
  });
});
