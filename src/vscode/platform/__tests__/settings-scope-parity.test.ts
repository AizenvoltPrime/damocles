import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __config } from 'vscode';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { parseContributedConfiguration } from '../../../core/config/contributed-configuration';
import type { SettingsScope, SettingsStore } from '../../../platform/settings-store';
import { DesktopSettingsStore } from '../../../desktop/main/platform/settings-store';
import { VsCodeSettingsStore } from '../settings-store';

type Layer = Readonly<Record<string, unknown>>;

// One set of layered inputs; every key is one a trusted project may set on desktop. No local layer: these reads pass no
// folder, and VS Code reports and writes a folder value only for a resource, so it has none to compare.
const FIXTURE: { readonly defaults: Layer; readonly user: Layer; readonly project: Layer } = {
  defaults: {
    'damocles.model': 'default-model',
    'damocles.maxTurns': 100,
    'damocles.sandbox': { enabled: false },
    'damocles.debug': false,
    'damocles.autoCompact': { enabled: false, triggerPercent: 80 },
  },
  user: {
    'damocles.model': 'user-model',
    'damocles.maxTurns': 20,
    'damocles.effort': 'high',
    'damocles.maxBudgetUsd': null,
    'damocles.effortByModel': { 'gpt-6-luna': 'high' },
    'damocles.autoCompact': { enabled: true },
  },
  project: { 'damocles.model': 'project-model', 'damocles.sandbox': { enabled: true }, 'damocles.effortByModel': { 'gpt-6.1-sol': 'low' } },
};

const KEYS = [...new Set(Object.values(FIXTURE).flatMap((layer) => Object.keys(layer))), 'damocles.absent'];

let dir: string;
let folder: string;

beforeEach(() => {
  __config.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmx-par-'));
  folder = path.join(dir, 'project');
  fs.mkdirSync(path.join(folder, '.damocles'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function vsCodeStore(): SettingsStore {
  const layers: ReadonlyArray<readonly [Map<string, unknown>, Layer]> = [
    [__config.defaults, FIXTURE.defaults],
    [__config.global, FIXTURE.user],
    [__config.workspace, FIXTURE.project],
  ];
  for (const [map, layer] of layers) for (const [key, value] of Object.entries(layer)) map.set(key, value);
  return new VsCodeSettingsStore();
}

function desktopStore(): DesktopSettingsStore {
  const userFile = path.join(dir, 'home', '.damocles', 'settings.json');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, JSON.stringify(FIXTURE.user));
  fs.writeFileSync(path.join(folder, '.damocles', 'settings.json'), JSON.stringify(FIXTURE.project));
  const fake = createFakePlatform({ folders: [{ fsPath: folder, name: 'project' }] });
  const properties = Object.fromEntries(Object.entries(FIXTURE.defaults).map(([key, value]) => [key, { default: value }]));
  return new DesktopSettingsStore({
    userFile,
    contributed: parseContributedConfiguration({ contributes: { configuration: { properties } } }),
    fileWatchers: fake.fileWatchers,
    projects: fake.workspaceFolders,
    trust: { isTrusted: () => true, onDidGrantTrust: () => ({ dispose: () => undefined }), requestTrust: () => Promise.resolve(true) },
    defaultProject: { folder: () => folder, onDidChange: () => ({ dispose: () => undefined }) },
    chatFolders: { folders: () => [], onDidChange: () => ({ dispose: () => undefined }) },
    notifications: fake.notifications,
    localization: fake.localization,
    log: () => undefined,
  });
}

function snapshot(store: SettingsStore): Record<string, unknown> {
  return Object.fromEntries(KEYS.map((key) => [key, { inspect: store.inspect(key), get: store.get(key, 'caller-default') }]));
}

describe('SettingsStore scope parity: VS Code vs desktop', () => {
  it('inspect and get agree on the shared layered fixture', () => {
    const desktop = desktopStore();
    expect(snapshot(desktop)).toStrictEqual(snapshot(vsCodeStore()));
    desktop.dispose();
  });

  it('merge object values with disjoint keys across layers and keep a stored null', () => {
    const desktop = desktopStore();
    for (const store of [desktop, vsCodeStore()]) {
      expect(store.get('damocles.effortByModel')).toStrictEqual({ 'gpt-6-luna': 'high', 'gpt-6.1-sol': 'low' });
      expect(store.get('damocles.autoCompact')).toStrictEqual({ enabled: true, triggerPercent: 80 });
      expect(store.inspect('damocles.effortByModel')).toStrictEqual({ userValue: { 'gpt-6-luna': 'high' }, projectValue: { 'gpt-6.1-sol': 'low' } });
      expect(store.get('damocles.maxBudgetUsd', 'caller-default')).toBeNull();
    }
    desktop.dispose();
  });

  it('agree after the same writes at every shared scope, removals included', async () => {
    const writes: ReadonlyArray<readonly [string, unknown, SettingsScope]> = [
      ['damocles.model', undefined, 'project'],
      ['damocles.maxTurns', 7, 'project'],
      ['damocles.effort', undefined, 'user'],
      ['damocles.debug', true, 'user'],
      ['damocles.sandbox', undefined, 'project'],
      ['damocles.effortByModel', { 'gpt-6-nova': 'medium' }, 'project'],
    ];
    const desktop = desktopStore();
    const vscode = vsCodeStore();
    for (const store of [desktop, vscode]) {
      for (const [key, value, scope] of writes) await store.update(key, value, scope);
    }
    expect(snapshot(desktop)).toStrictEqual(snapshot(vscode));
    desktop.dispose();
  });
});

describe('VsCodeSettingsStore local scope', () => {
  it('never reports a local value and cannot write one, as VS Code without a resource', async () => {
    __config.workspaceFolder.set('damocles.model', 'folder-model');
    const store = vsCodeStore();
    expect('localValue' in store.inspect('damocles.model')).toBe(false);
    expect(store.get('damocles.model')).toBe('project-model');
    await expect(store.update('damocles.model', 'x', 'local')).rejects.toThrow(/no resource is provided/);
  });
});
