import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
// @ts-expect-error -- plain .mjs helper, no types
import { RELEASE_TARGETS, MIN_VSIX_BYTES, DESKTOP_TARGETS, DESKTOP_ARTIFACT_PATTERN, desktopArtifacts, desktopArtifactProblems } from '../release-targets.mjs';

/**
 * `scripts/release-targets.mjs` and `.github/workflows/release.yml` describe the same release matrix,
 * and the workflow cannot import the module (Actions resolves `strategy.matrix` before any JS runs).
 * Drift is otherwise silent and only shows up as a released artifact missing its ripgrep binary, or a
 * desktop installer the release never attaches, so this is the seam that reports it.
 */

type Step = { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, string> };
type Matrix = { include: Record<string, string | number | boolean>[]; target?: string[]; shard?: number[]; exclude?: { target: string; shard: number }[] };
type Job = { needs?: string | string[]; permissions?: Record<string, string>; steps: Step[]; strategy?: { matrix: Matrix } };
type DesktopSpec = { runner: string; os: string; builder: string; arch: string; channel?: string; appDir: string; executable: string; artifacts: string[] };

const workflowText = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8');
const workflow = parse(workflowText) as { jobs: Record<string, Job> };
const desktopTargets = DESKTOP_TARGETS as Record<string, DesktopSpec>;

function include(job: string): Record<string, string | number | boolean>[] {
  const legs = workflow.jobs[job]?.strategy?.matrix.include;
  if (!legs) throw new Error(`release.yml has no matrix for job ${job}`);
  return legs;
}

/** The `dist-artifacts/` globs of the release job's "Create GitHub Release" step, in order. */
function releaseAssetGlobs(): string[] {
  const create = workflow.jobs.release!.steps.find((step) => step.run?.includes('gh release create'));
  if (!create) throw new Error('release.yml has no gh release create step');
  return create.run!.split(/\r?\n/).map((line) => line.trim().replace(/\s*\\$/, '')).filter((line) => line.startsWith('dist-artifacts/'));
}

