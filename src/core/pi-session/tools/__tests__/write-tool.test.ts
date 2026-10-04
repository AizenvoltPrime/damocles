import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '@earendil-works/pi-agent-core';
import { AgentSession, SessionManager, createExtensionRuntime, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { initPiLoader, type PiCodingAgentModule } from '../../pi-loader';
import { createWriteTool } from '../write-tool';
import { FILE_PATCH_MAX_BYTES, FILE_PATCH_MAX_CHANGED_LINES, filePatch } from '../file-patch';
import type { WriteDetails } from '../../../../shared/types/file-patch';

/** The one path the override's diff read is refused on, as a write-only file refuses it. */
const unreadable = vi.hoisted(() => ({ path: null as string | null }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readFile: (async (file: string, ...rest: never[]) => {
      if (file === unreadable.path) throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES' });
      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof actual.readFile,
  };
});

let pi: PiCodingAgentModule;
const dirs: string[] = [];

beforeAll(async () => {
  pi = (await initPiLoader())!;
});

afterEach(() => {
  unreadable.path = null;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-write-'));
  dirs.push(dir);
  return dir;
}

const lines = (n: number, label = 'line'): string => Array.from({ length: n }, (_, i) => `${label} ${i + 1}`).join('\n') + '\n';

type Result = { content: Array<{ type: string; text?: string }>; details: WriteDetails | undefined };

function run(tool: ToolDefinition, cwd: string, params: { path: string; content: string }, toolCallId = 'tc'): Promise<Result> {
  return tool.execute(toolCallId, params as never, undefined, undefined, { cwd } as never) as Promise<Result>;
}

describe('the write override', () => {
  it('records the patch of a write that replaces a file, numbered as the file is', async () => {
    const cwd = tempDir();
    const before = lines(200);
    fs.writeFileSync(path.join(cwd, 'big.txt'), before);
    const after = before.replace('line 120\n', 'changed 120\n');

    const result = await run(createWriteTool(pi, cwd), cwd, { path: 'big.txt', content: after });

    const patch = (result.details as { patch: string }).patch;
    expect(patch).toContain('@@ -116,9 +116,9 @@');
    expect(patch).toContain('\n-line 120\n+changed 120\n');
    expect(fs.readFileSync(path.join(cwd, 'big.txt'), 'utf-8')).toBe(after);
  });

  it('records only that it created a new file, whose lines the tool input already holds', async () => {
    const cwd = tempDir();
    const result = await run(createWriteTool(pi, cwd), cwd, { path: 'new.txt', content: 'a\nb\n' });

    expect(result.details).toEqual({ created: true });
    expect(fs.readFileSync(path.join(cwd, 'new.txt'), 'utf-8')).toBe('a\nb\n');
  });

  it.each([
    ['a new file in folders that do not exist yet', null, 'deep/er/f.txt', 'x\r\ny\n'],
    ['an overwrite of a file with a BOM and CRLF line ends', '\uFEFFa\r\nb\r\n', 'f.txt', 'a\nB\n'],
  ])('leaves exactly what pi\'s own write leaves, for %s', async (_label, existing, file, content) => {
    const ours = tempDir();
    const theirs = tempDir();
    if (existing !== null) {
      fs.writeFileSync(path.join(ours, file), existing);
      fs.writeFileSync(path.join(theirs, file), existing);
    }

    const mine = await run(createWriteTool(pi, ours), ours, { path: file, content });
    const pis = await run(pi.createWriteToolDefinition(theirs) as unknown as ToolDefinition, theirs, { path: file, content });

    expect(fs.readFileSync(path.join(ours, file))).toEqual(fs.readFileSync(path.join(theirs, file)));
    expect(mine.content).toEqual(pis.content);
  });

  it('says why when the replaced file is binary, and still writes', async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));

    const result = await run(createWriteTool(pi, cwd), cwd, { path: 'blob.bin', content: 'text now\n' });

    expect(result.details).toEqual({ patchOmitted: 'binary' });
    expect(fs.readFileSync(path.join(cwd, 'blob.bin'), 'utf-8')).toBe('text now\n');
  });

  it('says the diff is too large when the replaced file is over the bound, and never reads it', async () => {
    const cwd = tempDir();
    const huge = path.join(cwd, 'huge.txt');
    fs.writeFileSync(huge, 'x'.repeat(FILE_PATCH_MAX_BYTES + 1));

    const result = await run(createWriteTool(pi, cwd), cwd, { path: 'huge.txt', content: 'small\n' });

    expect(result.details).toEqual({ patchOmitted: 'tooLarge' });
    expect(fs.readFileSync(huge, 'utf-8')).toBe('small\n');
  });

  it('says the diff is too large past the changed-line bound', async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'f.txt'), lines(FILE_PATCH_MAX_CHANGED_LINES, 'old'));

    const result = await run(createWriteTool(pi, cwd), cwd, { path: 'f.txt', content: lines(FILE_PATCH_MAX_CHANGED_LINES, 'new') });

    expect(result.details).toEqual({ patchOmitted: 'tooLarge' });
  });

  it('still writes when the old content cannot be read for the diff, and records no details', async () => {
    const cwd = tempDir();
    const file = path.join(cwd, 'f.txt');
    fs.writeFileSync(file, 'old\n');
    unreadable.path = file;

    const result = await run(createWriteTool(pi, cwd), cwd, { path: 'f.txt', content: 'new\n' });

    expect(result.details).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: 'Successfully wrote to f.txt' }]);
    expect(fs.readFileSync(file, 'utf-8')).toBe('new\n');
  });

  it('reads the old content in the write\'s own queue slot, after an edit queued before it', async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'f.txt'), 'a\nb\nc\n');
    const edit = pi.createEditToolDefinition(cwd);

    const edited = edit.execute('tc-edit', { path: 'f.txt', edits: [{ oldText: 'b', newText: 'B' }] }, undefined, undefined, { cwd } as never);
    const written = run(createWriteTool(pi, cwd), cwd, { path: 'f.txt', content: 'a\nB\nC\n' });
    await edited;
    const patch = ((await written).details as { patch: string }).patch;

    expect(patch).not.toContain('-b');
    expect(patch).toContain('-c\n+C');
  });

  it('replaces pi\'s write in a real pi session by name, with no excludeTools entry', async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'f.txt'), 'one\n');
    const ours = createWriteTool(pi, cwd);
    const session = new AgentSession({
      agent: new Agent({ streamFn: (async () => { throw new Error('no network in tests'); }) as never }),
      sessionManager: SessionManager.inMemory(),
      settingsManager: {
        getImageAutoResize: () => false,
        getShellCommandPrefix: () => undefined,
        getShellPath: () => undefined,
        getCompactionSettings: () => ({ enabled: false, reserveTokens: 1, keepRecentTokens: 1 }),
        getSteeringMode: () => 'all',
        getFollowUpMode: () => 'one-at-a-time',
        setCompactionEnabled: () => {},
        setCacheWarmingMode: () => {},
      } as never,
      cwd,
      resourceLoader: {
        getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
        getSystemPrompt: () => 'sys',
        getAppendSystemPrompt: () => [],
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
      } as never,
      modelRuntime: { getAvailableSnapshot: () => [] } as never,
      customTools: [ours],
      allowedToolNames: ['read', 'write'],
      initialActiveToolNames: ['read', 'write'],
    } as never);

    expect(session.getToolDefinition('write')).toBe(ours);
    expect(session.getActiveToolNames()).toContain('write');
  });
});

describe('filePatch', () => {
  it('is pi\'s generateUnifiedPatch, so an approval and a result render the same hunks', () => {
    const before = lines(60);
    const after = before.replace('line 3\n', 'line three\n').replace('line 50\n', '');

    expect(filePatch('src/a.ts', before, after)).toEqual({ patch: pi.generateUnifiedPatch('src/a.ts', before, after) });
  });

  it('numbers lines as pi\'s edit does, with the BOM split off and CRLF read as LF', () => {
    const patch = (filePatch('f', '\uFEFFa\r\nb\r\nc\r\n', 'a\nB\nc\n') as { patch: string }).patch;

    expect(patch).toContain('@@ -1,3 +1,3 @@');
    expect(patch).not.toContain('\r');
    expect(patch).not.toContain('\uFEFF');
  });
});
