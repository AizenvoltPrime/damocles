import * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ WebContentsView: vi.fn(), nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() }, protocol: {}, dialog: { showMessageBox: vi.fn() } }));

import { createAskpassServer, PROMPT_CANCELLED, type AskpassServer } from '../../../core/scm/askpass/askpass-server';
import type { OverlayAnswer, OverlayRequest } from '../../preload/overlay-channels';
import { createAskpassBridge } from '../askpass-bridge';
import { createMessageAsker, type AskMessage, type MessageOverlay } from '../message-dialog';
import type { AskInput } from '../overlay';

const t = (message: string): string => message;

function bridge(answers: { message?: number; input?: string } = {}) {
  const questions: Array<{ question: Parameters<AskMessage>[0]; signal: AbortSignal | undefined }> = [];
  const inputs: Array<{ request: Parameters<AskInput>[0]; signal: AbortSignal | undefined }> = [];
  const ask: AskMessage = async (question, signal) => {
    questions.push({ question, signal });
    return answers.message;
  };
  const askInput: AskInput = async (request, signal) => {
    inputs.push({ request, signal });
    return answers.input;
  };
  return { prompt: createAskpassBridge({ ask, askInput, t }), questions, inputs };
}

describe('the askpass prompt bridge', () => {
  const signal = new AbortController().signal;

  it('asks a username in the plain box and any other secret in the masked one, with its signal', async () => {
    const fake = bridge({ input: 'ada' });
    expect(await fake.prompt({ kind: 'username', text: "Username for 'https://example.com':" }, signal)).toBe('ada');
    await fake.prompt({ kind: 'password', text: "Password for 'https://example.com':" }, signal);
    await fake.prompt({ kind: 'passphrase', text: 'Enter passphrase for key:' }, signal);
    await fake.prompt({ kind: 'password', text: '' }, signal);
    expect(fake.inputs).toEqual([
      { request: { title: 'Git Authentication', prompt: "Username for 'https://example.com':", placeholder: 'Username' }, signal },
      { request: { title: 'Git Authentication', prompt: "Password for 'https://example.com':", placeholder: 'Password', password: true }, signal },
      { request: { title: 'Git Authentication', prompt: 'Enter passphrase for key:', placeholder: 'Passphrase', password: true }, signal },
      { request: { title: 'Git Authentication', prompt: 'Git asks for credentials.', placeholder: 'Password', password: true }, signal },
    ]);
    expect(fake.questions).toEqual([]);
  });

  it('tells a box the user dismissed from one its call withdrew', async () => {
    expect(await bridge({}).prompt({ kind: 'username', text: "Username for 'https://example.com':" }, signal)).toBe(PROMPT_CANCELLED);
    expect(await bridge({}).prompt({ kind: 'password', text: "Password for 'https://example.com':" }, signal)).toBe(PROMPT_CANCELLED);
    const withdrawn = new AbortController();
    withdrawn.abort();
    expect(await bridge({}).prompt({ kind: 'username', text: 'x' }, withdrawn.signal)).toBeUndefined();
  });

  it('asks an SSH yes/no question with No focused, and answers yes only on Yes', async () => {
    const yes = bridge({ message: 0 });
    expect(await yes.prompt({ kind: 'confirm', text: 'Allow shared connection to example.com?' }, signal)).toBe('yes');
    expect(yes.questions).toEqual([{ question: { severity: 'danger', message: 'Are you sure you want to continue connecting?', detail: 'Allow shared connection to example.com?', actions: ['Yes'], cancelLabel: 'No' }, signal }]);
    expect(await bridge({}).prompt({ kind: 'confirm', text: 'x' }, signal)).toBe(PROMPT_CANCELLED);
    const withdrawn = new AbortController();
    withdrawn.abort();
    expect(await bridge({ message: 0 }).prompt({ kind: 'confirm', text: 'x' }, withdrawn.signal)).toBeUndefined();
  });

  it('shows ssh\'s notice as information that answers nothing', async () => {
    const fake = bridge({ message: 0 });
    expect(await fake.prompt({ kind: 'notice', text: 'Confirm user presence for key ED25519-SK SHA256:abc' }, signal)).toBeUndefined();
    expect(fake.questions).toEqual([{ question: { severity: 'info', message: 'SSH is waiting for you.', detail: 'Confirm user presence for key ED25519-SK SHA256:abc', actions: ['OK'], defaultAction: 0 }, signal }]);
  });
});

describe('a host-key question whose helper goes away', () => {
  let server: AskpassServer | undefined;
  afterEach(async () => {
    await server?.dispose();
  });

  it('closes, and the next credential prompt shows at once', async () => {
    const requests: OverlayRequest[] = [];
    // as OverlayHost does: a request settles dismissed when its signal aborts
    const overlay: MessageOverlay = {
      request: (request, _focus, _shown, _browse, withdraw) => {
        requests.push(request);
        return new Promise<OverlayAnswer>((resolve) => withdraw?.addEventListener('abort', () => resolve({ kind: 'dismissed' })));
      },
    };
    const ask = createMessageAsker({ overlay: () => overlay, window: () => undefined, focused: () => undefined, closing: () => false, log: () => undefined });
    const askInput: AskInput = async () => 'ada';
    const log: string[] = [];
    server = createAskpassServer({
      paths: { askpass: '/a.sh', sshAskpass: '/s.sh', node: '/node', main: '/main.js' },
      prompt: createAskpassBridge({ ask, askInput, t }),
      log: (line) => log.push(line),
    });
    const registration = await server.register('interactive', 'fetch');
    const handle = registration.env['DAMOCLES_ASKPASS_HANDLE']!;
    const request = (kind: string, text: string): string => `${JSON.stringify({ nonce: registration.env['DAMOCLES_ASKPASS_NONCE'], kind, argv: [text] })}\n`;
    const helper = net.connect(handle);
    helper.on('error', () => undefined);
    helper.write(request('ssh', "The authenticity of host 'example.com' can't be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?"));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    helper.destroy();
    const started = Date.now();
    const reply = await new Promise<string>((resolve) => {
      const next = net.connect(handle);
      let text = '';
      next.on('data', (chunk) => (text += chunk.toString('utf8')));
      next.on('close', () => resolve(text));
      next.write(request('askpass', "Username for 'https://example.com': "));
    });
    expect(reply).toBe(`${JSON.stringify({ answer: 'ada' })}\n`);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(log).toEqual([]);
  });
});
