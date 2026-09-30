import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const hoisted = vi.hoisted(() => ({ sessionDir: '' }));
vi.mock('../session-dir', () => ({ ensurePiSessionDir: vi.fn(() => hoisted.sessionDir) }));
vi.mock('../../pi-loader', async () => {
  const real = await import('@earendil-works/pi-coding-agent');
  return { initPiLoader: vi.fn(async () => ({ parseSessionEntries: real.parseSessionEntries })) };
});
vi.mock('../../../logger', () => ({ log: vi.fn() }));

import { findToolResultImagesInFile, loadToolResultImages } from '../tool-result-images';
import { DAMOCLES_AGENT_LAUNCH_ENTRY } from '../constants';

const ID = 'call_abc|fc_123';
const png = (data: string) => ({ type: 'image', data, mimeType: 'image/png' });
const pngBlock = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });

function toolResult(entryId: string, toolCallId: string, content: unknown[], isError = false) {
  return { type: 'message', id: entryId, parentId: null, timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'toolResult', toolCallId, toolName: 'read', isError, content } };
}

function writeSession(file: string, entries: unknown[]): string {
  const header = { type: 'session', version: 3, id: 'sess-1', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/ws' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [header, ...entries].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

describe('tool result images from a session file', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-tool-images-'));
    hoisted.sessionDir = tmp;
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the images of the toolResult with that id, ignoring other lines that mention it', async () => {
    const file = writeSession(path.join(tmp, 'a.jsonl'), [
      { type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: ID, name: 'read', arguments: { path: 'a.png' } }] } },
      { type: 'custom', id: 'c1', parentId: 'm1', timestamp: '2026-01-01T00:00:01.500Z', customType: 'note', data: { toolCallId: ID, content: [png('DECOY')] } },
      toolResult('r0', 'other', [png('OTHER')]),
      toolResult('r1', ID, [{ type: 'text', text: 'Read image file [image/png]' }, png('REAL')]),
      { type: 'context_edit', id: 'e1', parentId: 'r1', timestamp: '2026-01-01T00:00:03.000Z', targetId: 'r1', replacement: { content: [{ type: 'text', text: '[Image removed]' }] } },
    ]);
    expect(await findToolResultImagesInFile(file, ID)).toEqual([pngBlock('REAL')]);
  });

  it('is null when the file holds no toolResult for the id', async () => {
    const file = writeSession(path.join(tmp, 'a.jsonl'), [toolResult('r0', 'other', [png('OTHER')])]);
    expect(await findToolResultImagesInFile(file, ID)).toBeNull();
  });

  it('returns [] for a failed result that carries images', async () => {
    const file = writeSession(path.join(tmp, 'a.jsonl'), [toolResult('r1', ID, [png('FAILED')], true)]);
    expect(await findToolResultImagesInFile(file, ID)).toEqual([]);
  });

  it('stops the team scan at a newer attempt whose result failed', async () => {
    const dir = path.join(tmp, 'sess-1', 'teams', 'team-1', 'members');
    writeSession(path.join(dir, 'a_member-1.a1.jsonl'), [memberLaunch('member-1', 1), toolResult('r1', ID, [png('FAILED')], true)]);
    writeSession(path.join(dir, 'b_member-1.a0.jsonl'), [memberLaunch('member-1', 0), toolResult('r1', ID, [png('OLDEST')])]);

    expect(await loadToolResultImages('/ws', 'sess-1', ID, { kind: 'team', teamId: 'team-1', agentId: 'member-1' })).toEqual([]);
  });

  it('finds the main session file by its id', async () => {
    writeSession(path.join(tmp, '2026-01-01T00-00-00-000Z_sess-1.jsonl'), [toolResult('r1', ID, [png('REAL')])]);
    expect(await loadToolResultImages('/ws', 'sess-1', ID, { kind: 'session' })).toEqual([pngBlock('REAL')]);
  });

  it('returns [] when the session file is missing or holds no such result', async () => {
    expect(await loadToolResultImages('/ws', 'gone', ID, { kind: 'session' })).toEqual([]);
    writeSession(path.join(tmp, '2026-01-01T00-00-00-000Z_sess-1.jsonl'), []);
    expect(await loadToolResultImages('/ws', 'sess-1', ID, { kind: 'session' })).toEqual([]);
  });

  function launch(data: Record<string, unknown>) {
    return { type: 'custom', id: 'l1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', customType: DAMOCLES_AGENT_LAUNCH_ENTRY, data };
  }
  const subagentLaunch = (agentId: string) => launch({ agentId, kind: 'subagent', agentType: 'Explore', description: 'look', prompt: 'look', background: false });
  const memberLaunch = (agentId: string, attempt: number) =>
    launch({ agentId, kind: 'team-member', teamId: 'team-1', attempt, memberName: 'worker', role: 'specialist', task: 'do it' });

  it('finds a subagent file by its launch agent id, never by a file name', async () => {
    const dir = path.join(tmp, 'sess-1', 'subagents');
    writeSession(path.join(dir, '2026-01-01T00-00-00-000Z_agent-7.jsonl'), [subagentLaunch('agent-decoy'), toolResult('r1', ID, [png('DECOY')])]);
    writeSession(path.join(dir, '2026-01-01T00-00-01-000Z_other.jsonl'), [subagentLaunch('agent-7'), toolResult('r1', ID, [png('REAL')])]);

    expect(await loadToolResultImages('/ws', 'sess-1', ID, { kind: 'subagent', agentId: 'agent-7' })).toEqual([pngBlock('REAL')]);
    expect(await loadToolResultImages('/ws', 'sess-1', ID, { kind: 'subagent', agentId: 'agent-missing' })).toEqual([]);
  });

  it('scans a team member\'s newest attempt first', async () => {
    const dir = path.join(tmp, 'sess-1', 'teams', 'team-1', 'members');
    writeSession(path.join(dir, 'a_member-1.a1.jsonl'), [memberLaunch('member-1', 1), toolResult('r1', ID, [png('NEWEST')])]);
    writeSession(path.join(dir, 'b_member-1.a0.jsonl'), [memberLaunch('member-1', 0), toolResult('r1', ID, [png('OLDEST')])]);
    writeSession(path.join(dir, 'c_member-2.a0.jsonl'), [memberLaunch('member-2', 0), toolResult('r1', ID, [png('OTHER')])]);

    expect(await loadToolResultImages('/ws', 'sess-1', ID, { kind: 'team', teamId: 'team-1', agentId: 'member-1' })).toEqual([pngBlock('NEWEST')]);
  });

  it('falls back to an older team attempt that holds the result', async () => {
    const dir = path.join(tmp, 'sess-1', 'teams', 'team-1', 'members');
    writeSession(path.join(dir, 'a_member-1.a1.jsonl'), [memberLaunch('member-1', 1)]);
    writeSession(path.join(dir, 'b_member-1.a0.jsonl'), [memberLaunch('member-1', 0), toolResult('r1', ID, [png('OLDEST')])]);

    expect(await loadToolResultImages('/ws', 'sess-1', ID, { kind: 'team', teamId: 'team-1', agentId: 'member-1' })).toEqual([pngBlock('OLDEST')]);
  });

  it('throws for an unsafe team id rather than building a path from it', async () => {
    await expect(loadToolResultImages('/ws', 'sess-1', ID, { kind: 'team', teamId: '../escape', agentId: 'member-1' })).rejects.toThrow(/Invalid team id/);
  });
});
