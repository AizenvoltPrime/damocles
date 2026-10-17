import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { tmpHome } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { tmpHome: nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dam-cross-folder-'))) };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome };
});

import type { Disposable } from '../../../../platform/disposable';
import { deletePiSession } from '../mutations';
import { piSessionDirOf, resolvePiSessionFile } from '../reading';
import { piSessionDir } from '../session-dir';
import { loadToolResultImages } from '../tool-result-images';
import { subagentsDir, teamEventLogPath, teamsDir } from '../../agent-records';
import { TeamPersistence } from '../../../team/persistence';
import { installWorktreeProjectLookup } from '../../../worktrees/personal-config';
import { folderKey } from '../../../workspace-folders/folder-key';

const project = path.join(tmpHome, 'project');
const worktree = path.join(tmpHome, 'worktrees', 'project-abc', 'aaaaaaaa');
const elsewhere = path.join(tmpHome, 'elsewhere');

let lookup: Disposable;
let counter = 0;

beforeEach(() => {
  lookup = installWorktreeProjectLookup({
    projectOf: (folder) => (folderKey(folder) === folderKey(worktree) ? project : undefined),
    recordsOfProject: (p) => (folderKey(p) === folderKey(project) ? [{ workingFolder: worktree }] : []),
    get: () => undefined,
    chatRecordFor: () => undefined,
  });
});

afterEach(() => {
  lookup.dispose();
  fs.rmSync(path.join(tmpHome, '.damocles'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** A stored session created in `folder`'s session directory, as a chat that started there and then moved leaves it. */
function sessionCreatedIn(folder: string, entries: unknown[] = []): { id: string; file: string; dir: string } {
  const id = `0000000${++counter}-aaaa-4bbb-8ccc-dddddddddddd`;
  const dir = piSessionDir(folder);
  const file = path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  const header = { type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd: folder };
  const prompt = { type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, [header, prompt, ...entries].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { id, file, dir };
}

function write(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
}

describe('finding a session across the folders of a project with worktree chats', () => {
  it('finds a session created in a worktree from its project folder, and its agent data beside its file', async () => {
    const stored = sessionCreatedIn(worktree);

    expect(await resolvePiSessionFile(project, stored.id)).toBe(stored.file);
    expect(piSessionDirOf(project, stored.id)).toBe(stored.dir);
  });

  it('trusts a remembered file only inside the asking folder\'s lookup directories', async () => {
    const stored = sessionCreatedIn(worktree);
    expect(await resolvePiSessionFile(project, stored.id)).toBe(stored.file);

    expect(await resolvePiSessionFile(elsewhere, stored.id)).toBeNull();
    expect(piSessionDirOf(elsewhere, stored.id)).toBe(piSessionDir(elsewhere));
  });

  it('deletes a handed-off session\'s agent data beside its file, and creates no session directory', async () => {
    const stored = sessionCreatedIn(worktree);
    write(path.join(subagentsDir(stored.dir, stored.id), 'x_agent.jsonl'));
    write(path.join(teamsDir(stored.dir, stored.id), 'team.jsonl'));

    await deletePiSession(project, stored.id);

    expect(fs.existsSync(stored.file)).toBe(false);
    expect(fs.existsSync(path.join(stored.dir, stored.id))).toBe(false);
    expect(fs.existsSync(piSessionDir(project))).toBe(false);
  });

  it('writes a handed-off session\'s team event log beside its file', async () => {
    const stored = sessionCreatedIn(worktree);
    await resolvePiSessionFile(project, stored.id);

    new TeamPersistence(project, stored.id).initTeamFile('team-1');

    expect(fs.existsSync(teamEventLogPath(stored.dir, stored.id, 'team-1'))).toBe(true);
    expect(fs.existsSync(path.join(piSessionDir(project), stored.id))).toBe(false);
  });

  it('reads a handed-off session\'s tool result images from its file', async () => {
    const result = {
      type: 'message',
      id: 'r1',
      parentId: 'u1',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'read', isError: false, content: [{ type: 'image', data: 'REAL', mimeType: 'image/png' }] },
    };
    const stored = sessionCreatedIn(worktree, [result]);

    expect(await loadToolResultImages(project, stored.id, 'tc1', { kind: 'session' })).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'REAL' } },
    ]);
  });
});
