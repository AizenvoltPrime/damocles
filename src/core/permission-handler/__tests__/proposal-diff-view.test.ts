import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PermissionHandler } from '../index';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import type { DiffSide } from '../../../platform/editor-service';
import type { CanUseToolContext } from '../types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { DiffManager } from '../diff-manager';
import { FILE_PATCH_MAX_BYTES } from '../../pi-session/tools/file-patch';
import { createEditTool } from '../../pi-session/tools/edit-tool';
import { createWriteTool } from '../../pi-session/tools/write-tool';
import { getPiCodingAgent, initPiLoader, type PiCodingAgentModule } from '../../pi-session/pi-loader';

/** Paths whose access check (pi's edit's and replace_all's) fails, with the code, as a read-only or unreadable file fails it. */
const deniedAccess = vi.hoisted(() => new Map<string, string>());

/** Paths whose stat, as the Edit tool takes it, answers as a FIFO's. */
const fifos = vi.hoisted(() => new Set<string>());

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    access: (async (file: string, mode?: number) => {
      const code = deniedAccess.get(String(file));
      if (code !== undefined) throw Object.assign(new Error(`${code}: permission denied, access '${String(file)}'`), { code });
      return actual.access(file, mode);
    }) as typeof actual.access,
    stat: (async (file: string, options?: object) => {
      const stats = await actual.stat(file, options);
      return fifos.has(String(file)) ? Object.assign(stats, { isFile: () => false, isFIFO: () => true }) : stats;
    }) as typeof actual.stat,
  };
});

let pi: PiCodingAgentModule;

