import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AssistantImages } from '@earendil-works/pi-ai';
import { AutoCheckpointProducer } from '../auto-checkpoint';
import { readSkippedManifest } from '../folder-repo';
import { folderIdFor, getFolderRepoDir } from '../resolver';
import type { CheckpointEntryV3 } from '../types';
import type { PiCodingAgentModule } from '../../pi-loader';
import { createGenerateImageTool, type ImageRuntime } from '../../tools/image-tools';

/**
 * GenerateImage needs no checkpoint code of its own: it is a write tool, so the gate holds it for the
 * turn's baseline, and the generic machinery treats its output like any file the turn created.
 */

const MB = 1024 * 1024;
const CAP = MB;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MODEL = { id: 'google/gemini-image', name: 'Gemini Image', provider: 'openrouter', api: 'openrouter-images', type: 'image', output: ['image'], cost: { input: 0.3, output: 30, cacheRead: 0, cacheWrite: 0 } };

let root: string;
let cwd: string;

function png(bytes: number): string {
  const data = Buffer.alloc(bytes, 3);
  PNG_SIGNATURE.copy(data);
  return data.toString('base64');
}

/** The real tool over a fake runtime that answers with one PNG of the given base64. */
async function generate(file_path: string, data: string): Promise<void> {
  const runtime: ImageRuntime = {
    getModelOfType: () => MODEL as never,
    getModelsOfType: () => [MODEL as never],
    hasConfiguredAuth: () => true,
    generateImages: async (): Promise<AssistantImages> => ({
      api: 'openrouter-images', provider: 'openrouter', model: MODEL.id, stopReason: 'stop', timestamp: 0,
      output: [{ type: 'image', mimeType: 'image/png', data }],
    }),
  };
  const pi = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;
  const tool = createGenerateImageTool({ pi, cwd, getRuntime: () => runtime, getModelId: () => MODEL.id });
  const result = (await tool.execute('tc', { prompt: 'a fox', file_path }, undefined, undefined, undefined as never)) as { isError?: boolean };
  expect(result.isError, file_path).toBeUndefined();
}

function producer(): AutoCheckpointProducer {
  const sessionFile = path.join(root, 'sessions', 'session-a.jsonl');
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, '');
  let turn = 0;
  return new AutoCheckpointProducer({
    sessionId: 'session-a',
    sessionFile,
    cwd,
    maxFileSizeBytes: () => CAP,
    createTurnId: () => `turn-${++turn}`,
    now: () => new Date(),
  });
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cp-image-'));
  cwd = path.join(root, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'v1\n');
});

afterEach(async () => {
  await fs.promises.rm(getFolderRepoDir(folderIdFor(cwd)), { recursive: true, force: true });
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('a rewind over a turn that generated images (real git)', { timeout: 60_000 }, () => {
  it('removes the generated image, and leaves one over the size cap in place, reported as skipped like any oversized file', async () => {
    const p = producer();
    const started = await p.turnStart({ userEntryId: 'u1', prompt: 'make art' });
    if (!started.ok) throw new Error(started.message);
    await generate('art/small.png', png(4096));
    await generate('art/huge.png', png(2 * MB));
    const finalized = await p.finalizeRun();
    if (!finalized.ok || finalized.record?.kind !== 'checkpoint' || finalized.record.v !== 3) throw new Error('expected a v3 checkpoint');
    const entry: CheckpointEntryV3 = finalized.record;

    const result = await p.restore(entry);
    if (!result.ok) throw new Error(`restore failed: ${JSON.stringify(result)}`);

    expect(fs.existsSync(path.join(cwd, 'art', 'small.png'))).toBe(false);
    expect(fs.statSync(path.join(cwd, 'art', 'huge.png')).size).toBe(2 * MB);
    expect(result.preRewind.skipped.byReason.size).toEqual({ count: 1, bytes: 2 * MB });
    expect(await readSkippedManifest(result.preRewind, cwd)).toEqual({ ok: true, value: [{ path: 'art/huge.png', bytes: 2 * MB, reason: 'size' }] });
  });
});
