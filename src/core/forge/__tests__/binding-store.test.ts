import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBindingStore, type BindingStore } from '../bindings/binding-store';
import { ForgeFileBrokenError } from '../forge-file';

let dir: string;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'damocles-bindings-'));
  logs = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function opened(): Promise<BindingStore> {
  const store = createBindingStore(dir, (line) => logs.push(line));
  await store.file.load();
  return store;
}

const file = (): unknown => JSON.parse(readFileSync(path.join(dir, 'bindings.json'), 'utf8'));
const REMOTE = 'ssh+prod-1|/home/alexios/api';
const WORK = 'gitlab.indigital.gr|31';
const ADMIN = 'gitlab.indigital.gr|33';

describe('binding store', () => {
  it('writes the bindings.json format, null as "Use Git\'s own credentials"', async () => {
    const store = await opened();
    await store.bind('c:/src/damocles', 'gitlab.com', 'gitlab.com|2001', 1000);
    await store.bind('c:/src/damocles', 'github.com', null, 1001);
    await store.setHostDefault('ssh+prod-1', 'gitlab.indigital.gr', ADMIN);
    expect(file()).toEqual({
      version: 1,
      projects: { 'c:/src/damocles': { 'gitlab.com': { account: 'gitlab.com|2001', at: 1000 }, 'github.com': { account: null, at: 1001 } } },
      hostDefaults: { 'ssh+prod-1': { 'gitlab.indigital.gr': ADMIN } },
    });
    expect(store.binding('c:/src/damocles', 'github.com')).toEqual({ account: null, at: 1001 });
    if (process.platform !== 'win32') expect(statSync(path.join(dir, 'bindings.json')).mode & 0o777).toBe(0o600);
  });

  it('survives a reload: a new store over the folder reads the same bindings', async () => {
    const first = await opened();
    await first.bind(REMOTE, 'gitlab.indigital.gr', WORK, 5);
    await first.setHostDefault('ssh+prod-1', 'gitlab.indigital.gr', ADMIN);
    const second = await opened();
    expect(second.binding(REMOTE, 'gitlab.indigital.gr')).toEqual({ account: WORK, at: 5 });
    expect(second.hostDefaults('ssh+prod-1')).toEqual({ 'gitlab.indigital.gr': ADMIN });
  });

  it('reads a __proto__ key in a hand-edited file as an own key, never as the record\'s prototype', async () => {
    writeFileSync(path.join(dir, 'bindings.json'), '{"version":1,"projects":{"__proto__":{"__proto__":{"account":null,"at":7}}},"hostDefaults":{"__proto__":{"__proto__":"gitlab.com|1"}}}');
    const store = await opened();
    const { projects, hostDefaults } = store.file.value();
    expect(Object.getPrototypeOf(projects)).toBe(Object.prototype);
    expect(Object.keys(projects)).toEqual(['__proto__']);
    expect(Object.keys(projects['__proto__']!)).toEqual(['__proto__']);
    expect(store.binding('__proto__', '__proto__')).toEqual({ account: null, at: 7 });
    expect(Object.getPrototypeOf(hostDefaults)).toBe(Object.prototype);
    expect(store.hostDefaults('__proto__')).toEqual(JSON.parse('{"__proto__":"gitlab.com|1"}'));
    expect(Object.keys(store.hostDefaults('__proto__'))).toEqual(['__proto__']);
  });

  it('removes a host default with null and drops the authority once it holds none', async () => {
    const store = await opened();
    await store.setHostDefault('ssh+prod-1', 'gitlab.indigital.gr', ADMIN);
    await store.setHostDefault('ssh+prod-1', 'gitlab.indigital.gr', null);
    expect(store.hostDefaults('ssh+prod-1')).toEqual({});
    expect(file()).toEqual({ version: 1, projects: {}, hostDefaults: {} });
  });

  it('forgets one project, leaving the others', async () => {
    const store = await opened();
    await store.bind('c:/src/a', 'gitlab.com', 'gitlab.com|2001', 1);
    await store.bind('c:/src/b', 'gitlab.com', 'gitlab.com|2002', 2);
    await store.forgetProject('c:/src/a');
    expect(store.binding('c:/src/a', 'gitlab.com')).toBeUndefined();
    expect(store.binding('c:/src/b', 'gitlab.com')).toEqual({ account: 'gitlab.com|2002', at: 2 });
  });

  it('forgets a host: its defaults and its projects\' bindings, never another authority\'s', async () => {
    const store = await opened();
    await store.bind(REMOTE, 'gitlab.indigital.gr', WORK, 1);
    await store.bind('ssh+prod-2|/srv/app', 'gitlab.indigital.gr', WORK, 2);
    await store.bind('c:/src/local', 'gitlab.indigital.gr', WORK, 3);
    await store.setHostDefault('ssh+prod-1', 'gitlab.indigital.gr', ADMIN);
    await store.setHostDefault('ssh+prod-2', 'gitlab.indigital.gr', ADMIN);
    await store.forgetHost('ssh+prod-1');
    expect(file()).toEqual({
      version: 1,
      projects: { 'ssh+prod-2|/srv/app': { 'gitlab.indigital.gr': { account: WORK, at: 2 } }, 'c:/src/local': { 'gitlab.indigital.gr': { account: WORK, at: 3 } } },
      hostDefaults: { 'ssh+prod-2': { 'gitlab.indigital.gr': ADMIN } },
    });
  });

  it('keeps only the hosts this computer still holds: every other authority\'s defaults and project bindings go, local ones stay', async () => {
    const store = await opened();
    await store.bind(REMOTE, 'gitlab.indigital.gr', WORK, 1);
    await store.bind('ssh+prod-2|/srv/app', 'gitlab.indigital.gr', WORK, 2);
    await store.bind('c:/src/local', 'gitlab.indigital.gr', WORK, 3);
    await store.setHostDefault('ssh+prod-1', 'gitlab.indigital.gr', ADMIN);
    await store.setHostDefault('ssh+prod-2', 'gitlab.indigital.gr', ADMIN);
    expect(await store.keepHosts(new Set(['ssh+prod-2']))).toEqual(['ssh+prod-1']);
    expect(file()).toEqual({
      version: 1,
      projects: { 'ssh+prod-2|/srv/app': { 'gitlab.indigital.gr': { account: WORK, at: 2 } }, 'c:/src/local': { 'gitlab.indigital.gr': { account: WORK, at: 3 } } },
      hostDefaults: { 'ssh+prod-2': { 'gitlab.indigital.gr': ADMIN } },
    });
    expect(await store.keepHosts(new Set(['ssh+prod-2']))).toEqual([]);
  });

  it('forgets an account at sign-out: every binding and host default naming it, and counts them first', async () => {
    const store = await opened();
    await store.bind('c:/src/a', 'gitlab.indigital.gr', WORK, 1);
    await store.bind(REMOTE, 'gitlab.indigital.gr', WORK, 2);
    await store.bind('c:/src/b', 'gitlab.indigital.gr', ADMIN, 3);
    await store.setHostDefault('ssh+prod-1', 'gitlab.indigital.gr', WORK);
    expect(store.count(WORK)).toEqual({ projects: 2, hosts: 1 });
    await store.removeAccount(WORK);
    expect(store.count(WORK)).toEqual({ projects: 0, hosts: 0 });
    expect(file()).toEqual({ version: 1, projects: { 'c:/src/b': { 'gitlab.indigital.gr': { account: ADMIN, at: 3 } } }, hostDefaults: {} });
  });

  it('keeps a broken file\'s last records and refuses every write for the run', async () => {
    writeFileSync(path.join(dir, 'bindings.json'), '{ "version": 1, "projects": ');
    const store = await opened();
    expect(store.file.broken()).toBe(true);
    await expect(store.bind('c:/src/a', 'gitlab.com', null, 1)).rejects.toBeInstanceOf(ForgeFileBrokenError);
    await expect(store.setHostDefault('ssh+prod-1', 'gitlab.com', 'gitlab.com|1')).rejects.toBeInstanceOf(ForgeFileBrokenError);
    expect(readFileSync(path.join(dir, 'bindings.json'), 'utf8')).toBe('{ "version": 1, "projects": ');
    expect(logs.join('\n')).toContain('does not parse');
  });

  it('changes memory only after the write lands', async () => {
    const store = await opened();
    await store.bind('c:/src/a', 'gitlab.com', 'gitlab.com|1', 1);
    // a file another process broke between the reads makes the next write fail, and memory keeps what landed
    writeFileSync(path.join(dir, 'bindings.json'), 'not json');
    await expect(store.bind('c:/src/a', 'gitlab.com', null, 2)).rejects.toBeInstanceOf(ForgeFileBrokenError);
    expect(store.binding('c:/src/a', 'gitlab.com')).toEqual({ account: 'gitlab.com|1', at: 1 });
  });
});
