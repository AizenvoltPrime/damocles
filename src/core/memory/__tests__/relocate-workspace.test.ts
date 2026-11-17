import { describe, expect, it } from 'vitest';
import { relocateWorkspaceRows } from '../workspaces';
import type { DatabaseInstance } from '../types';
import { createTestMemoryDb } from './test-helpers';

const FROM = 'C:\\old\\acme';
const TO = 'C:\\new\\acme';

function seed(db: DatabaseInstance): void {
  const memory = db.prepare(`INSERT INTO memories (id, kind, scope, content, workspace, created_at, updated_at) VALUES (?, 'fact', 'project', ?, ?, 1, 1)`);
  memory.run('m-old', 'old fact', FROM);
  // another spelling of the old folder, as another window may have filed it
  memory.run('m-old-spelling', 'old fact two', 'c:/old/acme/');
  memory.run('m-other', 'other project', 'C:\\other');
  memory.run('m-target', 'target fact', 'c:\\NEW\\acme');
  db.prepare(`INSERT INTO memory_candidates (id, session_id, workspace, created_at) VALUES ('c1', 's1', ?, 1)`).run(FROM);
  db.prepare(`INSERT INTO memory_retrievals (memory_id, workspace, retrieved_at) VALUES ('m-old', ?, 1)`).run(FROM);
  db.prepare(`INSERT INTO memory_audit_proposals (id, run_id, action, target_workspace, profile_workspace, created_at) VALUES ('p1', 'r1', 'rescope_workspace', ?, ?, 1)`).run(FROM, FROM);
  const profile = db.prepare(`INSERT INTO memory_profile (scope, workspace, section, content, updated_at) VALUES ('project', ?, ?, ?, 1)`);
  profile.run(FROM, 'static', 'old static');
  profile.run(FROM, 'dynamic', 'old dynamic');
  profile.run('c:\\NEW\\acme', 'static', 'target static');
}

const workspaceOf = (db: DatabaseInstance, id: string): unknown => (db.prepare('SELECT workspace FROM memories WHERE id = ?').get(id) as { workspace: unknown }).workspace;

describe('relocateWorkspaceRows', () => {
  it('re-keys every table to the spelling the store has for the new folder, and the target profile section wins', async () => {
    const db = await createTestMemoryDb();
    seed(db);
    relocateWorkspaceRows(db, FROM, TO, 'win32');

    expect(workspaceOf(db, 'm-old')).toBe('c:\\NEW\\acme');
    expect(workspaceOf(db, 'm-old-spelling')).toBe('c:\\NEW\\acme');
    expect(workspaceOf(db, 'm-other')).toBe('C:\\other');
    expect((db.prepare(`SELECT workspace FROM memory_candidates WHERE id = 'c1'`).get() as { workspace: string }).workspace).toBe('c:\\NEW\\acme');
    expect((db.prepare('SELECT workspace FROM memory_retrievals').get() as { workspace: string }).workspace).toBe('c:\\NEW\\acme');
    expect(db.prepare(`SELECT target_workspace, profile_workspace FROM memory_audit_proposals WHERE id = 'p1'`).get()).toEqual({ target_workspace: 'c:\\NEW\\acme', profile_workspace: 'c:\\NEW\\acme' });

    const profile = db.prepare('SELECT workspace, section, content FROM memory_profile ORDER BY section').all();
    expect(profile).toEqual([
      { workspace: 'c:\\NEW\\acme', section: 'dynamic', content: 'old dynamic' },
      { workspace: 'c:\\NEW\\acme', section: 'static', content: 'target static' },
    ]);
  });

  it('moves one profile section filed under two spellings of the old folder, keeping the latest edit', async () => {
    const db = await createTestMemoryDb();
    const profile = db.prepare(`INSERT INTO memory_profile (scope, workspace, section, content, updated_at) VALUES ('project', ?, 'static', ?, ?)`);
    profile.run(FROM, 'older static', 1);
    profile.run('c:\\old\\acme', 'newer static', 2);
    relocateWorkspaceRows(db, FROM, TO, 'win32');

    expect(db.prepare('SELECT workspace, section, content FROM memory_profile').all()).toEqual([{ workspace: TO, section: 'static', content: 'newer static' }]);
    relocateWorkspaceRows(db, FROM, TO, 'win32');
    expect(db.prepare('SELECT workspace, section, content FROM memory_profile').all()).toEqual([{ workspace: TO, section: 'static', content: 'newer static' }]);
  });

  it('keeps the new folder\'s profile section over every spelling of the old folder\'s', async () => {
    const db = await createTestMemoryDb();
    const profile = db.prepare(`INSERT INTO memory_profile (scope, workspace, section, content, updated_at) VALUES ('project', ?, 'static', ?, ?)`);
    profile.run(FROM, 'old static', 3);
    profile.run('c:\\old\\acme', 'old static two', 4);
    profile.run('c:\\new\\acme', 'target static', 1);
    relocateWorkspaceRows(db, FROM, TO, 'win32');

    expect(db.prepare('SELECT workspace, section, content FROM memory_profile').all()).toEqual([{ workspace: 'c:\\new\\acme', section: 'static', content: 'target static' }]);
  });

  it('changes nothing once the rows moved', async () => {
    const db = await createTestMemoryDb();
    seed(db);
    relocateWorkspaceRows(db, FROM, TO, 'win32');
    const before = db.prepare('SELECT id, workspace FROM memories ORDER BY id').all();
    relocateWorkspaceRows(db, FROM, TO, 'win32');
    expect(db.prepare('SELECT id, workspace FROM memories ORDER BY id').all()).toEqual(before);
  });
});
