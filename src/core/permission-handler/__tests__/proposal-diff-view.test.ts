import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PermissionHandler } from '../index';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import type { CanUseToolContext } from '../types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { DiffManager } from '../diff-manager';
import { FILE_PATCH_MAX_BYTES } from '../../pi-session/tools/file-patch';
import { createEditTool } from '../../pi-session/tools/edit-tool';
import { getPiCodingAgent, initPiLoader, type PiCodingAgentModule } from '../../pi-session/pi-loader';

let pi: PiCodingAgentModule;

beforeAll(async () => {
  pi = (await initPiLoader())!;
});

function diffManager(platform: FakePlatform = createFakePlatform()): DiffManager {
  return new DiffManager(platform.editor, 'host-1', () => pi);
}

function handlerFor(panelId: string): { handler: PermissionHandler; platform: FakePlatform } {
  const platform = createFakePlatform();
  vi.spyOn(platform.editor, 'readText').mockResolvedValue('alpha\nbeta\n');
  const handler = new PermissionHandler(platform, getPiCodingAgent, panelId);
  handler.setCwd(process.cwd());
  handler.setPostMessage(() => undefined);
  return { handler, platform };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never held');
}

function requestEdit(handler: PermissionHandler, toolUseID: string, signal = new AbortController().signal): Promise<unknown> {
  const ctx: CanUseToolContext = { signal, toolUseID, parentToolUseId: null };
  return handler.canUseTool('Edit', { file_path: '/tmp/a.txt', old_string: 'alpha', new_string: 'omega' }, ctx);
}

describe('proposal diff view', () => {
  it('names the owning panel and the permission prompt it belongs to', async () => {
    const { handler, platform } = handlerFor('host-7');
    void requestEdit(handler, 't1');
    await waitFor(() => handler.pendingPrompts().length > 0);

    expect(platform.editor.diffs[0]?.request).toMatchObject({ purpose: 'proposal', panelId: 'host-7', approvalId: 't1' });
  });

  it('opens without taking focus from the chat', async () => {
    const { handler, platform } = handlerFor('host-1');
    void requestEdit(handler, 't1');
    await waitFor(() => handler.pendingPrompts().length > 0);

    expect(platform.editor.diffs[0]?.request.preserveFocus).toBe(true);
  });

  it.each([
    ['approve', true],
    ['reject', false],
  ])('closes when the user decides (%s)', async (_label, approved) => {
    const { handler, platform } = handlerFor('host-1');
    const decision = requestEdit(handler, 't1');
    await waitFor(() => handler.pendingPrompts().length > 0);

    await handler.resolveApproval('t1', approved);

    await expect(decision).resolves.toMatchObject({ behavior: approved ? 'allow' : 'deny' });
    expect(platform.editor.diffs[0]?.closeCalls).toBe(1);
  });

  it('closes when the tool call is aborted', async () => {
    const { handler, platform } = handlerFor('host-1');
    const controller = new AbortController();
    const decision = requestEdit(handler, 't1', controller.signal);
    await waitFor(() => handler.pendingPrompts().length > 0);

    controller.abort();
    await decision;

    expect(platform.editor.diffs[0]?.closeCalls).toBe(1);
  });

  it('closes when the panel is disposed', async () => {
    const { handler, platform } = handlerFor('host-1');
    void requestEdit(handler, 't1');
    await waitFor(() => handler.pendingPrompts().length > 0);

    await handler.dispose();

    expect(platform.editor.diffs[0]?.closeCalls).toBe(1);
  });
});

describe('proposal diff content and title', () => {
  it('shows replacement patterns in new_string literally, as Edit writes them', async () => {
    const platform = createFakePlatform();
    vi.spyOn(platform.editor, 'readText').mockResolvedValue('const escaped = s;\r\nconst pid = 0;\r\n');
    const diff = await diffManager(platform).prepareDiff('t1', 'Edit', '/tmp/a.ts', {
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

  /** The requestPermission a call raises, with `readText` rejecting as a host does for a file it will not open as text. */
  async function approvalOf(
    toolName: 'Edit' | 'Write',
    input: (file: string) => Record<string, unknown>,
    setUp: (file: string) => void,
    readText?: (file: string) => Promise<string>,
  ): Promise<{ request: ExtensionToWebviewMessage | undefined; platform: FakePlatform }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-approval-'));
    dirs.push(dir);
    const file = path.join(dir, 'f.txt');
    setUp(file);
    const platform = createFakePlatform();
    if (readText) vi.spyOn(platform.editor, 'readText').mockImplementation(readText);
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
    ['binary', (file: string) => fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x00, 0x01])), 'f.txt is a binary file'],
    ['tooLarge', (file: string) => fs.writeFileSync(file, Buffer.alloc(FILE_PATCH_MAX_BYTES + 1, 'x')), 'f.txt is over the size limit'],
  ])('says why a Write over a file the host will not open as text has no diff (%s), never that it creates the file', async (reason, setUp, message) => {
    const { request, platform } = await approvalOf('Write', (file) => ({ file_path: file, content: 'text\n' }), setUp, () => Promise.reject(new Error(message)));

    expect(request).toMatchObject({ toolName: 'Write', patchOmitted: reason });
    expect(request).not.toHaveProperty('patch');
    expect(platform.editor.diffs).toEqual([]);
  });

  it('treats a Write as creating its file only when the file does not exist, whatever the host\'s error says', async () => {
    const { request, platform } = await approvalOf('Write', (file) => ({ file_path: file, content: 'text\n' }), () => undefined, (file) => Promise.reject(new Error(`cannot open file://${file}`)));

    expect(request).not.toHaveProperty('patch');
    expect(request).not.toHaveProperty('patchOmitted');
    expect(platform.editor.diffs).toHaveLength(1);
  });

  it('gives a Write over an existing empty file a patch, since it does not create the file', async () => {
    const { request } = await approvalOf('Write', (file) => ({ file_path: file, content: 'text\n' }), (file) => fs.writeFileSync(file, ''));

    expect(request).toMatchObject({ patch: expect.stringContaining('@@ -0,0 +1,1 @@\n+text') });
  });
});