beforeAll(async () => {
  pi = (await initPiLoader())!;
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The path of a file named `name` in a new temp folder, holding `content`, or absent where it is null. */
function tempFile(content: string | Buffer | null, name = 'a.txt'): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-approval-'));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  if (content !== null) fs.writeFileSync(file, content);
  return { dir, file };
}

function diffManager(platform: FakePlatform = createFakePlatform()): DiffManager {
  return new DiffManager(platform.editor, 'host-1', () => pi);
}

function handlerFor(panelId: string): { handler: PermissionHandler; platform: FakePlatform; file: string } {
  const platform = createFakePlatform();
  const { dir, file } = tempFile('alpha\nbeta\n');
  const handler = new PermissionHandler(platform, getPiCodingAgent, panelId);
  handler.setCwd(dir);
  handler.setPostMessage(() => undefined);
  return { handler, platform, file };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never held');
}

function requestEdit(handler: PermissionHandler, file: string, toolUseID: string, signal = new AbortController().signal): Promise<unknown> {
  const ctx: CanUseToolContext = { signal, toolUseID, parentToolUseId: null };
  return handler.canUseTool('Edit', { file_path: file, old_string: 'alpha', new_string: 'omega' }, ctx);
}

describe('proposal diff view', () => {
  it('names the owning panel and the permission prompt it belongs to', async () => {
    const { handler, platform, file } = handlerFor('host-7');
    void requestEdit(handler, file, 't1');
    await waitFor(() => handler.pendingPrompts().length > 0);

    expect(platform.editor.diffs[0]?.request).toMatchObject({ purpose: 'proposal', panelId: 'host-7', approvalId: 't1' });
  });

  it('opens without taking focus from the chat', async () => {
    const { handler, platform, file } = handlerFor('host-1');
    void requestEdit(handler, file, 't1');
    await waitFor(() => handler.pendingPrompts().length > 0);

    expect(platform.editor.diffs[0]?.request.preserveFocus).toBe(true);
  });

  it.each([
    ['approve', true],
    ['reject', false],
  ])('closes when the user decides (%s)', async (_label, approved) => {
    const { handler, platform, file } = handlerFor('host-1');
    const decision = requestEdit(handler, file, 't1');
    await waitFor(() => handler.pendingPrompts().length > 0);

    await handler.resolveApproval('t1', approved);

    await expect(decision).resolves.toMatchObject({ behavior: approved ? 'allow' : 'deny' });
    expect(platform.editor.diffs[0]?.closeCalls).toBe(1);
  });

  it('closes when the tool call is aborted', async () => {
    const { handler, platform, file } = handlerFor('host-1');
    const controller = new AbortController();
    const decision = requestEdit(handler, file, 't1', controller.signal);
    await waitFor(() => handler.pendingPrompts().length > 0);

    controller.abort();
    await decision;

    expect(platform.editor.diffs[0]?.closeCalls).toBe(1);
  });

  it('closes when the panel is disposed', async () => {
    const { handler, platform, file } = handlerFor('host-1');
    void requestEdit(handler, file, 't1');
    await waitFor(() => handler.pendingPrompts().length > 0);

    await handler.dispose();

    expect(platform.editor.diffs[0]?.closeCalls).toBe(1);
  });
});

describe('proposal diff content and title', () => {
  it('shows replacement patterns in new_string literally, as Edit writes them', async () => {
    const { file } = tempFile('const escaped = s;\r\nconst pid = 0;\r\n', 'a.ts');
    const diff = await diffManager().prepareDiff('t1', 'Edit', file, {
      old_string: 'const escaped = s;\nconst pid = 0;',
      new_string: "const escaped = s.replace(/[.*]/g, '\\$&');\nconst pid = $$ + $` + $';",
    });
    expect(diff).toHaveProperty('proposedContent', "const escaped = s.replace(/[.*]/g, '\\$&');\r\nconst pid = $$ + $` + $';\r\n");
  });

  it.each([
    ['replace_all', '\uFEFFkeep\r\nfoo\rbar\nmid\r\nfoo\r\nbar\n', true],
    ['a single edit', '\uFEFFkeep\r\nfoo\rbar\nend\r\n', false],
  ])('shows the bytes Edit writes when old_string spans a lone CR, for %s', async (_label, before, replaceAll) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-approval-'));
    try {
      const file = path.join(dir, 'f.txt');
      fs.writeFileSync(file, before);
      const input = { old_string: 'foo\nbar', new_string: 'baz\nqux', ...(replaceAll ? { replace_all: true } : {}) };

      const diff = await diffManager().prepareDiff('t1', 'Edit', file, input);
      await createEditTool(pi, dir).execute('t1', { file_path: file, ...input }, undefined, undefined, { cwd: dir } as never);

      expect(diff).toHaveProperty('proposedContent', fs.readFileSync(file, 'utf8'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the diff title by text the host renders, with the file\'s name', async () => {
    const platform = createFakePlatform();
    await diffManager(platform).showDiffView('t1', '/tmp/a.ts', 'a', 'b');
    expect(platform.editor.diffs[0]?.request.title('a.ts')).toEqual({ message: '{0} (Current ↔ Proposed)', args: ['a.ts'] });
    expect(platform.editor.diffs[0]?.request.filePath).toBe('/tmp/a.ts');
  });
});

describe('the approval diff of a single Edit is pi\'s edit run on a copy', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function fileHolding(content: string): { dir: string; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-approval-'));
    dirs.push(dir);
    const file = path.join(dir, 'f.txt');
    fs.writeFileSync(file, content);
    return { dir, file };
  }

  /** What the Edit tool writes over a copy of `content`, with the line its result reports, or the message it refuses with. */
  async function editWrites(content: string, input: { old_string: string; new_string: string }): Promise<{ written: string; line: number | undefined } | { refused: string }> {
    const { dir, file } = fileHolding(content);
    return createEditTool(pi, dir).execute('t1', { file_path: file, ...input }, undefined, undefined, { cwd: dir } as never).then(
      (result) => ({ written: fs.readFileSync(file, 'utf8'), line: (result.details as { firstChangedLine?: number } | undefined)?.firstChangedLine }),
      (error: Error) => ({ refused: error.message }),
    );
  }

  async function approvalOf(content: string, input: { old_string: string; new_string: string }) {
    return diffManager().prepareDiff('t1', 'Edit', fileHolding(content).file, input);
  }

  it.each([
    ['a trailing space', 'alpha  \nbeta\n', { old_string: 'alpha\nbeta', new_string: 'gamma\nbeta' }],
    ['a curly quote', 'say \u201Chi\u201D\nnext\n', { old_string: 'say "hi"', new_string: 'say "bye"' }],
  ])('shows the change pi\'s whitespace and quote tolerant match makes, where the file has %s', async (_label, content, input) => {
    const written = await editWrites(content, input);
    expect(written).not.toHaveProperty('refused');

    const diff = await approvalOf(content, input);

    expect(diff).toMatchObject({ proposedContent: (written as { written: string }).written, editLineNumber: (written as { line: number }).line });
  });

  it('asks nothing for an old_string found twice, and tells the model what pi\'s edit refuses it with', async () => {
    const content = 'foo\nbar\nfoo\n';
    const input = { old_string: 'foo', new_string: 'baz' };
    const { dir, file } = fileHolding(content);
    const refused = await createEditTool(pi, dir).execute('t1', { file_path: file, ...input }, undefined, undefined, { cwd: dir } as never).then(() => undefined, (error: Error) => error.message);
    expect(refused).toBeDefined();
    const handler = new PermissionHandler(createFakePlatform(), () => pi, 'host-1');
    handler.setCwd(dir);
    handler.setPostMessage(() => undefined);

    const decision = await handler.canUseTool('Edit', { file_path: file, ...input }, { signal: new AbortController().signal, toolUseID: 't1', parentToolUseId: null });

    expect(handler.pendingPrompts()).toEqual([]);
    expect(decision).toMatchObject({ behavior: 'deny', message: refused });
  });

  it.each([
    ['CRLF', 'a\r\nb\r\nc\r\n', { old_string: 'b\nc', new_string: 'B\nC\nD' }],
    ['lone CR', 'a\rb\rc\r', { old_string: 'b\nc', new_string: 'B' }],
    ['a BOM', '\uFEFFa\nb\n', { old_string: 'a', new_string: 'A' }],
    ['a BOM and CRLF', '\uFEFFa\r\nb\r\n', { old_string: 'b', new_string: 'B\nB' }],
    ['mixed endings', 'keep\r\nfoo\rbar\nmid\r\nend\n', { old_string: 'foo\nbar\nmid', new_string: 'x\ny' }],
    ['mixed endings and a trailing space', 'keep  \r\nfoo\rbar \nend\r\n', { old_string: 'keep\nfoo\nbar', new_string: 'x' }],
  ])('shows the bytes pi\'s edit writes over a file with %s', async (_label, content, input) => {
    const written = await editWrites(content, input);
    expect(written).not.toHaveProperty('refused');

    const diff = await approvalOf(content, input);

    expect(diff).toMatchObject({ proposedContent: (written as { written: string }).written });
  });

  it('does not wait behind a write queued on the same file', async () => {
    const { file } = fileHolding('alpha\nbeta\n');
    let release!: () => void;
    const writeHeld = new Promise<void>((resolve) => (release = resolve));
    const held = pi.withFileMutationQueue(file, () => writeHeld);
    try {
      const previewed = diffManager().prepareDiff('t1', 'Edit', file, { old_string: 'alpha', new_string: 'omega' }).then(() => 'previewed');
      const waited = new Promise<string>((resolve) => setTimeout(() => resolve('waited behind the write'), 1000));

      expect(await Promise.race([previewed, waited])).toBe('previewed');
    } finally {
      release();
      await held;
    }
  });
});

describe('the approval a file change raises', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The requestPermission a call raises, in a chat whose folder holds the file `setUp` made. */
  async function approvalOf(
    toolName: 'Edit' | 'Write',
    input: (file: string) => Record<string, unknown>,
    setUp: (file: string) => void,
  ): Promise<{ request: ExtensionToWebviewMessage | undefined; platform: FakePlatform }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-approval-'));
    dirs.push(dir);
    const file = path.join(dir, 'f.txt');
    setUp(file);
    const platform = createFakePlatform();
    const handler = new PermissionHandler(platform, getPiCodingAgent, 'host-1');
    handler.setCwd(dir);
    const messages: ExtensionToWebviewMessage[] = [];
    handler.setPostMessage((msg) => messages.push(msg));
    void handler.canUseTool(toolName, input(file), { signal: new AbortController().signal, toolUseID: 't1', parentToolUseId: null });
    await waitFor(() => handler.pendingPrompts().length > 0);
    return { request: messages.find((m) => m.type === 'requestPermission'), platform };
  }

  it('shows every replacement of a replace_all Edit, as Edit applies it', async () => {
    const before = ['x', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'x', ''].join('\n');
    const { request } = await approvalOf(
      'Edit',
      (file) => ({ file_path: file, old_string: 'x', new_string: 'y', replace_all: true }),
      (file) => fs.writeFileSync(file, before),
    );

    const patch = (request as { patch?: string }).patch ?? '';
    expect(patch.match(/\n-x\n\+y\n/g)).toHaveLength(2);
    expect(patch).toContain('@@ -7,5 +7,5 @@');
  });

  it.each([
    ['binary', (file: string) => fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x00, 0x01]))],
    ['tooLarge', (file: string) => fs.writeFileSync(file, Buffer.alloc(FILE_PATCH_MAX_BYTES + 1, 'x'))],
  ])('says why a Write over a file it cannot diff has no diff (%s), never that it creates the file', async (reason, setUp) => {
    const { request, platform } = await approvalOf('Write', (file) => ({ file_path: file, content: 'text\n' }), setUp);

    expect(request).toMatchObject({ toolName: 'Write', patchOmitted: reason });
    expect(request).not.toHaveProperty('patch');
    expect(platform.editor.diffs).toEqual([]);
  });

  it.each([
    ['binary', (file: string) => fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x00, 0x01]))],
    ['tooLarge', (file: string) => fs.writeFileSync(file, Buffer.alloc(FILE_PATCH_MAX_BYTES + 1, 'x'))],
  ])('asks for an Edit of a file it cannot diff (%s) with a card that says why, and opens no diff', async (reason, setUp) => {
    const { request, platform } = await approvalOf('Edit', (file) => ({ file_path: file, old_string: 'x', new_string: 'y' }), setUp);

    expect(request).toMatchObject({ toolName: 'Edit', patchOmitted: reason });
    expect(request).not.toHaveProperty('patch');
    expect(platform.editor.diffs).toEqual([]);
  });

  it('treats a Write as creating its file only when the file does not exist', async () => {
    const { request, platform } = await approvalOf('Write', (file) => ({ file_path: file, content: 'text\n' }), () => undefined);

    expect(request).not.toHaveProperty('patch');
    expect(request).not.toHaveProperty('patchOmitted');
    expect(platform.editor.diffs).toHaveLength(1);
  });

  it('gives a Write over an existing empty file a patch, since it does not create the file', async () => {
    const { request } = await approvalOf('Write', (file) => ({ file_path: file, content: 'text\n' }), (file) => fs.writeFileSync(file, ''));

    expect(request).toMatchObject({ patch: expect.stringContaining('@@ -0,0 +1,1 @@\n+text') });
  });
});

