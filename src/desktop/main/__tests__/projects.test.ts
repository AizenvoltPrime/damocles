import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_RELOCATED, PROJECTS_FILE, ProjectList } from '../projects';
import { flushAcrossHeldRename } from '../../../__mocks__/held-rename';

let userData: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-projects-'));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('ProjectList', () => {
  it('keeps projects in order, unique by folder key, and persists them', async () => {
    const a = path.join(userData, 'a');
    const b = path.join(userData, 'b');
    const projects = new ProjectList(userData, () => undefined);
    const changed = vi.fn();
    projects.onDidChange(changed);
    expect(await projects.add(b)).toBe(true);
    expect(await projects.add(a)).toBe(true);
    expect(await projects.add(`${b}${path.sep}`)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(new ProjectList(userData, () => undefined).folders()).toEqual([{ fsPath: b, name: 'b' }, { fsPath: a, name: 'a' }]);
    await projects.remove(b);
    expect(new ProjectList(userData, () => undefined).folders().map((f) => f.fsPath)).toEqual([a]);
  });

  it('starts empty, which the folder registry turns into the home target', () => {
    expect(new ProjectList(userData, () => undefined).folders()).toEqual([]);
  });

  it('drops invalid entries from disk', () => {
    const a = path.join(userData, 'a');
    fs.writeFileSync(path.join(userData, PROJECTS_FILE), JSON.stringify({ version: 1, projects: [a, 'relative', 3, a] }));
    expect(new ProjectList(userData, () => undefined).folders().map((f) => f.fsPath)).toEqual([a]);
  });
  it('keeps the list and fires nothing when the write fails', async () => {
    const a = path.join(userData, 'a');
    const list = new ProjectList(userData, () => undefined);
    await list.add(a);
    const listener = vi.fn();
    list.onDidChange(listener);
    fs.rmSync(path.join(userData, PROJECTS_FILE));
    fs.mkdirSync(path.join(userData, PROJECTS_FILE));
    await expect(list.add(path.join(userData, 'b'))).rejects.toThrow();
    await expect(list.remove(a)).rejects.toThrow();
    expect(list.folders().map((f) => f.fsPath)).toEqual([a]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('adds a folder once when two adds of it race', async () => {
    const a = path.join(userData, 'a');
    const list = new ProjectList(userData, () => undefined);
    const listener = vi.fn();
    list.onDidChange(listener);
    expect(await Promise.all([list.add(a), list.add(a)])).toEqual([true, false]);
    expect(list.folders().map((f) => f.fsPath)).toEqual([a]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('flush waits for a write in flight and for one queued while it waits', async () => {
    const a = path.join(userData, 'a');
    const b = path.join(userData, 'b');
    const projects = new ProjectList(userData, () => undefined);
    const onDisk = await flushAcrossHeldRename(path.join(userData, PROJECTS_FILE), {
      first: () => projects.add(a),
      flush: () => projects.flush(),
      second: () => projects.add(b),
      onDisk: () => new ProjectList(userData, () => undefined).folders().map((folder) => folder.fsPath),
    });
    expect(onDisk).toEqual([a, b]);
  });
});

describe('ProjectList.relocate', () => {
  it('puts the new folder in the old one\'s place, and a second call changes nothing', async () => {
    const [a, b, c, moved] = ['a', 'b', 'c', 'moved-b'].map((name) => path.join(userData, name));
    const projects = new ProjectList(userData, () => undefined);
    for (const folder of [a, b!, c!]) await projects.add(folder!);
    expect(await projects.relocate(b!, moved!, 'r1')).toBe(true);
    expect(await projects.relocate(b!, moved!, 'r1')).toBe(false);
    expect(new ProjectList(userData, () => undefined).folders().map((folder) => folder.fsPath)).toEqual([a, moved, c]);
  });

  it('removes the old row when the new folder is listed already (a merge)', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map((name) => path.join(userData, name));
    const projects = new ProjectList(userData, () => undefined);
    for (const folder of [a!, b!, c!]) await projects.add(folder);
    expect(await projects.relocate(a!, `${c!}${path.sep}`, 'r1')).toBe(true);
    expect(new ProjectList(userData, () => undefined).folders().map((folder) => folder.fsPath)).toEqual([b, c]);
    expect(await projects.relocate(a!, c!, 'r1')).toBe(false);
  });

  it('records the relocation in the list\'s own write, which a second call and an older reader leave alone', async () => {
    const [a, moved] = ['a', 'moved-a'].map((name) => path.join(userData, name));
    const file = path.join(userData, PROJECTS_FILE);
    const projects = new ProjectList(userData, () => undefined);
    await projects.add(a!);
    expect(projects.relocated('r1')).toBe(false);
    expect(await projects.relocate(a!, moved!, 'r1')).toBe(true);
    const written = fs.readFileSync(file, 'utf8');
    expect(JSON.parse(written)).toEqual({ version: 1, projects: [moved], relocated: ['r1'] });
    expect(await projects.relocate(a!, moved!, 'r1')).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(written);
    const reread = new ProjectList(userData, () => undefined);
    expect([reread.relocated('r1'), reread.relocated('r2')]).toEqual([true, false]);
    // a re-added old folder is another project: adding and removing it keeps the record
    await reread.add(a!);
    await reread.remove(a!);
    expect(new ProjectList(userData, () => undefined).relocated('r1')).toBe(true);
  });

  it('keeps the latest relocations only, and reads a file that names none', async () => {
    const [a, b] = ['a', 'b'].map((name) => path.join(userData, name));
    fs.writeFileSync(path.join(userData, PROJECTS_FILE), JSON.stringify({ version: 1, projects: [a] }));
    const projects = new ProjectList(userData, () => undefined);
    expect(projects.folders().map((folder) => folder.fsPath)).toEqual([a]);
    for (let i = 0; i <= MAX_RELOCATED; i++) await projects.relocate(i % 2 === 0 ? a! : b!, i % 2 === 0 ? b! : a!, `r${i}`);
    const reread = new ProjectList(userData, () => undefined);
    expect([reread.relocated('r0'), reread.relocated('r1'), reread.relocated(`r${MAX_RELOCATED}`)]).toEqual([false, true, true]);
  });
});
