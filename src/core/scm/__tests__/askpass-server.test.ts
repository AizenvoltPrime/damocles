import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ABANDONED_SOCKET_FOLDER_AGE_MS,
  ASKPASS_REQUEST_DEADLINE_MS,
  classifyPrompt,
  createAskpassServer,
  isSendableAnswer,
  MAX_ASKPASS_REQUEST_BYTES,
  parseAskpassRequest,
  promptText,
  MAX_WAITING_CONNECTIONS,
  PROMPT_CANCELLED,
  removeAbandonedSocketFolders,
  WITHDRAWN_PROMPT_GRACE_MS,
  type AskpassServer,
  type AskpassServerDeps,
  type CredentialPrompt,
  type PromptCredential,
} from '../askpass/askpass-server';

const PATHS = { askpass: '/app/dist/askpass/askpass.sh', sshAskpass: '/app/dist/askpass/ssh-askpass.sh', node: '/app/damocles', main: '/app/dist/askpass-main.js' };
const SECRET = 'sentinel-askpass-secret-4711';

const servers: AskpassServer[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) await server.dispose();
});

function start(prompt: PromptCredential = async () => SECRET, deps: Partial<AskpassServerDeps> = {}) {
  const log: string[] = [];
  const prompts: CredentialPrompt[] = [];
  const server = createAskpassServer({
    paths: PATHS,
    prompt: (request, signal) => {
      prompts.push(request);
      return prompt(request, signal);
    },
    log: (line) => log.push(line),
    ...deps,
  });
  servers.push(server);
  return { server, log, prompts };
}

// Sends raw bytes as a helper would and resolves what came back once the server closed the connection.
function exchange(handle: string, payload: string | Buffer): Promise<{ reply: string }> {
  return new Promise((resolve) => {
    const socket = net.connect(handle);
    let reply = '';
    socket.on('data', (chunk) => (reply += chunk.toString('utf8')));
    socket.on('error', () => undefined);
    socket.on('close', () => resolve({ reply }));
    socket.write(payload);
  });
}

const line = (body: unknown): string => `${JSON.stringify(body)}\n`;