describe('the approval diff is the file pi edits, read as pi reads it, at the path pi resolves', () => {
  type Request = Extract<ExtensionToWebviewMessage, { type: 'requestPermission' }>;

  /** A call in a chat whose folder is `dir`: its decision, and the prompt it raises once it asks. */
  function call(dir: string, toolName: 'Edit' | 'Write', input: Record<string, unknown>, platform: FakePlatform = createFakePlatform()) {
    const handler = new PermissionHandler(platform, getPiCodingAgent, 'host-1');
    handler.setCwd(dir);
    const messages: ExtensionToWebviewMessage[] = [];
    handler.setPostMessage((msg) => messages.push(msg));
    const decision = handler.canUseTool(toolName, input, { signal: new AbortController().signal, toolUseID: 't1', parentToolUseId: null });
    const asked = async (): Promise<Request> => {
      await waitFor(() => handler.pendingPrompts().length > 0);
      return messages.find((m): m is Request => m.type === 'requestPermission')!;
    };
    return { decision, asked, handler, platform };
  }

  /** The text of each side of the diff view the approval opened. */
  function sides(platform: FakePlatform): { filePath: string | undefined; original: string | undefined; proposed: string | undefined } {
    const request = platform.editor.diffs[0]?.request;
    const text = (side: DiffSide | undefined): string | undefined => (side && 'content' in side ? side.content : undefined);
    return { filePath: request?.filePath, original: text(request?.left), proposed: text(request?.right) };
  }

  /** What the Edit tool leaves in `file`, run on it as the approved call runs. */
  async function editToolWrites(dir: string, file: string, input: { old_string: string; new_string: string }): Promise<string> {
    await createEditTool(pi, dir).execute('t1', { file_path: file, ...input }, undefined, undefined, { cwd: dir } as never);
    return fs.readFileSync(file, 'utf8');
  }

  it.each([
    ['a relative path', () => 'package.json'],
    ['an @ path', () => '@package.json'],
    ['a file: URL', (file: string) => pathToFileURL(file).href],
  ])('shows the chat folder\'s file for %s, never a same-named file in the process folder', async (_label, spelled) => {
    expect(fs.existsSync(path.join(process.cwd(), 'package.json'))).toBe(true);
    const { dir, file } = tempFile('alpha\nbeta\n', 'package.json');

    const { asked, platform } = call(dir, 'Edit', { file_path: spelled(file), old_string: 'alpha', new_string: 'omega' });
    const request = await asked();

    expect(request.filePath).toBe(spelled(file));
    expect(request.patch).toContain('\n-alpha\n+omega\n');
    expect(sides(platform)).toEqual({ filePath: file, original: 'alpha\nbeta\n', proposed: 'omega\nbeta\n' });
  });

  it('shows a relative Write over an existing file as its diff', async () => {
    const { dir } = tempFile('alpha\nbeta\n', 'package.json');

    const request = await call(dir, 'Write', { file_path: 'package.json', content: 'gamma\n' }).asked();

    expect(request.patch).toContain('\n-alpha\n-beta\n+gamma\n');
  });

  it.each([
    ['a single Edit', {}, false],
    ['a replace_all Edit', { replace_all: true }, false],
    ['a single Edit at a relative path', {}, true],
    ['a replace_all Edit at a relative path', { replace_all: true }, true],
  ])('refuses %s of a missing file with the message the Edit tool gives, asking nothing', async (_label, extra, relative) => {
    const { dir, file } = tempFile(null);
    const input = { file_path: relative ? path.basename(file) : file, old_string: 'alpha', new_string: 'omega', ...extra };
    const toolRefusal = await createEditTool(pi, dir).execute('t1', input, undefined, undefined, { cwd: dir } as never).then(() => undefined, (error: Error) => error.message);
    expect(toolRefusal).toContain('ENOENT');

    const { decision, handler, platform } = call(dir, 'Edit', input);

    expect(await decision).toMatchObject({ behavior: 'deny', message: toolRefusal });
    expect(handler.pendingPrompts()).toEqual([]);
    expect(platform.editor.diffs).toEqual([]);
  });

  it.each([
    ['a BOM', '\uFEFFalpha\nbeta\n'],
    ['CRLF', 'alpha\r\nbeta\r\n'],
    ['a BOM and CRLF', '\uFEFFalpha\r\nbeta\r\n'],
  ])('shows a file with %s as pi reads it, against the bytes the Edit tool writes', async (_label, content) => {
    const { dir, file } = tempFile(content);
    const input = { old_string: 'alpha', new_string: 'omega' };

    const { asked, platform } = call(dir, 'Edit', { file_path: file, ...input });
    await asked();
    const shown = sides(platform);

    expect(shown.original).toBe(content);
    expect(shown.proposed).toBe(await editToolWrites(dir, file, input));
  });

  it('shows the file on disk where the editor holds unsaved changes, notes them on the card, and shows the bytes the Edit tool writes', async () => {
    const { dir, file } = tempFile('alpha\nbeta\n');
    const platform = createFakePlatform();
    platform.editor.dirtyPaths.add(file);
    const input = { old_string: 'alpha', new_string: 'omega' };

    const request = await call(dir, 'Edit', { file_path: file, ...input }, platform).asked();
    const shown = sides(platform);

    expect(request.unsavedChanges).toBe(true);
    expect(shown.original).toBe('alpha\nbeta\n');
    expect(shown.proposed).toBe(await editToolWrites(dir, file, input));
  });

  it.each([
    ['an Edit', { old_string: 'alpha', new_string: 'omega' }],
    ['a Write', { content: 'gamma\n' }],
  ])('notes no unsaved changes on %s of a file no editor holds changed', async (_label, input) => {
    const { dir, file } = tempFile('alpha\nbeta\n');
    const toolName = 'content' in input ? 'Write' : 'Edit';

    const request = await call(dir, toolName, { file_path: file, ...input }).asked();

    expect(request).not.toHaveProperty('unsavedChanges');
  });

  it('names the file in the approval patch as the model wrote it, as the result\'s patch does', async () => {
    const { dir, file } = tempFile('alpha\nbeta\n');
    const input = { file_path: path.basename(file), old_string: 'alpha', new_string: 'omega' };

    const request = await call(dir, 'Edit', input).asked();
    const result = await createEditTool(pi, dir).execute('t1', input, undefined, undefined, { cwd: dir } as never);

    expect(request.patch).toBe((result.details as { patch?: string }).patch);
  });
});

