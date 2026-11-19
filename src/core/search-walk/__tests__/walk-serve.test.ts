import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { portWalkChannel, stdioWalkChannel } from '../walk-channels';
import { serveWalks } from '../walk-serve';
import { lineReader, walkLine, WALK_FLUSH_MS, type WalkReply, type WalkRequest } from '../walk-protocol';
import type { WalkOptions } from '../walk';

// Each test sets the walk walkFiles gives the process and reads the options it was called with.
const walkStub = vi.hoisted(() => ({
  files: (async function* () {})() as AsyncGenerator<readonly string[], void, undefined>,
  options: [] as WalkOptions[],
  insideRepo: false,
  // folders still being read ahead, and what settles them
  ahead: 0,
  settled: Promise.resolve() as Promise<void>,
}));
vi.mock('../walk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../walk')>()),
  walkFiles: (options: WalkOptions) => {
    walkStub.options.push(options);
    return { errors: [], files: walkStub.files, readsAhead: () => walkStub.ahead, readsSettled: () => walkStub.settled };
  },
  insideGitRepo: async () => walkStub.insideRepo,
}));

const walk = (overrides: Partial<Extract<WalkRequest, { kind: 'walk' }>> = {}): WalkRequest => ({
  kind: 'walk',
  id: 1,
  root: '/r',
  requireGit: true,
  ignore: { files: true, global: true, parents: true },
  gitFolders: 'skip',
  overrides: [],
  ...overrides,
});

// serveWalks over an in-memory channel.
function serve(): { receive: (request: WalkRequest) => void; replies: WalkReply[] } {
  const replies: WalkReply[] = [];
  let receive: (request: WalkRequest) => void = () => undefined;
  serveWalks({ send: (reply) => void replies.push(reply), onRequest: (listener) => {
    receive = listener;
  } });
  return { receive: (request) => receive(request), replies };
}

beforeEach(() => {
  walkStub.ahead = 0;
  walkStub.settled = Promise.resolve();
});