describe('the askpass server', () => {
  it('answers a registered nonce with the prompt answer, and gives each registration its own nonce and only its env', async () => {
    const { server, prompts } = start();
    const first = await server.register('interactive', 'push');
    const second = await server.register('interactive', 'fetch');
    expect(first.env['DAMOCLES_ASKPASS_NONCE']).toMatch(/^[0-9a-f]{64}$/);
    expect(first.env['DAMOCLES_ASKPASS_NONCE']).not.toBe(second.env['DAMOCLES_ASKPASS_NONCE']);
    expect(first.env).toMatchObject({ GIT_ASKPASS: PATHS.askpass, SSH_ASKPASS: PATHS.sshAskpass, SSH_ASKPASS_REQUIRE: 'force', DAMOCLES_ASKPASS_NODE: PATHS.node, DAMOCLES_ASKPASS_MAIN: PATHS.main });
    expect(first.env).not.toHaveProperty('GCM_INTERACTIVE');
    expect(first.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    const handle = first.env['DAMOCLES_ASKPASS_HANDLE']!;
    if (process.platform === 'win32') expect(handle).toMatch(/^\\\\\.\\pipe\\damocles-askpass-[0-9a-f]{32}$/);
    const answer = await exchange(handle, line({ nonce: first.env['DAMOCLES_ASKPASS_NONCE'], kind: 'askpass', argv: ["Password for 'https://ada@example.com': "] }));
    expect(answer.reply).toBe(`${JSON.stringify({ answer: SECRET })}\n`);
    expect(prompts).toEqual([{ kind: 'password', text: "Password for 'https://example.com':" }]);
  });

  it('drops a connection with an unknown nonce, malformed or oversized request, or bytes after the request, prompting nothing', async () => {
    const { server, prompts, log } = start();
    const registration = await server.register('interactive', 'push');
    const handle = registration.env['DAMOCLES_ASKPASS_HANDLE']!;
    const nonce = registration.env['DAMOCLES_ASKPASS_NONCE']!;
    const refused: Array<string | Buffer> = [
      line({ nonce: 'a'.repeat(64), kind: 'askpass', argv: ['Username: '] }),
      line({ nonce: nonce.toUpperCase(), kind: 'askpass', argv: ['Username: '] }),
      line({ nonce, kind: 'askpass', argv: ['Username: '], extra: 1 }),
      line({ nonce, kind: 'shell', argv: ['Username: '] }),
      line({ nonce, kind: 'askpass', argv: [] }),
      line({ nonce, kind: 'askpass', argv: Array.from({ length: 17 }, () => 'x') }),
      'not json\n',
      Buffer.from([0xff, 0xfe, 0x0a]),
      line({ nonce, kind: 'askpass', argv: ['Username: '], sshPrompt: 'none' }),
      line({ nonce, kind: 'ssh', argv: ['Passphrase: '], sshPrompt: 'other' }),
      'x'.repeat(MAX_ASKPASS_REQUEST_BYTES + 1),
    ];
    for (const payload of refused) expect((await exchange(handle, payload)).reply).toBe('');
    expect(prompts).toEqual([]);
    expect(log.every((entry) => entry.startsWith('[askpass] dropped a helper connection: '))).toBe(true);
    expect(log.join('\n')).not.toContain(nonce);
  });

  it('never answers a request followed by more bytes, however the transport splits them', async () => {
    // the prompt settles only when withdrawn, so a split that lets the request through first still answers nothing
    const { server } = start((_prompt, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(SECRET))));
    const registration = await server.register('interactive', 'push');
    const request = line({ nonce: registration.env['DAMOCLES_ASKPASS_NONCE'], kind: 'askpass', argv: ['Username: '] });
    expect((await exchange(registration.env['DAMOCLES_ASKPASS_HANDLE']!, `${request}more`)).reply).toBe('');
  });

  it('drops the oldest connection still owing its request, so idle connections cannot shut out a helper', async () => {
    const { server, log } = start();
    const registration = await server.register('interactive', 'push');
    const handle = registration.env['DAMOCLES_ASKPASS_HANDLE']!;
    const idle = await Promise.all(Array.from({ length: MAX_WAITING_CONNECTIONS + 2 }, () => new Promise<net.Socket>((resolve) => {
      const socket = net.connect(handle, () => resolve(socket));
      socket.on('error', () => undefined);
    })));
    let closed = 0;
    for (const socket of idle) socket.on('close', () => closed++);
    const answer = await exchange(handle, line({ nonce: registration.env['DAMOCLES_ASKPASS_NONCE'], kind: 'askpass', argv: ["Password for 'https://example.com': "] }));
    expect(answer.reply).toBe(`${JSON.stringify({ answer: SECRET })}\n`);
    // the helper made the 19th connection, so three idle ones made way
    await vi.waitFor(() => expect(closed).toBe(3));
    expect(log).toEqual([`[askpass] more than ${MAX_WAITING_CONNECTIONS} connections waited for their request; the oldest are dropped`]);
    for (const socket of idle) socket.destroy();
  });

  it('refuses a registration that was waiting for the server to start when it was disposed', async () => {
    const { server } = start();
    const registering = expect(server.register('interactive', 'push')).rejects.toThrow('disposed');
    await server.dispose();
    await registering;
  });

  it('answers a background registration with a cancel, never prompts, and logs once per registration', async () => {
    const { server, prompts, log } = start();
    const registration = await server.register('background', 'autofetch');
    expect(registration.env['GCM_INTERACTIVE']).toBe('never');
    const request = line({ nonce: registration.env['DAMOCLES_ASKPASS_NONCE'], kind: 'askpass', argv: ["Username for 'https://example.com': "] });
    for (let i = 0; i < 2; i++) expect((await exchange(registration.env['DAMOCLES_ASKPASS_HANDLE']!, request)).reply).toBe(`${JSON.stringify({ cancel: true })}\n`);
    expect(prompts).toEqual([]);
    expect(log).toEqual(['[askpass] autofetch runs in the background, so its credential request was answered with a cancel']);
  });

  it('cancels its registration before the helper hears a cancel the user gave, and for no other unanswered prompt', async () => {
    const events: string[] = [];
    let next: () => Promise<string | typeof PROMPT_CANCELLED | undefined> = async () => PROMPT_CANCELLED;
    const { server } = start(() => next());
    const ask = async (mode: 'interactive' | 'background', text = "Username for 'https://example.com': ") => {
      const registration = await server.register(mode, 'fetch');
      registration.cancelled.addEventListener('abort', () => events.push('cancelled'));
      const reply = await new Promise<string>((resolve) => {
        const socket = net.connect(registration.env['DAMOCLES_ASKPASS_HANDLE']!);
        let received = '';
        socket.on('data', (chunk) => {
          events.push('reply');
          received += chunk.toString('utf8');
        });
        socket.on('error', () => undefined);
        socket.on('close', () => resolve(received));
        socket.write(line({ nonce: registration.env['DAMOCLES_ASKPASS_NONCE'], kind: 'askpass', argv: [text] }));
      });
      return { reply, cancelled: registration.cancelled.aborted };
    };
    expect(await ask('interactive')).toEqual({ reply: `${JSON.stringify({ cancel: true })}\n`, cancelled: true });
    expect(events).toEqual(['cancelled', 'reply']);
    // a notice closing or a withdrawn prompt, an answer refused for a line break, a prompt that threw, and a background call
    next = async () => undefined;
    expect((await ask('interactive')).cancelled).toBe(false);
    next = async () => 'a\nb';
    expect((await ask('interactive')).cancelled).toBe(false);
    next = async () => {
      throw new Error('the overlay is gone');
    };
    expect((await ask('interactive')).cancelled).toBe(false);
    next = async () => PROMPT_CANCELLED;
    expect((await ask('background')).cancelled).toBe(false);
  });

  it('never logs an answer or the prompt text, and refuses an answer holding a line break', async () => {
    let next = SECRET;
    const { server, log } = start(async () => next);
    const registration = await server.register('interactive', 'push');
    const ask = () => exchange(registration.env['DAMOCLES_ASKPASS_HANDLE']!, line({ nonce: registration.env['DAMOCLES_ASKPASS_NONCE'], kind: 'askpass', argv: ['Password for secret-host: '] }));
    expect((await ask()).reply).toContain(SECRET);
    next = `${SECRET}\nextra`;
    expect((await ask()).reply).toBe(`${JSON.stringify({ cancel: true })}\n`);
    expect(log.join('\n')).not.toContain(SECRET);
    expect(log.join('\n')).not.toContain('secret-host');
  });

  it('withdraws an open prompt when its registration ends, and refuses the registration afterwards', async () => {
    let signal: AbortSignal | undefined;
    // as the desktop bridge does, the prompt settles when its signal withdraws it
    const { server } = start((_prompt, abort) => {
      signal = abort;
      return new Promise((resolve) => abort.addEventListener('abort', () => resolve(undefined)));
    });
    const registration = await server.register('interactive', 'push');
    const pending = exchange(registration.env['DAMOCLES_ASKPASS_HANDLE']!, line({ nonce: registration.env['DAMOCLES_ASKPASS_NONCE'], kind: 'askpass', argv: ['Username: '] }));
    await vi.waitFor(() => expect(signal).toBeDefined());
    registration.dispose();
    expect(signal!.aborted).toBe(true);
    expect((await pending).reply).toBe('');
    expect((await exchange(registration.env['DAMOCLES_ASKPASS_HANDLE']!, line({ nonce: registration.env['DAMOCLES_ASKPASS_NONCE'], kind: 'askpass', argv: ['Username: '] }))).reply).toBe('');
  });

  it('withdraws a showing prompt when its helper goes away, and shows the next one', async () => {
    const signals = new Map<string, AbortSignal>();
    const { server } = start((prompt, signal) => {
      signals.set(prompt.text, signal);
      return prompt.text === 'Username: first' ? new Promise((resolve) => signal.addEventListener('abort', () => resolve(undefined))) : Promise.resolve('x');
    });
    const registration = await server.register('interactive', 'clone');
    const handle = registration.env['DAMOCLES_ASKPASS_HANDLE']!;
    const request = (text: string) => line({ nonce: registration.env['DAMOCLES_ASKPASS_NONCE'], kind: 'askpass', argv: [text] });
    const first = net.connect(handle);
    first.on('error', () => undefined);
    first.write(request('Username: first'));
    await vi.waitFor(() => expect(signals.has('Username: first')).toBe(true));
    const second = exchange(handle, request('Username: second'));
    first.destroy();
    expect((await second).reply).toBe(`${JSON.stringify({ answer: 'x' })}\n`);
    expect(signals.get('Username: first')!.aborted).toBe(true);
  });

  it('lets a withdrawn prompt that never settles hold the line only for the grace period', async () => {
    const shown: string[] = [];
    const { server, log } = start((prompt) => {
      shown.push(prompt.text);
      // ignores its signal, as an OS message box must
      return prompt.text === 'Username: first' ? new Promise(() => undefined) : Promise.resolve('x');
    });
    const registration = await server.register('interactive', 'clone');
    const handle = registration.env['DAMOCLES_ASKPASS_HANDLE']!;
    const request = (text: string) => line({ nonce: registration.env['DAMOCLES_ASKPASS_NONCE'], kind: 'askpass', argv: [text] });
    const first = exchange(handle, request('Username: first'));
    await vi.waitFor(() => expect(shown).toEqual(['Username: first']));
    const withdrawnAt = Date.now();
    registration.dispose();
    expect((await first).reply).toBe('');
    const next = await server.register('interactive', 'fetch');
    const second = await exchange(handle, line({ nonce: next.env['DAMOCLES_ASKPASS_NONCE'], kind: 'askpass', argv: ['Username: second'] }));
    expect(second.reply).toBe(`${JSON.stringify({ answer: 'x' })}\n`);
    expect(Date.now() - withdrawnAt).toBeGreaterThanOrEqual(WITHDRAWN_PROMPT_GRACE_MS - 50);
    expect(log).toEqual([`[askpass] a withdrawn credential prompt did not close within ${WITHDRAWN_PROMPT_GRACE_MS} ms; the next one shows anyway`]);
  }, 10_000);

  it('withdraws an open prompt on dispose and closes its connection', async () => {
    let signal: AbortSignal | undefined;
    const { server } = start((_prompt, abort) => {
      signal = abort;
      return new Promise((resolve) => abort.addEventListener('abort', () => resolve(undefined)));
    });
    const registration = await server.register('interactive', 'push');
    const handle = registration.env['DAMOCLES_ASKPASS_HANDLE']!;
    const pending = exchange(handle, line({ nonce: registration.env['DAMOCLES_ASKPASS_NONCE'], kind: 'askpass', argv: ['Username: '] }));
    await vi.waitFor(() => expect(signal).toBeDefined());
    await server.dispose();
    expect(signal!.aborted).toBe(true);
    expect((await pending).reply).toBe('');
    if (process.platform !== 'win32') expect(fs.existsSync(path.dirname(handle))).toBe(false);
  });

  it('shows one prompt at a time, in arrival order', async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const { server } = start(async (prompt) => {
      order.push(`start ${prompt.text}`);
      if (prompt.text === 'Username: first') await new Promise<void>((resolve) => (release = resolve));
      order.push(`end ${prompt.text}`);
      return 'x';
    });
    const registration = await server.register('interactive', 'clone');
    const send = (text: string) => exchange(registration.env['DAMOCLES_ASKPASS_HANDLE']!, line({ nonce: registration.env['DAMOCLES_ASKPASS_NONCE'], kind: 'askpass', argv: [text] }));
    const first = send('Username: first');
    await vi.waitFor(() => expect(release).toBeDefined());
    const second = send('Username: second');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual(['start Username: first']);
    release!();
    await Promise.all([first, second]);
    expect(order).toEqual(['start Username: first', 'end Username: first', 'start Username: second', 'end Username: second']);
  });

  it('keeps the line when a waiting prompt is withdrawn: the next one starts only once the one showing settled', async () => {
    const started: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const { server } = start(async (prompt) => {
      started.push(prompt.text);
      if (prompt.text === 'Username: first') await new Promise<void>((resolve) => (releaseFirst = resolve));
      return 'x';
    });
    const registration = await server.register('interactive', 'clone');
    const handle = registration.env['DAMOCLES_ASKPASS_HANDLE']!;
    const request = (text: string) => line({ nonce: registration.env['DAMOCLES_ASKPASS_NONCE'], kind: 'askpass', argv: [text] });
    const first = exchange(handle, request('Username: first'));
    await vi.waitFor(() => expect(releaseFirst).toBeDefined());
    const second = net.connect(handle);
    second.on('error', () => undefined);
    second.write(request('Username: second'));
    const third = exchange(handle, request('Username: third'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    second.destroy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(started).toEqual(['Username: first']);
    releaseFirst!();
    await Promise.all([first, third]);
    expect(started).toEqual(['Username: first', 'Username: third']);
  });

  it('drops a helper that has not sent its request within the deadline, however slowly it trickles bytes', async () => {
    const { server } = start();
    const registration = await server.register('interactive', 'push');
    const socket = net.connect(registration.env['DAMOCLES_ASKPASS_HANDLE']!);
    socket.on('error', () => undefined);
    await new Promise((resolve) => socket.once('connect', resolve));
    const started = Date.now();
    const closed = new Promise((resolve) => socket.on('close', resolve));
    const trickle = setInterval(() => socket.write('{'), 1000);
    await closed;
    clearInterval(trickle);
    expect(Date.now() - started).toBeLessThan(ASKPASS_REQUEST_DEADLINE_MS + 2000);
  }, 15_000);

  it.skipIf(process.platform === 'win32')('listens in a folder only its user can enter, and removes it on dispose (POSIX: Windows uses a named pipe)', async () => {
    const { server } = start(undefined, { runtimeDir: () => undefined });
    const registration = await server.register('interactive', 'push');
    const dir = path.dirname(registration.env['DAMOCLES_ASKPASS_HANDLE']!);
    expect(dir.startsWith(fs.realpathSync(os.tmpdir())) || dir.startsWith(os.tmpdir())).toBe(true);
    const stat = fs.lstatSync(dir);
    expect(stat.isDirectory() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid!()).toBe(true);
    await server.dispose();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('listens under XDG_RUNTIME_DIR when it is set, and falls back to the temp folder when that fails', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-runtime-')));
    try {
      const preferred = start(undefined, { runtimeDir: () => base });
      const handle = (await preferred.server.register('interactive', 'push')).env['DAMOCLES_ASKPASS_HANDLE']!;
      expect(path.dirname(path.dirname(handle))).toBe(base);
      const fallback = start(undefined, { runtimeDir: () => path.join(base, 'missing') });
      const other = (await fallback.server.register('interactive', 'push')).env['DAMOCLES_ASKPASS_HANDLE']!;
      expect(other.startsWith(base)).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('removes its folder from a temp folder too deep for a socket, and listens under /tmp instead', async () => {
    // past every platform's socket path limit
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-long-'));
    const long = path.join(base, 'x'.repeat(120));
    fs.mkdirSync(long);
    try {
      const { server } = start(undefined, { runtimeDir: () => undefined, tmpdir: () => long });
      const handle = (await server.register('interactive', 'push')).env['DAMOCLES_ASKPASS_HANDLE']!;
      expect(path.dirname(path.dirname(handle))).toBe('/tmp');
      // a truncated bind would have left a socket beside the deep folder
      expect(fs.readdirSync(base)).toEqual([path.basename(long)]);
      expect(fs.readdirSync(long)).toEqual([]);
      await server.dispose();
      expect(fs.existsSync(path.dirname(handle))).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('askpass requests and prompts', () => {
  it('classifies git and ssh prompts, masking anything but a username', () => {
    expect(classifyPrompt('askpass', "Username for 'https://example.com':")).toBe('username');
    expect(classifyPrompt('askpass', "Password for 'https://ada@example.com':")).toBe('password');
    expect(classifyPrompt('askpass', 'Personal access token:')).toBe('password');
    // credential.useHttpPath puts the path in the prompt, and a host can hold the word too
    expect(classifyPrompt('askpass', "Password for 'https://github.com/acme/username-generator.git':")).toBe('password');
    expect(classifyPrompt('askpass', "Password for 'https://username.example.com':")).toBe('password');
    expect(classifyPrompt('ssh', "Enter passphrase for key '/home/ada/.ssh/id_ed25519':")).toBe('passphrase');
    expect(classifyPrompt('ssh', "The authenticity of host 'example.com (1.2.3.4)' can't be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?")).toBe('confirm');
    expect(classifyPrompt('ssh', "ada@example.com's password:")).toBe('password');
    expect(classifyPrompt('ssh', 'Enter PIN for authenticator:')).toBe('password');
  });

  it('takes SSH_ASKPASS_PROMPT over the text: confirm is the yes/no question, none a notice', () => {
    expect(classifyPrompt('ssh', 'Allow shared connection to example.com? ', 'confirm')).toBe('confirm');
    expect(classifyPrompt('ssh', 'Confirm user presence for key ED25519-SK SHA256:abc', 'none')).toBe('notice');
    expect(classifyPrompt('ssh', 'Enter passphrase for key:', 'none')).toBe('notice');
  });

  it('shows prompt text as plain bounded text without URL userinfo, control or format characters', () => {
    expect(promptText(["Password for 'https://ada:tok@example.com':\u001b[31m\u202e "])).toBe("Password for 'https://example.com':[31m");
    expect(promptText(['exa\u200bmple.com\u2060\ufeff\u00ad\u2064 a\tb\nc'])).toBe('example.com a\tb\nc');
    expect(promptText(['x'.repeat(5000)]).length).toBe(1000);
    // cut by code point, so a pair is never split
    const cut = promptText(['x'.repeat(998) + '\u{1F600}'.repeat(5)]);
    expect(cut).toBe(`${'x'.repeat(998)}\u{1F600}…`);
  });

  it('parses exactly nonce, kind and argv', () => {
    const nonce = 'f'.repeat(64);
    expect(parseAskpassRequest(Buffer.from(JSON.stringify({ nonce, kind: 'ssh', argv: ['Passphrase: '] })))).toEqual({ nonce, kind: 'ssh', argv: ['Passphrase: '] });
    expect(parseAskpassRequest(Buffer.from(JSON.stringify({ nonce, kind: 'ssh', argv: ['x'.repeat(4097)] })))).toBeUndefined();
    expect(parseAskpassRequest(Buffer.from(JSON.stringify({ nonce: nonce.slice(1), kind: 'ssh', argv: ['a'] })))).toBeUndefined();
    expect(parseAskpassRequest(Buffer.from(JSON.stringify([nonce, 'ssh', ['a']])))).toBeUndefined();
  });

  it('sends only an answer with no line break or NUL within the bound', () => {
    expect(isSendableAnswer('p@ss word')).toBe(true);
    for (const answer of ['a\nb', 'a\rb', 'a\0b', 'x'.repeat(4097)]) expect(isSendableAnswer(answer)).toBe(false);
  });
});

describe('the sweep of abandoned socket folders', () => {
  const bases: string[] = [];
  afterEach(() => {
    for (const base of bases.splice(0)) fs.rmSync(base, { recursive: true, force: true });
  });

  // a socket folder under a base of its own, last changed `ageMs` before now
  function folderIn(base: string, name: string, entries: readonly string[], ageMs: number, now: number): string {
    const dir = path.join(base, name);
    fs.mkdirSync(dir);
    for (const entry of entries) fs.writeFileSync(path.join(dir, entry), '');
    const at = new Date(now - ageMs);
    fs.utimesSync(dir, at, at);
    return dir;
  }

  it('removes an old folder whose socket refuses or is missing, and keeps one that answers, is young, holds more or is not its', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-sweep-')));
    bases.push(base);
    const now = Date.now();
    const old = ABANDONED_SOCKET_FOLDER_AGE_MS + 1000;
    const refused = folderIn(base, 'damocles-askpass-refused', ['askpass.sock'], old, now);
    const empty = folderIn(base, 'damocles-askpass-empty', [], old, now);
    const live = folderIn(base, 'damocles-askpass-live', ['askpass.sock'], old, now);
    const unknown = folderIn(base, 'damocles-askpass-busy', ['askpass.sock'], old, now);
    const starting = folderIn(base, 'damocles-askpass-young', [], 1000, now);
    const crowded = folderIn(base, 'damocles-askpass-crowded', ['askpass.sock', 'other'], old, now);
    const foreign = folderIn(base, 'other-askpass-old', [], old, now);
    const answers = new Map([[refused, 'refused'], [live, 'listening'], [unknown, 'unknown']] as const);
    const probed: string[] = [];
    const log: string[] = [];
    await removeAbandonedSocketFolders({
      tmpdir: () => base,
      runtimeDir: () => undefined,
      now,
      log: (line) => log.push(line),
      probe: async (socketPath) => {
        probed.push(socketPath);
        return answers.get(path.dirname(socketPath)) ?? 'unknown';
      },
    });
    expect([refused, empty].map((dir) => fs.existsSync(dir))).toEqual([false, false]);
    expect([live, unknown, starting, crowded, foreign].map((dir) => fs.existsSync(dir))).toEqual([true, true, true, true, true]);
    expect(probed.filter((socketPath) => socketPath.startsWith(base)).sort()).toEqual([live, refused, unknown].map((dir) => path.join(dir, 'askpass.sock')).sort());
    expect(log.filter((line) => line.includes(base))).toHaveLength(2);
  });

  it.skipIf(process.platform === 'win32')('keeps the folder of a server that listens, in this process or another, and removes one whose socket is gone', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-sweep-')));
    bases.push(base);
    const { server } = start(undefined, { runtimeDir: () => base });
    const liveDir = path.dirname((await server.register('interactive', 'push')).env['DAMOCLES_ASKPASS_HANDLE']!);
    const now = Date.now();
    const at = new Date(now - ABANDONED_SOCKET_FOLDER_AGE_MS - 1000);
    fs.utimesSync(liveDir, at, at);
    const gone = folderIn(base, 'damocles-askpass-gone', [], ABANDONED_SOCKET_FOLDER_AGE_MS + 1000, now);
    await removeAbandonedSocketFolders({ runtimeDir: () => base, tmpdir: () => base, now, log: () => undefined });
    expect(fs.existsSync(liveDir)).toBe(true);
    expect(fs.existsSync(gone)).toBe(false);
  });
});
