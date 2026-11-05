import { describe, expect, it } from 'vitest';
import type { ShellEditorTab, ShellHost, ShellProject } from '../../preload/shell-channels';
import { tabDescriptions, tabHostName } from '../editor/tab-labels';

const project = (key: string, authority: string, name: string): ShellProject => ({ key, name: 'p', authority: { key: authority, name } } as unknown as ShellProject);
const host = (authorityKey: string, name: string): ShellHost => ({ authorityKey, name } as unknown as ShellHost);
const tab = (id: string, title: string, displayPath: string, extra: Partial<ShellEditorTab> = {}): ShellEditorTab =>
  ({ id, kind: 'code', title, displayPath, dirty: false, readOnly: false, conflict: false, ...extra });

describe('tabHostName', () => {
  const projects = [project('local|c:\\work', 'local', 'LAPTOP'), project('ssh+h1|/srv/app', 'ssh+h1', 'old-name'), project('loopback|/tmp/x', 'loopback', 'Local daemon')];
  const hosts = [host('ssh+h1', 'prod-1')];

  it('names no host for this computer\'s files, and the host as ShellState names it for another host\'s', () => {
    expect(tabHostName({ projectKey: 'local|c:\\work' }, projects, hosts)).toBeUndefined();
    expect(tabHostName({}, projects, hosts)).toBeUndefined();
    expect(tabHostName({ projectKey: 'ssh+h1|/srv/app' }, projects, hosts)).toBe('prod-1');
    expect(tabHostName({ host: 'ssh+h1' }, projects, hosts)).toBe('prod-1');
    // an authority with no saved host record, named by its project
    expect(tabHostName({ host: 'loopback' }, projects, hosts)).toBe('Local daemon');
  });
});

describe('tabDescriptions', () => {
  const hostOf = (candidate: ShellEditorTab): string | undefined => (candidate.host === 'ssh+h1' ? 'prod-1' : candidate.host === 'ssh+h2' ? 'prod-2' : undefined);

  it('gives a tab whose title no other file tab shares no description', () => {
    expect(tabDescriptions([tab('a', 'a.ts', 'C:\\w\\a.ts'), tab('b', 'b.ts', 'C:\\w\\b.ts')], hostOf, 'This computer')).toEqual(new Map());
  });

  it('names the host when same-named files are on different hosts, this computer\'s included', () => {
    const tabs = [tab('l', '.bashrc', 'C:\\Users\\me\\.bashrc'), tab('r', '.bashrc', '/home/me/.bashrc', { host: 'ssh+h1' }), tab('s', '.bashrc', '/home/me/.bashrc', { host: 'ssh+h2' })];
    expect(tabDescriptions(tabs, hostOf, 'This computer')).toEqual(new Map([['l', 'This computer'], ['r', 'prod-1'], ['s', 'prod-2']]));
  });

  it('adds the shortest trailing run of folders that tells same-named files on one host apart, in the path\'s separator', () => {
    const tabs = [
      tab('a', 'index.ts', '/srv/app/src/index.ts', { host: 'ssh+h1' }),
      tab('b', 'index.ts', '/srv/lib/src/index.ts', { host: 'ssh+h1' }),
      tab('c', 'index.ts', 'C:\\work\\api\\index.ts'),
    ];
    expect(tabDescriptions(tabs, hostOf, 'This computer')).toEqual(new Map([['a', 'prod-1 · app/src'], ['b', 'prod-1 · lib/src'], ['c', 'This computer']]));
    const local = [tab('a', 'index.ts', 'C:\\work\\api\\index.ts'), tab('b', 'index.ts', 'C:\\work\\web\\index.ts')];
    expect(tabDescriptions(local, hostOf, 'This computer')).toEqual(new Map([['a', 'api'], ['b', 'web']]));
  });

  it('tells two session logs on one host apart by their folders, and leaves pages and pathless tabs out', () => {
    const tabs = [
      tab('a', 'x.jsonl', '/home/me/.damocles/pi/agent/sessions/--proj-a--/x.jsonl', { host: 'ssh+h1' }),
      tab('b', 'x.jsonl', '/home/me/.damocles/pi/agent/sessions/--proj-b--/x.jsonl', { host: 'ssh+h1' }),
      tab('u', 'x.jsonl', 'x.jsonl', { kind: 'untitled' }),
    ];
    expect(tabDescriptions(tabs, hostOf, 'This computer')).toEqual(new Map([['a', '--proj-a--'], ['b', '--proj-b--']]));
  });
});
