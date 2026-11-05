import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { piAgentDirIn, sessionFileAt, sessionsRootIn } from '../session-file-path';

const root = sessionsRootIn(piAgentDirIn(path.resolve('/home/u/.damocles')));
const dir = path.join(root, '--work--');
const at = (...parts: string[]): string => path.join(dir, ...parts);

describe('sessionFileAt', () => {
  it('lays the sessions root out as the engine does: <home>/pi/agent/sessions', () => {
    expect(root).toBe(path.resolve('/home/u/.damocles/pi/agent/sessions'));
  });

  it('names a chat file, a subagent file and a team member file, by the session id their names carry', () => {
    expect(sessionFileAt(at('2026-11-04T10-00-00-000Z_s1.jsonl'), root)).toEqual({ kind: 'chat', sessionId: 's1' });
    expect(sessionFileAt(at('s1', 'subagents', '2026-11-04T10-00-00-000Z_agent-1.jsonl'), root)).toEqual({ kind: 'agent', sessionId: 'agent-1' });
    expect(sessionFileAt(at('s1', 'teams', 'team-1', 'members', '2026-11-04T10-00-00-000Z_dev.a2.jsonl'), root)).toEqual({ kind: 'agent', sessionId: 'dev.a2' });
  });

  it('names no other file: a team log, a checkpoint, a name pi does not give, another depth, or a path outside the root', () => {
    for (const file of [
      at('s1', 'teams', 'team-1.jsonl'),
      at('s1', 'teams', 'team-1', 'checkpoints', '1.json'),
      at('notes.jsonl'),
      at('2026_bad id.jsonl'),
      at('s1', 'other', '2026-11-04T10-00-00-000Z_agent-1.jsonl'),
      path.join(root, '2026-11-04T10-00-00-000Z_s1.jsonl'),
      root,
      path.join(path.dirname(root), '--work--', '2026-11-04T10-00-00-000Z_s1.jsonl'),
      path.join(`${root}-other`, '--work--', '2026-11-04T10-00-00-000Z_s1.jsonl'),
    ]) {
      expect(sessionFileAt(file, root), file).toBeUndefined();
    }
  });

  it.runIf(process.platform === 'win32')('compares the folders in any case, as Windows opens them', () => {
    expect(sessionFileAt(path.join(dir.toUpperCase(), '2026-11-04T10-00-00-000Z_s1.jsonl'), root)).toEqual({ kind: 'chat', sessionId: 's1' });
    expect(sessionFileAt(at('2026-11-04T10-00-00-000Z_s1.jsonl'), root.toUpperCase())).toEqual({ kind: 'chat', sessionId: 's1' });
  });
});