describe('serveWalks', () => {
  it('sends a waiting count batch when the walk next finds files, before the walk ends', async () => {
    let release = (): void => {};
    walkStub.files = (async function* () {
      yield ['a.ts'];
      await new Promise((resolve) => setTimeout(resolve, WALK_FLUSH_MS + 50));
      yield ['b.ts', 'c.ts'];
      await new Promise<void>((resolve) => (release = resolve));
    })();
    const { receive, replies } = serve();
    receive(walk());
    await vi.waitFor(() => expect(replies).toEqual([{ kind: 'files', id: 1, files: ['a.ts'] }]), { timeout: 2000 });
    release();
    await vi.waitFor(() => expect(replies.at(-1)).toEqual({ kind: 'end', id: 1, errors: [] }));
    expect(replies).toEqual([{ kind: 'files', id: 1, files: ['a.ts'] }, { kind: 'files', id: 1, files: ['b.ts', 'c.ts'] }, { kind: 'end', id: 1, errors: [] }]);
  });

  it('sends a waiting command-line batch when the walk next lists a folder, one with no file included, so the first rg starts early', async () => {
    let release = (): void => {};
    walkStub.files = (async function* () {
      yield ['a.ts'];
      await new Promise((resolve) => setTimeout(resolve, WALK_FLUSH_MS + 50));
      yield [];
      await new Promise<void>((resolve) => (release = resolve));
      yield ['b.ts'];
    })();
    const { receive, replies } = serve();
    receive(walk({ lineBudget: 32_000 }));
    await vi.waitFor(() => expect(replies).toEqual([{ kind: 'files', id: 1, files: ['a.ts'] }]), { timeout: 2000 });
    release();
    await vi.waitFor(() => expect(replies.at(-1)).toEqual({ kind: 'end', id: 1, errors: [] }));
    expect(replies).toEqual([{ kind: 'files', id: 1, files: ['a.ts'] }, { kind: 'files', id: 1, files: ['b.ts'] }, { kind: 'end', id: 1, errors: [] }]);
  });

  it('sends no end for a walk cancelled after its last folder, only its released', async () => {
    walkStub.files = (async function* () {})();
    const { receive, replies } = serve();
    receive(walk());
    receive({ kind: 'cancel', id: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replies).toEqual([{ kind: 'released', id: 1 }]);
  });

  it('ends a walk at a maxFiles that is no integer, as damocles.maxIndexedFiles may be', async () => {
    walkStub.files = (async function* () {
      yield ['a.ts', 'b.ts'];
      yield ['c.ts', 'd.ts'];
      yield ['e.ts'];
    })();
    const { receive, replies } = serve();
    receive(walk({ maxFiles: 2.5 }));
    await vi.waitFor(() => expect(replies.at(-1)?.kind).toBe('end'));
    expect(replies).toEqual([{ kind: 'files', id: 1, files: ['a.ts', 'b.ts', 'c.ts'] }, { kind: 'end', id: 1, errors: [] }]);
  });

  it('releases a cancelled walk once the folders it read ahead are read, and says an end leaves reads running', async () => {
    let settle = (): void => {};
    walkStub.ahead = 3;
    walkStub.settled = new Promise<void>((resolve) => (settle = resolve));
    let release = (): void => {};
    walkStub.files = (async function* () {
      yield ['a.ts'];
      await new Promise<void>((resolve) => (release = resolve));
    })();
    const { receive, replies } = serve();
    receive(walk());
    await new Promise((resolve) => setTimeout(resolve, 20));
    receive({ kind: 'cancel', id: 1 });
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // the reads a share holds keep the walk's load until they return
    expect(replies).toEqual([]);
    settle();
    await vi.waitFor(() => expect(replies.at(-1)).toEqual({ kind: 'released', id: 1 }));
    // an end while reads run says so, and its released follows them
    walkStub.settled = new Promise<void>((resolve) => (settle = resolve));
    walkStub.files = (async function* () {
      yield ['b.ts'];
    })();
    receive(walk({ id: 2 }));
    await vi.waitFor(() => expect(replies.at(-1)).toEqual({ kind: 'end', id: 2, errors: [], reading: true }));
    settle();
    await vi.waitFor(() => expect(replies.at(-1)).toEqual({ kind: 'released', id: 2 }));
  });

  it('ends a walk once it listed maxFiles files, the last batch cut there', async () => {
    walkStub.files = (async function* () {
      yield ['a.ts', 'b.ts'];
      yield ['c.ts', 'd.ts'];
      yield ['e.ts'];
    })();
    const { receive, replies } = serve();
    receive(walk({ maxFiles: 3 }));
    await vi.waitFor(() => expect(replies.at(-1)?.kind).toBe('end'));
    expect(replies).toEqual([{ kind: 'files', id: 1, files: ['a.ts', 'b.ts', 'c.ts'] }, { kind: 'end', id: 1, errors: [] }]);
  });

  it('decides requireGit from the folders above the root for insideRepo, and reads a pointer only onto the hosts it is given', async () => {
    walkStub.options.length = 0;
    const { receive, replies } = serve();
    for (const [id, insideRepo] of [[1, true], [2, false]] as const) {
      walkStub.insideRepo = insideRepo;
      walkStub.files = (async function* () {})();
      receive(walk({ id, requireGit: 'insideRepo', allowedHosts: ['files.example'] }));
      await vi.waitFor(() => expect(replies.at(-1)).toEqual({ kind: 'end', id, errors: [] }));
    }
    expect(walkStub.options.map((options) => options.requireGit)).toEqual([true, false]);
    expect([...await walkStub.options[0]!.allowedHosts()]).toEqual(['files.example']);
  });
});

describe('the walk process\'s channels', () => {
  const expected: WalkReply[] = [{ kind: 'files', id: 1, files: ['a.ts', 'b.ts'] }, { kind: 'end', id: 1, errors: [] }];

  beforeEach(() => {
    walkStub.files = (async function* () {
      yield ['a.ts', 'b.ts'];
    })();
  });

  it('serves walks over stdin and stdout, one JSON message a line, and ends when stdin ends', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const replies: WalkReply[] = [];
    output.on('data', lineReader(1 << 20, (line) => replies.push(JSON.parse(line) as WalkReply), () => undefined));
    let ended = 0;
    serveWalks(stdioWalkChannel(input, output, () => ended++));
    const request = walkLine(walk());
    input.write(request.slice(0, 7));
    input.write(request.slice(7));
    await vi.waitFor(() => expect(replies).toEqual(expected));
    expect(ended).toBe(0);
    input.end();
    await vi.waitFor(() => expect(ended).toBeGreaterThan(0));
  });

  it('serves walks over a utility process\'s parent port, each message a structured clone', async () => {
    const port = Object.assign(new EventEmitter(), { postMessage: vi.fn((reply: unknown) => structuredClone(reply)) });
    serveWalks(portWalkChannel(port));
    port.emit('message', { data: structuredClone(walk()) });
    await vi.waitFor(() => expect(port.postMessage.mock.calls.map(([reply]) => reply)).toEqual(expected));
  });
});
