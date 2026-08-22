import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as nodeOs from 'os';
import * as path from 'path';

// `loadSkillDescription` resolves the user scope through `os.homedir()`. Point it at a temp dir so the
// developer's real `~/.claude/skills` cannot decide the outcome of a test.
const H = vi.hoisted(() => ({ home: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => (H.home !== '' ? H.home : actual.homedir());
  return { ...actual, homedir, default: { ...actual, homedir } };
});

import * as vscode from 'vscode';
import { loadSkillDescription } from '../utils';

const realFsRead = vscode.workspace.fs.readFile;
const realFolders = vscode.workspace.workspaceFolders;
const realIsTrusted = vscode.workspace.isTrusted;

let readFile: ReturnType<typeof vi.fn>;
let ws = '';

function setTrusted(trusted: boolean): void {
  vscode.__setTrusted(trusted);
}

/** Write `<root>/<rel>/SKILL.md` with a frontmatter description. */
function writeSkill(root: string, rel: string, name: string, description: string): void {
  const dir = path.join(root, rel, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`,
    'utf8',
  );
}

describe('loadSkillDescription', () => {
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'skill-ws-'));
    H.home = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'skill-home-'));

    // The shared vscode mock rejects every read. Serve the real temp dirs instead, and count calls so
    // the name-guard test can prove no filesystem access happened at all.
    readFile = vi.fn(async (uri: { fsPath: string }) => new Uint8Array(fs.readFileSync(uri.fsPath)));
    (vscode.workspace as { fs: unknown }).fs = { readFile };
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file(ws), name: 'ws', index: 0 },
    ];
    setTrusted(true);
  });

  afterEach(() => {
    (vscode.workspace as { fs: unknown }).fs = { readFile: realFsRead };
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = realFolders;
    vscode.__setTrusted(realIsTrusted);
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(H.home, { recursive: true, force: true });
    H.home = '';
  });

  it('resolves a description from a project .damocles skill', async () => {
    writeSkill(ws, '.damocles/skills', 'demo', 'from damocles project');
    await expect(loadSkillDescription('demo')).resolves.toBe('from damocles project');
  });

  it('resolves a description from a project .codex skill', async () => {
    writeSkill(ws, '.codex/skills', 'demo', 'from codex project');
    await expect(loadSkillDescription('demo')).resolves.toBe('from codex project');
  });

  it('resolves a description from a user-scope .damocles skill', async () => {
    writeSkill(H.home, '.damocles/skills', 'demo', 'from damocles user');
    await expect(loadSkillDescription('demo')).resolves.toBe('from damocles user');
  });

  it('lets .damocles shadow .claude when both define the skill', async () => {
    writeSkill(ws, '.claude/skills', 'demo', 'from claude project');
    writeSkill(ws, '.damocles/skills', 'demo', 'from damocles project');
    await expect(loadSkillDescription('demo')).resolves.toBe('from damocles project');
  });

  it('lets a project skill shadow the same-named user skill', async () => {
    writeSkill(H.home, '.damocles/skills', 'demo', 'from damocles user');
    writeSkill(ws, '.damocles/skills', 'demo', 'from damocles project');
    await expect(loadSkillDescription('demo')).resolves.toBe('from damocles project');
  });

  it('returns no project description in an untrusted workspace', async () => {
    writeSkill(ws, '.damocles/skills', 'demo', 'from damocles project');
    writeSkill(ws, '.claude/skills', 'demo', 'from claude project');
    setTrusted(false);
    await expect(loadSkillDescription('demo')).resolves.toBeUndefined();
  });

  it('still resolves a user-scope description in an untrusted workspace', async () => {
    writeSkill(ws, '.damocles/skills', 'demo', 'from damocles project');
    writeSkill(H.home, '.claude/skills', 'demo', 'from claude user');
    setTrusted(false);
    await expect(loadSkillDescription('demo')).resolves.toBe('from claude user');
  });

  // A blank value is no value. Reading across the line break would show the next frontmatter key as
  // the description in the approval prompt.
  it.each([
    ['description:', 'bare'],
    ['description:   ', 'trailing spaces'],
  ])('returns undefined when the description is blank (%s)', async (line) => {
    const dir = path.join(ws, '.damocles/skills', 'demo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${line}\nname: demo\n---\n\nbody\n`, 'utf8');

    await expect(loadSkillDescription('demo')).resolves.toBeUndefined();
  });

  // A blank description is as good as an absent one, so the search has to keep going.
  it('falls through to the next source root when the first description is blank', async () => {
    const dir = path.join(ws, '.damocles/skills', 'demo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo\ndescription:\n---\n\nbody\n', 'utf8');
    writeSkill(ws, '.claude/skills', 'demo', 'from claude project');

    await expect(loadSkillDescription('demo')).resolves.toBe('from claude project');
  });

  it('does not match a key that merely ends in description', async () => {
    const dir = path.join(ws, '.damocles/skills', 'demo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: demo\nx-description: not the real one\n---\n\nbody\n',
      'utf8',
    );

    await expect(loadSkillDescription('demo')).resolves.toBeUndefined();
  });

  it('returns undefined for a skill with no description frontmatter', async () => {
    const dir = path.join(ws, '.damocles/skills', 'demo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo\n---\n\nbody\n', 'utf8');
    await expect(loadSkillDescription('demo')).resolves.toBeUndefined();
  });

  // The approval prompt shows no description for a name this reader rejects, so it has to accept every
  // name the scanner can list.
  it('resolves a description for a dotted skill name', async () => {
    writeSkill(ws, '.damocles/skills', 'foo.bar', 'dotted skill');
    await expect(loadSkillDescription('foo.bar')).resolves.toBe('dotted skill');
  });

  it.each(['foo..bar', '.hidden', 'foo.'])(
    'rejects the unusable skill name %j without touching the filesystem',
    async (name) => {
      const planted = path.join(ws, '.damocles', 'skills', name, 'SKILL.md');
      fs.mkdirSync(path.dirname(planted), { recursive: true });
      fs.writeFileSync(planted, '---\ndescription: planted\n---\n', 'utf8');

      await expect(loadSkillDescription(name)).resolves.toBeUndefined();
      expect(readFile).not.toHaveBeenCalled();
    },
  );

  // Each bad name is planted with a real SKILL.md at exactly the path an unguarded implementation
  // would compute, so the assertion fails if `isValidSkillName` stops rejecting it.
  it.each(['../foo', 'a/b', 'a\\b', '..', ''])(
    'rejects the traversal-shaped skill name %j',
    async (name) => {
      const planted = path.join(ws, '.damocles', 'skills', name, 'SKILL.md');
      fs.mkdirSync(path.dirname(planted), { recursive: true });
      fs.writeFileSync(planted, '---\ndescription: planted\n---\n', 'utf8');

      await expect(loadSkillDescription(name)).resolves.toBeUndefined();
      expect(readFile).not.toHaveBeenCalled();
    },
  );
});