describe('what an Edit approval refuses unasked, in the Edit tool\'s own words', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    deniedAccess.clear();
    fifos.clear();
  });

  /** A call in a chat whose folder is `dir`: its decision, and the prompt it raises once it asks. */
  function call(dir: string, toolName: 'Edit' | 'Write', input: Record<string, unknown>) {
    const platform = createFakePlatform();
    const handler = new PermissionHandler(platform, getPiCodingAgent, 'host-1');
    handler.setCwd(dir);
    const messages: ExtensionToWebviewMessage[] = [];
    handler.setPostMessage((msg) => messages.push(msg));
    const decision = handler.canUseTool(toolName, input, { signal: new AbortController().signal, toolUseID: 't1', parentToolUseId: null });
    const asked = async (): Promise<ExtensionToWebviewMessage | undefined> => {
      await waitFor(() => handler.pendingPrompts().length > 0);
      return messages.find((m) => m.type === 'requestPermission');
    };
    return { decision, asked, handler, platform };
  }

  /** The message the Edit tool itself refuses `input` with, run on the file as the approved call would run. */
  async function toolRefusal(dir: string, input: Record<string, unknown>): Promise<string | undefined> {
    return createEditTool(pi, dir).execute('t1', input as never, undefined, undefined, { cwd: dir } as never).then(() => undefined, (error: Error) => error.message);
  }

  /** stat answers for `file` as for a FIFO, as when a FIFO stands at the path. */
  function statAsFifo(file: string): void {
    fifos.add(file);
    const stat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => {
      const stats = await stat(target, options);
      return String(target) === file ? Object.assign(stats, { isFile: () => false, isFIFO: () => true, isDirectory: () => false }) : stats;
    }) as typeof fs.promises.stat);
  }

  /** Every open of `file`, as the diff's read would open it. */
  function opensOf(file: string): () => unknown[] {
    const open = vi.spyOn(fs.promises, 'open');
    return () => open.mock.calls.filter(([target]) => String(target) === file);
  }

  it.each([
    ['a single Edit', {}, undefined],
    ['a replace_all Edit', { replace_all: true }, undefined],
    ['an Edit it also may not read and write', {}, 'EACCES'],
  ])('refuses %s of a path that is not a regular file unasked, with the tool\'s message, opening nothing', async (_label, extra, denied) => {
    const { dir, file } = tempFile('never read');
    statAsFifo(file);
    if (denied !== undefined) deniedAccess.set(file, denied);
    const opens = opensOf(file);

    const input = { file_path: path.basename(file), old_string: 'never', new_string: 'x', ...extra };
    const refused = await toolRefusal(dir, input);
    expect(refused).toBe(`Could not edit file: ${path.basename(file)}. It is not a regular file.`);

    const { decision, handler, platform } = call(dir, 'Edit', input);

    expect(await decision).toMatchObject({ behavior: 'deny', message: refused });
    expect(handler.pendingPrompts()).toEqual([]);
    expect(opens()).toEqual([]);
    expect(platform.editor.diffs).toEqual([]);
  });

  it('refuses a Write over a path that is not a regular file unasked, with the tool\'s message, opening nothing', async () => {
    const { dir, file } = tempFile('never read');
    statAsFifo(file);
    const opens = opensOf(file);
    const refused = await createWriteTool(pi, dir).execute('t1', { path: path.basename(file), content: 'x\n' } as never, undefined, undefined, { cwd: dir } as never).then(() => undefined, (error: Error) => error.message);
    expect(refused).toBe(`Could not write file: ${path.basename(file)}. It is not a regular file.`);

    const { decision, handler, platform } = call(dir, 'Write', { file_path: path.basename(file), content: 'x\n' });

    expect(await decision).toMatchObject({ behavior: 'deny', message: refused });
    expect(handler.pendingPrompts()).toEqual([]);
    expect(opens()).toEqual([]);
    expect(platform.editor.diffs).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe('never read');
  });

  it.each([
    ['a Write', 'Write', { content: 'x\n' }],
    ['an Edit', 'Edit', { old_string: 'alpha', new_string: 'omega' }],
  ] as const)('asks for %s of a file it cannot read with a card that says so, never that it is binary', async (_label, toolName, input) => {
    const { dir, file } = tempFile('alpha\n');
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (target: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
      if (String(target) === file) throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${file}'`), { code: 'EBUSY' });
      return open(target, flags, mode);
    }) as typeof fs.promises.open);

    const request = await call(dir, toolName, { file_path: file, ...input }).asked();

    expect(request).toMatchObject({ toolName, patchOmitted: 'unreadable' });
  });

  it.each([
    ['a single Edit', 'EACCES', {}, 'alpha\n'],
    ['a replace_all Edit', 'EPERM', { replace_all: true }, 'alpha\n'],
    ['an Edit with no diff (binary)', 'EACCES', {}, '\0alpha\n'],
  ])('refuses %s of a file it may not read and write (%s) unasked, with the tool\'s message', async (_label, code, extra, content) => {
    const { dir, file } = tempFile(content);
    deniedAccess.set(file, code);
    const input = { file_path: path.basename(file), old_string: 'alpha', new_string: 'omega', ...extra };
    const refused = await toolRefusal(dir, input);
    expect(refused).toBe(`Could not edit file: ${path.basename(file)}. Error code: ${code}.`);

    const { decision, handler } = call(dir, 'Edit', input);

    expect(await decision).toMatchObject({ behavior: 'deny', message: refused });
    expect(handler.pendingPrompts()).toEqual([]);
  });

  it.each([
    ['old_string is absent', 'alpha\nbeta\n', { old_string: 'gamma', new_string: 'x', replace_all: true }],
    ['the file is empty', '', { old_string: 'gamma', new_string: 'x', replace_all: true }],
    ['the replacement changes nothing', 'alpha\nbeta\n', { old_string: 'alpha', new_string: 'alpha', replace_all: true }],
    ['old_string is empty, for replace_all', 'alpha\n', { old_string: '', new_string: 'x', replace_all: true }],
    ['old_string is empty, for a single edit', 'alpha\n', { old_string: '', new_string: 'x' }],
  ])('refuses an Edit where %s unasked, with the tool\'s message', async (_label, content, edit) => {
    const { dir, file } = tempFile(content);
    const input = { file_path: path.basename(file), ...edit };
    const refused = await toolRefusal(dir, input);
    expect(refused).toBeDefined();

    const { decision, handler, platform } = call(dir, 'Edit', input);

    expect(await decision).toMatchObject({ behavior: 'deny', message: refused });
    expect(handler.pendingPrompts()).toEqual([]);
    expect(platform.editor.diffs).toEqual([]);
  });
});

