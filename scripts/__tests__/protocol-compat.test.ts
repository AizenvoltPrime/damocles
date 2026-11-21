import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { MAX_FEATURES } from '../../src/remote/handshake';
import { type CheckResult, type Contract, type Snapshot, checkSnapshots, run, snapshot } from '../protocol-compat.ts';

interface Version {
  readonly version?: number;
  readonly features?: readonly string[];
  readonly preRelease?: boolean;
}

const CONTRACTS: readonly Contract[] = [
  { file: 'contract.ts', type: 'Requests', table: true },
  { file: 'contract.ts', type: 'Events' },
  { file: 'contract.ts', type: 'Init' },
  { file: 'contract.ts', type: 'Hello', frozen: true },
  { file: 'contract.ts', type: 'Posts', dropsUnknown: true },
];

const check = (previous: Snapshot, next: Snapshot): CheckResult => checkSnapshots(previous, next, CONTRACTS);

const BASE = `
import type { Entry, Tree } from './other';
export interface Requests {
  'files.read': { readonly params: { readonly path: string; readonly limit?: number }; readonly result: { readonly kind: 'bytes' | 'missing'; readonly size: number } };
  'files.stat': { readonly params: { readonly path: string }; readonly result: boolean };
  'files.entries': { readonly params: { readonly path: string }; readonly result: Readonly<Record<string, Entry>> };
  'files.tree': { readonly params: { readonly path: string }; readonly result: Tree };
}
export type Events =
  | { readonly type: 'changed'; readonly path: string }
  | { readonly type: 'deleted'; readonly path: string };
export interface Init {
  readonly folder: string;
  readonly limit?: number;
}
export interface Hello {
  readonly version: number;
}
export type Posts =
  | { readonly type: 'shown'; readonly code: 'near' | 'far' }
  | { readonly type: 'hidden' };
`;

const OTHER = `
export interface Entry {
  readonly size: number;
}
export interface Tree {
  readonly children: readonly Tree[];
}
`;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function versionSource({ version = 1, features = [], preRelease = true }: Version): string {
  return `export const PROTOCOL_VERSION = ${version};\n\nexport const PROTOCOL_PRE_RELEASE: boolean = ${preRelease};\n\nexport const FEATURES: readonly string[] = [${features.map((feature) => `'${feature}'`).join(', ')}];\n`;
}

// A contract fixture in its own folder: the contract files, the version file and a tsconfig.
function project(source: string, version: Version = {}, other = OTHER): { root: string; versionFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-compat-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, exactOptionalPropertyTypes: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' } }));
  fs.writeFileSync(path.join(root, 'contract.ts'), source);
  fs.writeFileSync(path.join(root, 'other.ts'), other);
  const versionFile = path.join(root, 'protocol-version.ts');
  fs.writeFileSync(versionFile, versionSource(version));
  return { root, versionFile };
}

function fixture(source: string, version = 1, features: readonly string[] = [], other = OTHER): Snapshot {
  const { root, versionFile } = project(source, { version, features }, other);
  return snapshot(root, CONTRACTS, versionFile);
}

