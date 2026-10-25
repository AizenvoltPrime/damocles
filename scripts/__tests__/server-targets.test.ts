import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
// @ts-expect-error -- plain .mjs helper, no types
import { ALPINE_PREREQUISITES, ALPINE_TARGET_IMAGE, SERVER_TARGETS, NODE_RELEASES, electronNodeVersions, nodeReleaseProblem, nodeArchive, serverArtifact } from '../server-targets.mjs';
// @ts-expect-error -- plain .mjs helper, no types
import { DESKTOP_TARGETS, serverArtifactProblems } from '../release-targets.mjs';

type Versions = { node: string; modules: string; napi: string; electron?: string };
type ServerSpec = { platform: string; arch: string; libc: string | null; runner: string; alpine: boolean; natives: string[]; ptyPrebuild: string };
type Step = { name?: string; run?: string; uses?: string; if?: string; with?: Record<string, string> };
type Job = { needs?: string | string[]; outputs?: Record<string, string>; env?: Record<string, string>; steps: Step[]; strategy?: { matrix: { include: Record<string, string | boolean | number>[] } } };

const ROOT = join(__dirname, '..', '..');
const targets = SERVER_TARGETS as Record<string, ServerSpec>;
const releases = NODE_RELEASES as Record<string, { modules: string; napi: string; alpineImage: string; archives: Record<string, { url: string; sha256: string }> }>;
const workflow = parse(readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')) as { jobs: Record<string, Job> };
const PINNED: Versions = { node: '24.22.0', modules: '149', napi: '10', electron: '44.9.0' };

describe('the server Node is derived from Electron', () => {
  it('reads the versions of the executable it runs as Node', () => {
    const versions = electronNodeVersions(process.execPath) as Versions;
    expect(versions).toEqual({ node: process.versions.node, modules: process.versions.modules, napi: process.versions.napi });
  });

  // The Electron binary downloads on first require, so the real derivation runs only where it is already installed.
  const electronBinary = (() => {
    const pathFile = join(ROOT, 'node_modules', 'electron', 'path.txt');
    return existsSync(pathFile) ? join(ROOT, 'node_modules', 'electron', 'dist', readFileSync(pathFile, 'utf8')) : undefined;
  })();
  it.skipIf(electronBinary === undefined || !existsSync(electronBinary))('pins the archives of the Node the installed Electron embeds', () => {
    const versions = electronNodeVersions(electronBinary) as Versions;
    const { devDependencies } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
    expect(versions.electron).toBe(devDependencies['electron']);
    expect(nodeReleaseProblem(versions)).toBeUndefined();
  });

  it('accepts the pinned release and fails an Electron whose Node has no pinned archives', () => {
    expect(nodeReleaseProblem(PINNED)).toBeUndefined();
    expect(nodeReleaseProblem({ ...PINNED, node: '24.23.0', electron: '44.10.0' })).toMatch(/Electron 44\.10\.0 embeds Node 24\.23\.0, which has no pinned archives/);
  });

  it('fails when Electron reports another ABI than the pinned release', () => {
    expect(nodeReleaseProblem({ ...PINNED, modules: '150' })).toMatch(/modules 150/);
    expect(nodeReleaseProblem({ ...PINNED, napi: '11' })).toMatch(/napi 11/);
  });

  it('fails when a pinned release lacks a target archive', () => {
    const { 'win32-arm64': _dropped, ...archives } = releases['24.22.0']!.archives;
    expect(nodeReleaseProblem(PINNED, { '24.22.0': { ...releases['24.22.0'], archives } })).toMatch(/no archive for win32-arm64/);
    expect(() => nodeArchive('win32-x64', '24.23.0')).toThrow(/No Node 24\.23\.0 archive is pinned/);
  });

  it('pins each archive by SHA-256 from nodejs.org, or unofficial-builds for musl', () => {
    for (const [version, release] of Object.entries(releases)) {
      expect(Object.keys(release.archives).sort()).toEqual(Object.keys(targets).sort());
      for (const [target, archive] of Object.entries(release.archives)) {
        const origin = targets[target]!.libc === 'musl' ? 'https://unofficial-builds.nodejs.org/download/release' : 'https://nodejs.org/dist';
        expect(archive.url.startsWith(`${origin}/v${version}/node-v${version}-`)).toBe(true);
        expect(archive.url).toMatch(/\.(zip|tar\.gz)$/);
        expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});

describe('SERVER_TARGETS mirrors the release workflow', () => {
  const legs = workflow.jobs['package-server']!.strategy!.matrix.include;

  it('builds every target on its runner, the Alpine ones in a container', () => {
    expect(legs.map((leg) => ({ target: leg.target, runner: leg.runner, alpine: leg.alpine === true })).sort((a, b) => String(a.target).localeCompare(String(b.target))))
      .toEqual(Object.entries(targets).map(([target, spec]) => ({ target, runner: spec.runner, alpine: spec.alpine })).sort((a, b) => a.target.localeCompare(b.target)));
    for (const [target, spec] of Object.entries(targets)) expect({ target, alpine: spec.alpine }).toEqual({ target, alpine: spec.libc === 'musl' });
  });

  it('takes the Node version and the pinned Alpine images from the one derivation in verify, whose failure fails the step', () => {
    const verify = workflow.jobs['verify']!;
    expect(verify.outputs).toMatchObject({
      'server-node-version': '${{ steps.server-node.outputs.version }}',
      'server-alpine-build-image': '${{ steps.server-node.outputs.alpine-build-image }}',
      'server-alpine-target-image': '${{ steps.server-node.outputs.alpine-target-image }}',
    });
    expect(verify.steps.find((step) => step.run?.includes('outputs=$(node scripts/server-targets.mjs --github-outputs)\n'))).toBeDefined();
    const job = workflow.jobs['package-server']!;
    expect(job.env).toMatchObject({
      NODE_VERSION: '${{ needs.verify.outputs.server-node-version }}',
      ALPINE_BUILD_IMAGE: '${{ needs.verify.outputs.server-alpine-build-image }}',
      ALPINE_TARGET_IMAGE: '${{ needs.verify.outputs.server-alpine-target-image }}',
    });
    const runs = job.steps.map((step) => step.run ?? '').join('\n');
    expect(runs).toContain('"$ALPINE_BUILD_IMAGE" sh -c');
    expect(runs.match(/--node-version "\$NODE_VERSION"/g)?.length).toBe(4);
  });

  it('pins every Alpine image by digest', () => {
    for (const [version, release] of Object.entries(releases)) expect(release.alpineImage).toMatch(new RegExp(`^node:${version.replaceAll('.', '\\.')}-alpine[\\d.]*@sha256:[0-9a-f]{64}$`));
    expect(ALPINE_TARGET_IMAGE).toMatch(/^alpine:[\d.]+@sha256:[0-9a-f]{64}$/);
    const { alpineImage: _dropped, ...unpinned } = releases['24.22.0']!;
    expect(nodeReleaseProblem(PINNED, { '24.22.0': unpinned })).toMatch(/pins no alpineImage/);
  });

  it('self-tests every leg: on its runner, or for Alpine in the clean image with only the documented prerequisites', () => {
    const steps = workflow.jobs['package-server']!.steps;
    const verifies = steps.filter((step) => step.run?.includes('verify-server-package.mjs'));
    expect(verifies.find((step) => step.if === '${{ !matrix.alpine }}')?.run).toContain('--require-self-test');
    expect(verifies.find((step) => step.if === '${{ matrix.alpine }}')?.run).toContain('--skip-self-test');
    const clean = steps.find((step) => step.run?.includes('"$ALPINE_TARGET_IMAGE" sh -c'));
    expect(clean?.if).toBe('${{ matrix.alpine }}');
    expect(clean?.run).toContain(`apk add --no-cache ${(ALPINE_PREREQUISITES as string[]).join(' ')}\n`);
    expect(clean?.run).toContain('/server/bin/damocles-server self-test');
  });

  it('verifies every leg before uploading it as server-<target>, never to a release', () => {
    const job = workflow.jobs['package-server']!;
    const verify = job.steps.findIndex((step) => step.run?.includes('verify-server-package.mjs'));
    const upload = job.steps.findIndex((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(verify).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(verify);
    expect(job.steps[upload]!.with?.['name']).toBe('server-${{ matrix.target }}');
    expect(JSON.stringify(job)).not.toMatch(/gh release|secrets\./);
  });

  it('runs the loopback specs on each desktop leg with the server package of its platform and arch', () => {
    const include = workflow.jobs['e2e-desktop']!.strategy!.matrix.include;
    for (const leg of include) {
      const desktop = (DESKTOP_TARGETS as Record<string, { os: string; arch: string }>)[leg.target as string]!;
      const server = targets[leg.serverTarget as string];
      expect({ target: leg.target, platform: server?.platform, arch: server?.arch, libc: server?.libc }).toEqual({ target: leg.target, platform: desktop.os, arch: desktop.arch, libc: desktop.os === 'linux' ? 'glibc' : null });
    }
    expect(workflow.jobs['e2e-desktop']!.steps.find((step) => step.run?.includes('--grep @loopback'))?.run).toContain('DAMOCLES_LOOPBACK_PACKAGE');
  });

  it('embeds the manifest of every package before electron-builder runs', () => {
    const steps = workflow.jobs['package-desktop']!.steps;
    const manifest = steps.findIndex((step) => step.run?.includes('build-server.mjs --write-manifest'));
    const builder = steps.findIndex((step) => step.run?.includes('npx electron-builder'));
    expect(manifest).toBeGreaterThan(-1);
    expect(builder).toBeGreaterThan(manifest);
    expect([workflow.jobs['package-desktop']!.needs].flat()).toContain('package-server');
  });
});

describe('--check-server-artifacts', () => {
  const version = '9.8.7';
  const all = Object.keys(targets).map((target) => serverArtifact(target, version) as string);

  it('names a .zip for Windows and a .tar.gz elsewhere', () => {
    expect(serverArtifact('win32-arm64', version)).toBe('damocles-server-9.8.7-win32-arm64.zip');
    expect(serverArtifact('alpine-x64', version)).toBe('damocles-server-9.8.7-alpine-x64.tar.gz');
  });

  it('reports a missing and an extra package and ignores other files', () => {
    const present = [...all.filter((name) => !name.includes('darwin-x64')), 'damocles-server-9.8.7-freebsd-x64.tar.gz', 'Damocles-9.8.7-arm64.zip'];
    expect(serverArtifactProblems(Object.keys(targets), version, present)).toEqual({
      missing: ['damocles-server-9.8.7-darwin-x64.tar.gz'],
      unexpected: ['damocles-server-9.8.7-freebsd-x64.tar.gz'],
    });
    expect(serverArtifactProblems(Object.keys(targets), version, all)).toEqual({ missing: [], unexpected: [] });
  });

  it('exits 1 on a missing and on an extra package, and 0 on the complete set', () => {
    const { version: current } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    const names = Object.keys(targets).map((target) => serverArtifact(target, current) as string);
    const run = (files: string[]) => {
      const dir = mkdtempSync(join(tmpdir(), 'server-artifacts-'));
      try {
        for (const name of files) writeFileSync(join(dir, name), '');
        return spawnSync(process.execPath, [join(ROOT, 'scripts', 'release-targets.mjs'), '--check-server-artifacts', 'all', dir], { encoding: 'utf8' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const missing = run(names.slice(1));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(`Missing server artifacts in`);
    expect(missing.stderr).toContain(names[0]!);
    const extra = run([...names, `damocles-server-${current}-plan9-x64.tar.gz`]);
    expect(extra.status).toBe(1);
    expect(extra.stderr).toContain(`damocles-server-${current}-plan9-x64.tar.gz`);
    expect(run(names).status).toBe(0);
  });
});