describe.runIf(process.platform !== 'win32')('an approval of a FIFO (POSIX)', () => {
  it('refuses an Edit and a Write of a FIFO unasked, never opening it', async () => {
    const { dir, file } = tempFile(null, 'pipe');
    execFileSync('mkfifo', [file]);
    const open = vi.spyOn(fs.promises, 'open');
    const handler = new PermissionHandler(createFakePlatform(), getPiCodingAgent, 'host-1');
    handler.setCwd(dir);
    const messages: ExtensionToWebviewMessage[] = [];
    handler.setPostMessage((msg) => messages.push(msg));
    const context = (toolUseID: string): CanUseToolContext => ({ signal: new AbortController().signal, toolUseID, parentToolUseId: null });

    expect(await handler.canUseTool('Edit', { file_path: 'pipe', old_string: 'a', new_string: 'b' }, context('e1'))).toMatchObject({ behavior: 'deny', message: 'Could not edit file: pipe. It is not a regular file.' });
    expect(await handler.canUseTool('Write', { file_path: 'pipe', content: 'x\n' }, context('w1'))).toMatchObject({ behavior: 'deny', message: 'Could not write file: pipe. It is not a regular file.' });

    expect(messages.filter((m) => m.type === 'requestPermission')).toEqual([]);
    expect(open.mock.calls.filter(([target]) => String(target) === file)).toEqual([]);
    open.mockRestore();
  });
});