/** The file globs an upload-artifact or `gh release create` step names, as anchored regexes over a file name. */
function globs(lines: string[]): RegExp[] {
  return lines.map((glob) => new RegExp(`^${glob.split('/').pop()!.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
}

describe('release-targets.mjs mirrors the release workflow VSIX matrix', () => {
  const legs = include('package');

  it('covers exactly the same targets', () => {
    expect(legs.map((leg) => leg.target).sort()).toEqual(Object.keys(RELEASE_TARGETS).sort());
  });

  it('agrees on every ripgrep package and binary name', () => {
    for (const leg of legs) {
      const spec = RELEASE_TARGETS[leg.target as string];
      expect({ target: leg.target, rgPkg: leg.rgPkg, rgBin: leg.rgBin }).toEqual({ target: leg.target, rgPkg: spec.rgPkg, rgBin: spec.rgBin });
    }
  });

  it('agrees on the suspiciously-small VSIX floor', () => {
    const floor = /-lt\s+(\d+)\s*\]/.exec(workflowText)?.[1];
    expect(floor).toBeDefined();
    expect(Number(floor)).toBe(MIN_VSIX_BYTES);
  });

  it('marks every musl target as one the release workflow builds in a container', () => {
    // The local builder refuses a musl target on a glibc distro; CI achieves the same by running
    // those legs in node:24-alpine. If a target stopped being containerised, the two would diverge.
    for (const [target, spec] of Object.entries(RELEASE_TARGETS as Record<string, { libc?: string }>)) {
      if (spec.libc !== 'musl') continue;
      const leg = legs.find((l) => l.target === target);
      expect(leg, `${target} missing from the workflow matrix`).toBeDefined();
      expect(leg!.alpineContainer).toBe(true);
    }
  });
});

describe('release-targets.mjs mirrors the release workflow desktop matrix', () => {
  const legs = include('package-desktop');

  it('covers exactly the same targets', () => {
    expect(legs.map((leg) => leg.target).sort()).toEqual(Object.keys(desktopTargets).sort());
  });

  it('agrees on runner, platform, arch, channel and packaged paths for every leg', () => {
    for (const leg of legs) {
      const spec = desktopTargets[leg.target as string]!;
      const { artifacts: _artifacts, ...columns } = spec;
      expect({ target: leg.target, runner: leg.runner, os: leg.os, builder: leg.builder, arch: leg.arch, channel: leg.channel, appDir: leg.appDir, executable: leg.executable })
        .toEqual({ target: leg.target, channel: undefined, ...columns });
    }
  });

  it('builds each desktop target on the runner its VSIX leg uses', () => {
    const vsixRunner = Object.fromEntries(include('package').filter((leg) => !leg.alpineContainer).map((leg) => [leg.target, leg.runner]));
    const vsixTarget: Record<string, string> = { win32: 'win32', darwin: 'darwin', linux: 'linux' };
    for (const [target, spec] of Object.entries(desktopTargets)) {
      expect({ target, runner: spec.runner }).toEqual({ target, runner: vsixRunner[`${vsixTarget[spec.os]}-${spec.arch}`] });
    }
  });

  it('gives each Windows arch its own update channel and feed file', () => {
    for (const [target, spec] of Object.entries(desktopTargets)) {
      if (spec.os !== 'win32') {
        expect({ target, channel: spec.channel }).toEqual({ target, channel: undefined });
        continue;
      }
      expect(spec.channel).toBe(`latest-${spec.arch}`);
      expect(desktopArtifacts(target, '1.2.3')).toContain(`${spec.channel}.yml`);
    }
  });

  it('never lets two legs produce the same file name', () => {
    const names = Object.keys(desktopTargets).flatMap((target) => desktopArtifacts(target, '1.2.3'));
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('the dev end-to-end suite runs in shards on every desktop target', () => {
  const job = workflow.jobs['e2e-desktop'];
  const matrix = job?.strategy?.matrix;

  it('covers exactly the desktop targets, each on its package-desktop runner and platform', () => {
    expect(matrix?.target?.slice().sort()).toEqual(Object.keys(desktopTargets).sort());
    for (const leg of matrix!.include) {
      const spec = desktopTargets[leg.target as string]!;
      expect({ target: leg.target, runner: leg.runner, os: leg.os }).toEqual({ target: leg.target, runner: spec.runner, os: spec.os });
    }
  });

  it('runs shards 1 to N of each target, where N is the shard count it passes to Playwright', () => {
    for (const leg of matrix!.include) {
      const shards = matrix!.shard!.filter((shard) => !matrix!.exclude?.some((ex) => ex.target === leg.target && ex.shard === shard));
      expect({ target: leg.target, shards }).toEqual({ target: leg.target, shards: Array.from({ length: leg.shards as number }, (_, i) => i + 1) });
    }
    const suite = job!.steps.find((step) => step.run?.includes('npm run test:desktop'));
    expect(suite?.run).toContain('--shard="$SHARD"');
    expect(JSON.stringify(suite)).toContain('${{ matrix.shard }}/${{ matrix.shards }}');
  });

  it('leaves package-desktop the packaged-app suite only', () => {
    const runs = workflow.jobs['package-desktop']!.steps.map((step) => step.run ?? '');
    expect(runs.filter((run) => /test:desktop(?!:packaged)/.test(run))).toEqual([]);
    expect(runs.filter((run) => run.includes('test:desktop:packaged'))).toHaveLength(1);
  });
});

describe('the release workflow runs electron-builder safely', () => {
  const invocations = workflowText.split(/\r?\n/).filter((line) => /npx electron-builder\b/.test(line));

  it('finds the invocations (guards the filter itself)', () => {
    expect(invocations.length).toBeGreaterThanOrEqual(4);
  });

  // Without it electron-builder publishes on a CI tag build and races the release job.
  it('passes --publish never on every invocation', () => {
    expect(invocations.filter((line) => !line.includes('--publish never'))).toEqual([]);
  });

  it('passes the per-arch channel on every Windows invocation', () => {
    const windows = invocations.filter((line) => line.includes('--win'));
    expect(windows.length).toBeGreaterThanOrEqual(2);
    expect(windows.filter((line) => !line.includes('-c.publish.channel=${{ matrix.channel }}'))).toEqual([]);
  });

  it('gives no electron-builder step a GitHub token', () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        if (!step.run?.includes('electron-builder')) continue;
        expect(JSON.stringify(step)).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|secrets\./);
      }
    }
  });
});

describe('the release workflow limits what a compromised action or token can reach', () => {
  const jobs = Object.entries(workflow.jobs);

  // A tag can be moved to other code; a commit SHA cannot.
  it('pins every action to a full commit SHA', () => {
    const unpinned = jobs.flatMap(([name, job]) => job.steps.filter((step) => step.uses && !/@[0-9a-f]{40}$/.test(step.uses)).map((step) => `${name}: ${step.uses}`));
    expect(unpinned).toEqual([]);
  });

  it('widens the read-only token only for attest and release', () => {
    expect((parse(workflowText) as { permissions?: unknown }).permissions).toEqual({ contents: 'read' });
    expect(Object.fromEntries(jobs.filter(([, job]) => job.permissions).map(([name, job]) => [name, job.permissions]))).toEqual({
      attest: { contents: 'read', 'id-token': 'write', attestations: 'write' },
      release: { contents: 'write' },
    });
  });

  it('keeps the OIDC-capable attest job free of secrets and package installs', () => {
    const steps = JSON.stringify(workflow.jobs.attest!.steps);
    expect(steps).not.toMatch(/secrets\.|npm |npx /);
  });
});

describe('the release attaches every desktop artifact', () => {
  const allNames = Object.keys(desktopTargets).flatMap((target) => desktopArtifacts(target, '1.2.3'));

  it('each leg uploads every artifact it produces', () => {
    const upload = workflow.jobs['package-desktop']!.steps.find((step) => step.with?.name === 'desktop-${{ matrix.target }}');
    expect(upload).toBeDefined();
    const patterns = globs(upload!.with!.path!.trim().split(/\r?\n/).map((line) => line.trim()));
    expect(allNames.filter((name) => !patterns.some((re) => re.test(name)))).toEqual([]);
  });

  it('gh release create names every artifact', () => {
    const patterns = globs(releaseAssetGlobs());
    expect(allNames.filter((name) => !patterns.some((re) => re.test(name)))).toEqual([]);
  });

  it('attests exactly the files the release attaches', () => {
    const attest = workflow.jobs.attest!.steps.find((step) => step.uses?.startsWith('actions/attest-build-provenance@'));
    expect(attest).toBeDefined();
    expect(attest!.with!['subject-path']!.trim().split(/\r?\n/).map((line) => line.trim())).toEqual(releaseAssetGlobs());
  });

  it('waits for the desktop build, end-to-end suite, install and update checks', () => {
    expect(workflow.jobs.release!.needs).toEqual(expect.arrayContaining(['package', 'package-desktop', 'e2e-desktop', 'verify-desktop-install', 'desktop-update-test', 'attest']));
    expect(workflow.jobs.attest!.needs).toEqual(expect.arrayContaining(['package', 'package-desktop', 'e2e-desktop', 'verify-desktop-install', 'desktop-update-test']));
  });

  it('builds an update feed for every leg the update test downloads', () => {
    const feeds = include('package-desktop').filter((leg) => leg.updateFeed).map((leg) => leg.target).sort();
    expect(include('desktop-update-test').map((leg) => leg.target).sort()).toEqual(feeds);
  });
});

describe('desktopArtifactProblems', () => {
  it('passes a complete leg and ignores files that are not release artifacts', () => {
    const present = [...desktopArtifacts('win-x64', '2.0.0'), 'builder-debug.yml', 'builder-effective-config.yaml', 'win-unpacked'];
    expect(desktopArtifactProblems(['win-x64'], '2.0.0', present)).toEqual({ missing: [], unexpected: [] });
  });

  it('reports a missing feed file and a renamed installer', () => {
    const present = ['Damocles Setup 2.0.0.exe', 'Damocles-Setup-2.0.0-x64.exe.blockmap'];
    expect(desktopArtifactProblems(['win-x64'], '2.0.0', present)).toEqual({
      missing: ['Damocles-Setup-2.0.0-x64.exe', 'latest-x64.yml'],
      unexpected: ['Damocles Setup 2.0.0.exe'],
    });
  });

  it('treats every artifact name as a release artifact', () => {
    const names = Object.keys(desktopTargets).flatMap((target) => desktopArtifacts(target, '1.2.3'));
    expect(names.filter((name) => !DESKTOP_ARTIFACT_PATTERN.test(name))).toEqual([]);
  });
});

describe('DESKTOP_TARGETS agrees with electron-builder.yml', () => {
  const config = parse(readFileSync(join(__dirname, '..', '..', 'electron-builder.yml'), 'utf8')) as {
    productName: string; nsis: { artifactName: string }; mac: { artifactName: string };
    linux: { executableName: string };
  };
  const name = (template: string, arch: string, ext: string) =>
    template.replaceAll('${productName}', config.productName).replaceAll('${version}', '1.2.3').replaceAll('${arch}', arch).replaceAll('${ext}', ext);

  it('names the Windows and macOS installers as the config does', () => {
    for (const [target, spec] of Object.entries(desktopTargets)) {
      const artifacts = desktopArtifacts(target, '1.2.3');
      if (spec.os === 'win32') expect(artifacts).toContain(name(config.nsis.artifactName, spec.arch, 'exe'));
      if (spec.os === 'darwin') {
        expect(artifacts).toContain(name(config.mac.artifactName, spec.arch, 'dmg'));
        expect(artifacts).toContain(name(config.mac.artifactName, spec.arch, 'zip'));
      }
    }
  });

  it('points at the configured executable name', () => {
    for (const spec of Object.values(desktopTargets)) {
      const exe = spec.executable.split('/').pop();
      if (spec.os === 'win32') expect(exe).toBe(`${config.productName}.exe`);
      if (spec.os === 'darwin') expect(exe).toBe(config.productName);
      if (spec.os === 'linux') expect(exe).toBe(config.linux.executableName);
    }
  });
});