// an import("...") naming a module by an absolute POSIX or drive path
const ABSOLUTE_IMPORT = /import\(\\?"(?:\/|[A-Za-z]:)/;

describe('protocol-compat', () => {
  const base = fixture(BASE);

  it('passes an unchanged contract', () => {
    expect(check(base, fixture(BASE))).toMatchObject({ ok: true, errors: [] });
  });

  it('fails a removed field without a protocolVersion bump, and passes it with one', () => {
    const removed = BASE.replace('; readonly limit?: number }', ' }');
    const result = check(base, fixture(removed));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['breaking without a protocolVersion bump: Requests.files.read.params.limit was removed']);
    expect(check(base, fixture(removed, 2)).ok).toBe(true);
  });

  it('fails a value added to a closed list without a new FEATURES name, passes it once one names it, and breaks on a removed value', () => {
    const widened = BASE.replace("'bytes' | 'missing'", "'bytes' | 'missing' | 'tooLarge'");
    expect(check(base, fixture(widened)).errors).toEqual(['an older peer cannot take this addition and no new FEATURES name gates it: Requests.files.read.result.kind gained "tooLarge"']);
    expect(check(base, fixture(widened, 1, ['files.tooLarge']))).toMatchObject({ ok: true, errors: [] });
    expect(check(fixture(widened), fixture(BASE.replace("'bytes' | 'missing'", "'bytes' | 'tooLarge'")))).toMatchObject({
      breaking: ['Requests.files.read.result.kind lost "missing"'],
      additive: [],
    });
  });

  it('passes a variant or value added to a contract whose reader drops what it does not know with no new FEATURES name, and breaks on a removed one', () => {
    const grown = BASE
      .replace("readonly code: 'near' | 'far' }", "readonly code: 'near' | 'far' | 'away' }")
      .replace("  | { readonly type: 'hidden' };", "  | { readonly type: 'hidden' }\n  | { readonly type: 'moved'; readonly to: string };");
    const result = check(base, fixture(grown));
    expect(result).toMatchObject({ ok: true, errors: [], breaking: [], additive: [] });
    expect(result.optional).toEqual(['Posts[type="shown"].code gained "away"', 'Posts[type="moved"] was added']);
    expect(check(base, fixture(BASE.replace("\n  | { readonly type: 'hidden' }", ''))).ok).toBe(false);
  });

  it('fails a changed field without a bump', () => {
    expect(check(base, fixture(BASE.replace('readonly size: number', 'readonly size: string'))).errors).toEqual([
      'breaking without a protocolVersion bump: Requests.files.read.result.size changed from "number" to "string"',
    ]);
    expect(check(base, fixture(BASE.replace('readonly path: string }; readonly result: boolean', 'readonly path: string; readonly deep: boolean }; readonly result: boolean'))).errors).toEqual([
      'breaking without a protocolVersion bump: Requests.files.stat.params.deep was added as required',
    ]);
  });

  it('passes an optional field added to a request, a result, an event or a plain contract with no new FEATURES name', () => {
    const optional = BASE
      .replace('readonly path: string; readonly limit?: number', 'readonly path: string; readonly limit?: number; readonly offset?: number')
      .replace("readonly kind: 'bytes' | 'missing'; readonly size: number", "readonly kind: 'bytes' | 'missing'; readonly size: number; readonly mtime?: number")
      .replace("{ readonly type: 'changed'; readonly path: string }", "{ readonly type: 'changed'; readonly path: string; readonly size?: number }")
      .replace('readonly limit?: number;\n}', 'readonly limit?: number;\n  readonly epoch?: string;\n}');
    const result = check(base, fixture(optional));
    expect(result).toMatchObject({ ok: true, errors: [], breaking: [], additive: [] });
    expect(result.optional).toEqual([
      'Requests.files.read.params.offset was added (optional)',
      'Requests.files.read.result.mtime was added (optional)',
      'Events[type="changed"].size was added (optional)',
      'Init.epoch was added (optional)',
    ]);
  });

  it('fails a new request without a new FEATURES name, and passes it once one names it', () => {
    const listed = BASE.replace("  'files.stat':", "  'files.list': { readonly params: { readonly path: string }; readonly result: readonly string[] };\n  'files.stat':");
    expect(check(base, fixture(listed)).errors).toEqual(['an older peer cannot take this addition and no new FEATURES name gates it: Requests.files.list was added']);
    expect(check(base, fixture(listed, 1, ['files.list']))).toMatchObject({ ok: true, errors: [] });
  });

  it('fails a new variant of a tagged union without a new FEATURES name, and passes it once one names it', () => {
    const renamed = BASE.replace("  | { readonly type: 'deleted'; readonly path: string };", "  | { readonly type: 'deleted'; readonly path: string }\n  | { readonly type: 'renamed'; readonly from: string; readonly to: string };");
    expect(check(base, fixture(renamed)).errors).toEqual(['an older peer cannot take this addition and no new FEATURES name gates it: Events[type="renamed"] was added']);
    expect(check(base, fixture(renamed, 1, ['files.renamed']))).toMatchObject({ ok: true, errors: [] });
  });

  it('compares an array\'s elements, so an optional field added inside one is additive and a required one breaks', () => {
    const listed = BASE.replace("  'files.stat':", "  'files.find': { readonly params: { readonly path: string }; readonly result: readonly { readonly name: string }[] };\n  'files.stat':");
    const before = fixture(listed);
    const optional = fixture(listed.replace('readonly { readonly name: string }[]', 'readonly { readonly name: string; readonly size?: number }[]'));
    expect(check(before, optional)).toMatchObject({ ok: true, errors: [] });
    expect(check(before, fixture(listed.replace('readonly { readonly name: string }[]', 'readonly { readonly name: string; readonly size: number }[]'))).errors).toEqual([
      'breaking without a protocolVersion bump: Requests.files.find.result[].size was added as required',
    ]);
  });

  it('compares the members of a plain union in order, so an optional field added inside one is additive and a changed member breaks', () => {
    const united = BASE.replace("  'files.stat':", "  'files.send': { readonly params: { readonly content: string | readonly { readonly data: string }[] }; readonly result: boolean };\n  'files.stat':");
    const before = fixture(united);
    expect(check(before, fixture(united.replace('readonly { readonly data: string }[]', 'readonly { readonly data: string; readonly origin?: \'preview\' }[]')))).toMatchObject({ ok: true, errors: [] });
    expect(check(before, fixture(united.replace('content: string |', 'content: number |'))).ok).toBe(false);
  });

  it('fails a removed command or event variant without a bump', () => {
    expect(check(base, fixture(BASE.replace(/ {2}'files\.stat'.*\n/, ''))).errors).toEqual(['breaking without a protocolVersion bump: Requests.files.stat was removed']);
    expect(check(base, fixture(BASE.replace("\n  | { readonly type: 'deleted'; readonly path: string }", ''))).ok).toBe(false);
  });

  it('compares a table member\'s optional flag', () => {
    expect(check(base, fixture(BASE.replace("  'files.stat':", "  'files.stat'?:"))).errors).toEqual(['breaking without a protocolVersion bump: Requests.files.stat became optional']);
  });

  it('fails a required field added to a contract that is not a table, even once named', () => {
    const required = BASE.replace('readonly folder: string;', 'readonly folder: string;\n  readonly epoch: string;');
    expect(check(base, fixture(required)).errors).toEqual(['breaking without a protocolVersion bump: Init.epoch was added as required']);
    expect(check(base, fixture(required, 1, ['init.epoch'])).errors).toEqual(['breaking without a protocolVersion bump: Init.epoch was added as required']);
  });

  it('fails any change to a frozen contract, with or without a bump', () => {
    const changed = BASE.replace('readonly version: number;', 'readonly version: number;\n  readonly token?: Uint8Array;');
    expect(check(base, fixture(changed, 1, ['hello.token'])).errors).toEqual(['Hello is frozen across every protocol version and changed']);
    expect(check(base, fixture(changed, 2)).errors).toEqual(['Hello is frozen across every protocol version and changed']);
  });

  it('describes a lib alias by its members, so a change inside the type it holds is seen', () => {
    const changed = fixture(BASE, 1, [], OTHER.replace('readonly size: number;', 'readonly size: string;'));
    expect(check(base, changed).errors).toEqual([
      'breaking without a protocolVersion bump: Requests.files.entries.result[string].size changed from "number" to "string"',
    ]);
  });

  it('compares an index signature\'s values, so an optional field added inside one needs no FEATURES name', () => {
    const grown = fixture(BASE, 1, [], OTHER.replace('readonly size: number;', 'readonly size: number;\n  readonly mode?: string;'));
    expect(check(base, grown)).toMatchObject({ ok: true, errors: [] });
    const required = fixture(BASE, 1, [], OTHER.replace('readonly size: number;', 'readonly size: number;\n  readonly mode: string;'));
    expect(check(base, required).errors).toEqual(['breaking without a protocolVersion bump: Requests.files.entries.result[string].mode was added as required']);
  });

  it('names another module by its path relative to the root, never an absolute one', () => {
    const text = JSON.stringify(base);
    expect(text).toContain('import(\\"other\\").Tree');
    expect(text).not.toMatch(ABSOLUTE_IMPORT);
  });

  it('matches the committed snapshot of the real contracts, which names no absolute path', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'remote', 'protocol-snapshot.json'), 'utf8');
    expect(raw).not.toMatch(ABSOLUTE_IMPORT);
    const committed = JSON.parse(raw) as Snapshot;
    const current = snapshot();
    expect(checkSnapshots(committed, current)).toMatchObject({ ok: true, errors: [] });
    expect(JSON.stringify(current)).toBe(JSON.stringify(committed));
  }, 60_000);

  it('names the design preview\'s requests and event in the features and the committed contracts', () => {
    const committed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'remote', 'protocol-snapshot.json'), 'utf8')) as { features: string[]; contracts: Record<string, Record<string, unknown>> };
    expect(committed.features).toEqual(expect.arrayContaining(['design.read', 'design.info', 'design.openPreview', 'design.changed']));
    expect(Object.keys(committed.contracts['MainRequests']!['object'] as object)).toEqual(expect.arrayContaining(['design.read', 'design.info']));
    expect(Object.keys(committed.contracts['CoreRequests']!['object'] as object)).toContain('design.openPreview');
    expect(Object.keys(committed.contracts['CoreEvents']!['object'] as object)).toContain('design.changed');
  });

  it('names the markup request in the features and the committed contracts', () => {
    const committed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'remote', 'protocol-snapshot.json'), 'utf8')) as { features: string[]; contracts: Record<string, Record<string, unknown>> };
    expect(committed.features).toContain('design.markup');
    expect(Object.keys(committed.contracts['MainRequests']!['object'] as object)).toContain('design.markup');
  });

  it('names the design renders in the features and the committed contracts', () => {
    const committed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'remote', 'protocol-snapshot.json'), 'utf8')) as { features: string[]; contracts: Record<string, Record<string, unknown>> };
    expect(committed.features).toEqual(expect.arrayContaining(['design.capture', 'design.probe']));
    expect(Object.keys(committed.contracts['CoreRequests']!['object'] as object)).toEqual(expect.arrayContaining(['design.capture', 'design.probe']));
  });
});

describe('the pull request workflow', () => {
  const workflow = parse(fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'pr.yml'), 'utf8')) as { jobs: Record<string, { steps: Array<{ uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }> }> };
  const steps = workflow.jobs['checks']!.steps;

  it('checks the contracts against the base branch\'s committed snapshot, the base ref passed through the environment', () => {
    const against = steps.find((step) => step.run?.includes('protocol-compat.ts --against'));
    expect(against?.env?.['BASE_REF']).toBe('${{ github.base_ref || github.event.repository.default_branch }}');
    expect(against?.run).not.toContain('${{');
    expect(against?.run).toContain('snapshot="origin/$BASE_REF:src/remote/protocol-snapshot.json"');
    expect(against?.run).toContain('git show "$snapshot"');
    expect(steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.with?.['fetch-depth']).toBe(0);
    expect(steps.some((step) => step.run === 'node scripts/protocol-compat.ts --check')).toBe(true);
  });
});

describe('the command line', () => {
  const BREAKING = BASE.replace('; readonly limit?: number }', ' }');

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  // a fixture whose committed snapshot is BASE's under `committed`, with `source` as the contracts now
  function repository(source: string, committed: Version, now: Version = committed): { argv: (...args: string[]) => number; snapshotPath: string; written: () => string; current: () => Snapshot } {
    const { root, versionFile } = project(source, now);
    const old = project(BASE, committed);
    const snapshotPath = path.join(root, 'protocol-snapshot.json');
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot(old.root, CONTRACTS, old.versionFile)));
    return { argv: (...args) => run(args, { root, contracts: CONTRACTS, versionFile, snapshotPath }), snapshotPath, written: () => fs.readFileSync(snapshotPath, 'utf8'), current: () => snapshot(root, CONTRACTS, versionFile) };
  }

  it('writes a compatible change', () => {
    const repo = repository(BASE.replace('readonly limit?: number }', 'readonly limit?: number; readonly offset?: number }'), { features: [] });
    expect(repo.argv('--check')).toBe(1);
    expect(repo.argv()).toBe(0);
    expect(repo.argv('--check')).toBe(0);
  });

  const names = (count: number): string[] => Array.from({ length: count }, (_, index) => `feature.n${index}`);

  it('takes a FEATURES list of exactly MAX_FEATURES names', () => {
    const repo = repository(BASE, { features: [] }, { features: names(MAX_FEATURES) });
    expect(repo.argv()).toBe(0);
    expect(repo.argv('--check')).toBe(0);
  });

  it.each([
    ['past MAX_FEATURES names', names(MAX_FEATURES + 1), `FEATURES holds ${MAX_FEATURES + 1} names, past MAX_FEATURES (${MAX_FEATURES}), so every welcome and core attach would be refused`],
    ['naming a name twice', ['files.list', 'files.stat', 'files.list'], 'FEATURES names files.list more than once'],
  ])('refuses a FEATURES list %s in every mode, even with --allow-breaking while pre-release', (_name, features, error) => {
    const repo = repository(BASE, { features: [] }, { features });
    const before = repo.written();
    expect(repo.argv('--allow-breaking')).toBe(1);
    expect(repo.written()).toBe(before);
    expect(repo.argv('--check')).toBe(1);
    expect(repo.argv('--against', repo.snapshotPath)).toBe(1);
    expect(console.error).toHaveBeenCalledWith(error);
    // a committed snapshot that already matches such a list still fails --check
    fs.writeFileSync(repo.snapshotPath, JSON.stringify(repo.current()));
    expect(repo.argv('--check')).toBe(1);
  });

  it('refuses to write a breaking change without --allow-breaking, so --check still fails', () => {
    const repo = repository(BREAKING, {});
    const before = repo.written();
    expect(repo.argv()).toBe(1);
    expect(repo.written()).toBe(before);
    expect(repo.argv('--check')).toBe(1);
  });

  it('writes a breaking change with --allow-breaking only while the committed snapshot is pre-release', () => {
    const preRelease = repository(BREAKING, { preRelease: true });
    expect(preRelease.argv('--allow-breaking')).toBe(0);
    expect(preRelease.argv('--check')).toBe(0);
    const released = repository(BREAKING, { preRelease: false });
    const before = released.written();
    expect(released.argv('--allow-breaking')).toBe(1);
    expect(released.written()).toBe(before);
  });

  it('never accepts a return to pre-release', () => {
    const repo = repository(BASE, { preRelease: false }, { preRelease: true });
    expect(repo.argv('--allow-breaking')).toBe(1);
  });

  it('checks the contracts against an older snapshot, strictly once that one is released', () => {
    const released = repository(BREAKING, { preRelease: false });
    expect(released.argv('--against', released.snapshotPath)).toBe(1);
    const preRelease = repository(BREAKING, { preRelease: true });
    expect(preRelease.argv('--against', preRelease.snapshotPath)).toBe(0);
    const compatible = repository(BASE, { preRelease: false });
    expect(compatible.argv('--against', compatible.snapshotPath)).toBe(0);
  });
});
