import { describe, it, expect, vi } from 'vitest';
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

type Step = { id?: string; name?: string; uses?: string; run?: string; if?: string; with?: Record<string, string>; 'timeout-minutes'?: number };
type Matrix = { include: Record<string, string | number | boolean>[]; target?: string[]; shard?: number[]; exclude?: { target: string; shard: number }[] };
type Job = { needs?: string | string[]; if?: string; env?: Record<string, string>; permissions?: Record<string, string>; steps: Step[]; strategy?: { matrix: Matrix }; 'timeout-minutes'?: number };
type DesktopSpec = { runner: string; os: string; builder: string; arch: string; channel?: string; appDir: string; executable: string; artifacts: string[] };

const workflowText = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8');
const workflow = parse(workflowText) as { jobs: Record<string, Job> };
// A job that calls a reusable workflow has no steps of its own; the step checks read the called workflow's jobs.
const stepJobs: [string, Job][] = Object.entries(workflow.jobs).flatMap(([name, job]): [string, Job][] => {
  const uses = (job as { uses?: string }).uses;
  if (uses === undefined) return [[name, job]];
  const called = parse(readFileSync(join(__dirname, '..', '..', uses), 'utf8')) as { jobs: Record<string, Job> };
  return Object.entries(called.jobs).map(([inner, calledJob]): [string, Job] => [`${name}/${inner}`, calledJob]);
});
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

// The variables loading a Playwright config reads or sets; it sets ELECTRON_OVERRIDE_DIST_PATH at import on Windows.
const PLAYWRIGHT_CONFIG_ENV = ['CI', 'ELECTRON_OVERRIDE_DIST_PATH', 'DAMOCLES_E2E_REMOTE_TARGETS'] as const;

type PlaywrightConfig = { failOnFlakyTests?: boolean; globalTimeout?: number; workers?: number };

/** playwright.<suite>.config.ts as evaluated with CI set to `ci` and `targets` as the named target suites, leaving the environment as it found it. */
async function loadPlaywrightConfig(ci: string | undefined, suite: 'desktop' | 'remote' = 'desktop', targets = ''): Promise<PlaywrightConfig> {
  const saved = PLAYWRIGHT_CONFIG_ENV.map((key) => [key, process.env[key]] as const);
  if (ci === undefined) delete process.env.CI;
  else process.env.CI = ci;
  process.env.DAMOCLES_E2E_REMOTE_TARGETS = targets;
  try {
    vi.resetModules();
    const config = suite === 'desktop' ? await import('../../playwright.desktop.config') : await import('../../playwright.remote.config');
    return (config as { default: PlaywrightConfig }).default;
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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

  it('uploads every e2e report unless the run was cancelled', () => {
    const uploads = stepJobs.flatMap(([, j]) => j.steps).filter((step) => step.uses?.startsWith('actions/upload-artifact@') && step.with?.name?.startsWith('e2e-report-'));
    expect(uploads).toHaveLength(2);
    for (const step of uploads) {
      expect({ name: step.with!.name, if: step.if, retention: step.with!['retention-days'], missing: step.with!['if-no-files-found'] })
        .toEqual({ name: step.with!.name, if: '${{ !cancelled() }}', retention: 7, missing: 'ignore' });
    }
  });

  it('fails a CI run on a flaky test and ends a hung one with globalTimeout, which a local run lacks', async () => {
    const ci = await loadPlaywrightConfig('1');
    expect(ci.failOnFlakyTests).toBe(true);
    expect(ci.globalTimeout).toBeGreaterThan(0);
    const local = await loadPlaywrightConfig(undefined);
    expect(local.failOnFlakyTests).toBeFalsy();
    expect(local.globalTimeout ?? 0).toBe(0);
  });

  it('loads the Playwright config without leaving its environment behind', async () => {
    const before = PLAYWRIGHT_CONFIG_ENV.map((key) => process.env[key]);
    await loadPlaywrightConfig('1');
    expect(PLAYWRIGHT_CONFIG_ENV.map((key) => process.env[key])).toEqual(before);
  });

  it('leaves package-desktop the packaged-app suite only', () => {
    const runs = workflow.jobs['package-desktop']!.steps.map((step) => step.run ?? '');
    expect(runs.filter((run) => /test:desktop(?!:packaged)/.test(run))).toEqual([]);
    expect(runs.filter((run) => run.includes('test:desktop:packaged'))).toHaveLength(1);
  });
});

// docs/release.md "Time limits": from job start to the suite step, npm ci on windows-11-arm the longest part.
const INSTALL_BUDGET_MIN = 25;
// docs/release.md "Time limits": test:desktop's fetch and builds before Playwright's clock starts, and the HTML report after.
const BUILD_AND_REPORT_BUDGET_MIN = 10;
// docs/release.md "Time limits": what runs after the suite, the e2e-report upload on a failed or timed-out suite.
const UPLOAD_BUDGET_MIN = 5;
// docs/release.md "Time limits": package-desktop's steps after its suite, the installer and N+1 builds and the uploads.
const PACKAGE_AFTER_SUITE_BUDGET_MIN = 10;

describe('the time limits keep a hung suite\'s report (docs/release.md "Time limits")', () => {
  const suites = [
    { job: 'e2e-desktop', suite: /npm run test:desktop(?!:packaged)/, after: UPLOAD_BUDGET_MIN },
    { job: 'package-desktop', suite: /npm run test:desktop:packaged/, after: PACKAGE_AFTER_SUITE_BUDGET_MIN },
  ];

  for (const { job, suite, after } of suites) {
    it(`${job}: the suite step outlasts globalTimeout with its build and report, and the job outlasts install, that step and what follows`, async () => {
      const { globalTimeout } = await loadPlaywrightConfig('1');
      const steps = workflow.jobs[job]!.steps.filter((step) => suite.test(step.run ?? ''));
      expect(steps).toHaveLength(1);
      // A step timeout fails only that step, so the `!cancelled()` report upload still runs; a job timeout cancels it.
      const stepMinutes = steps[0]!['timeout-minutes'];
      expect(stepMinutes, 'the suite step sets timeout-minutes').toBeTypeOf('number');
      expect(stepMinutes! * 60_000).toBeGreaterThanOrEqual(globalTimeout! + BUILD_AND_REPORT_BUDGET_MIN * 60_000);
      // every other step with its own limit, such as e2e-desktop's server package loopback run
      const otherSteps = workflow.jobs[job]!.steps.filter((step) => step !== steps[0]).reduce((total, step) => total + (step['timeout-minutes'] ?? 0), 0);
      expect(workflow.jobs[job]!['timeout-minutes']).toBeGreaterThanOrEqual(INSTALL_BUDGET_MIN + stepMinutes! + otherSteps + after);
    });
  }
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
    expect(windows.length).toBeGreaterThanOrEqual(3);
    const channelOf = (line: string) => {
      if (line.includes('--${{ matrix.arch }}')) return line.includes('-c.publish.channel=${{ matrix.channel }}');
      const arch = /--(x64|arm64)\b/.exec(line)?.[1];
      return arch !== undefined && line.includes(`-c.publish.channel=latest-${arch}`);
    };
    expect(windows.filter((line) => !channelOf(line))).toEqual([]);
  });

  it('gives no electron-builder step a GitHub token', () => {
    for (const [, job] of stepJobs) {
      for (const step of job.steps) {
        if (!step.run?.includes('electron-builder')) continue;
        expect(JSON.stringify(step)).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|secrets\./);
      }
    }
  });
});

// docs/release.md "The verify job": one upstream outage then fails one job, not every leg.
describe('the release workflow downloads the grammars and wake models once', () => {
  // Commands whose npm scripts run fetch:assets: pretest, build, vscode:prepublish (package), test:desktop, test:remote.
  const fetches = /\bnpm (test|run (fetch:assets|build|package|test:desktop|test:remote))\b(?![:\w])/;
  const restores = (step: Step) => step.uses?.startsWith('actions/download-artifact@') === true && step.with?.name === 'fetched-assets';

  it('fetches them in verify alone and uploads them as fetched-assets', () => {
    const steps = workflow.jobs.verify!.steps;
    const fetch = steps.findIndex((step) => step.run?.trim() === 'npm run fetch:assets');
    const upload = steps.findIndex((step) => step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === 'fetched-assets');
    expect(fetch).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(fetch);
    expect(steps.slice(0, fetch).filter((step) => fetches.test(step.run ?? ''))).toEqual([]);
  });

  it('uploads every wake model file the manifest lists, or a restored job fetches the archive again', () => {
    const upload = workflow.jobs.verify!.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === 'fetched-assets')!;
    const globs = upload.with!.path!.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      .map((glob) => new RegExp(`^${glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`));
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'python', 'damocles_voice_sidecar', 'damocles_voice_sidecar', 'models', 'MODEL_MANIFEST.json'), 'utf8')) as {
      wake_model: { files: { filename: string }[] };
    };
    const uncovered = manifest.wake_model.files
      .map(({ filename }) => `python/damocles_voice_sidecar/damocles_voice_sidecar/models/wake/${filename}`)
      .filter((path) => !globs.some((glob) => glob.test(path)));
    expect(uncovered).toEqual([]);
  });

  it('restores them in every other job before its first build or test', () => {
    const late = stepJobs.filter(([name]) => name !== 'verify').flatMap(([name, job]) => {
      const first = job.steps.findIndex((step) => fetches.test(step.run ?? ''));
      if (first === -1) return [];
      const restore = job.steps.findIndex(restores);
      return restore > -1 && restore < first ? [] : [name];
    });
    expect(late).toEqual([]);
    expect(stepJobs.flatMap(([, job]) => job.steps).filter(restores).length).toBeGreaterThanOrEqual(4);
  });
});

describe('the release workflow limits what a compromised action or token can reach', () => {
  const jobs = stepJobs;

  // A tag can be moved to other code; a commit SHA cannot.
  it('pins every action to a full commit SHA', () => {
    const unpinned = jobs.flatMap(([name, job]) => job.steps.filter((step) => step.uses && !/@[0-9a-f]{40}$/.test(step.uses)).map((step) => `${name}: ${step.uses}`));
    expect(unpinned).toEqual([]);
  });

  it('widens the read-only token only for sign-windows, attest and release', () => {
    expect((parse(workflowText) as { permissions?: unknown }).permissions).toEqual({ contents: 'read' });
    expect(Object.fromEntries(jobs.filter(([, job]) => job.permissions).map(([name, job]) => [name, job.permissions]))).toEqual({
      'sign-windows': { contents: 'read', actions: 'read' },
      attest: { contents: 'read', 'id-token': 'write', attestations: 'write' },
      release: { contents: 'write' },
    });
  });

  it('runs no install script in the jobs that hold the SignPath token or the publish tokens', () => {
    for (const name of ['sign-windows', 'release']) {
      const installs = workflow.jobs[name]!.steps.filter((step) => /\bnpm (ci|install)\b/.test(step.run ?? ''));
      expect(installs.map((step) => step.run!.trim())).toEqual(['npm ci --ignore-scripts']);
    }
  });

  it('keeps the OIDC-capable attest job free of secrets and package installs', () => {
    const steps = JSON.stringify(workflow.jobs.attest!.steps);
    expect(steps).not.toMatch(/secrets\.|npm |npx /);
  });
});

describe('the release attaches every desktop artifact', () => {
  const allNames = Object.keys(desktopTargets).flatMap((target) => desktopArtifacts(target, '1.2.3'));

  // package-desktop uploads the macOS and Linux artifacts, sign-windows the signed Windows ones.
  it('uploads every artifact of each target as desktop-<target>', () => {
    const legUpload = workflow.jobs['package-desktop']!.steps.find((step) => step.with?.name === 'desktop-${{ matrix.target }}');
    expect(legUpload?.if).toBe("matrix.os != 'win32'");
    for (const [target, spec] of Object.entries(desktopTargets)) {
      const upload = spec.os === 'win32' ? workflow.jobs['sign-windows']!.steps.find((step) => step.with?.name === `desktop-${target}`) : legUpload;
      expect(upload, `no desktop-${target} upload`).toBeDefined();
      const patterns = globs(upload!.with!.path!.trim().split(/\r?\n/).map((line) => line.trim()));
      const names = desktopArtifacts(target, '1.2.3');
      expect({ target, unmatched: names.filter((name) => !patterns.some((re) => re.test(name))) }).toEqual({ target, unmatched: [] });
      if (spec.os === 'win32') {
        const others = allNames.filter((name) => !names.includes(name));
        expect({ target, foreign: others.filter((name) => patterns.some((re) => re.test(name))) }).toEqual({ target, foreign: [] });
      }
    }
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

  it('waits for the desktop build, signing, end-to-end suites, install and update checks', () => {
    expect((workflow.jobs['remote-e2e'] as { uses?: string }).uses).toBe('./.github/workflows/remote-e2e-nightly.yml');
    const checks = ['package', 'package-desktop', 'sign-windows', 'e2e-desktop', 'remote-e2e', 'reference-e2e', 'verify-desktop-install', 'verify-desktop-install-windows', 'desktop-update-test', 'desktop-update-test-windows'];
    expect(workflow.jobs.release!.needs).toEqual(expect.arrayContaining([...checks, 'attest']));
    expect(workflow.jobs.attest!.needs).toEqual(expect.arrayContaining(checks));
  });

  // A manual run's Windows files are unsigned or test signed, and must never be attested or released.
  it('attests and releases only on a tag push', () => {
    expect(workflow.jobs.attest!.if).toBe("github.event_name == 'push'");
    expect(workflow.jobs.release!.if).toBe("github.event_name == 'push'");
  });

  // docs/release.md "Dry run": a manual run checks everything release reads, so release itself only publishes.
  it('checks the artifacts and the release notes on every run, before attest and release', () => {
    const notes = workflow.jobs['release-notes']!;
    expect(notes.if).toBeUndefined();
    expect(notes.permissions).toBeUndefined();
    expect(JSON.stringify(notes.steps)).not.toMatch(/secrets\./);
    expect(notes.steps.some((step) => step.run?.includes('--check-desktop-artifacts all dist-artifacts'))).toBe(true);
    expect(notes.steps.some((step) => step.run?.includes('CHANGELOG.md'))).toBe(true);
    for (const name of ['attest', 'release']) expect({ name, needs: workflow.jobs[name]!.needs }).toEqual({ name, needs: expect.arrayContaining(['release-notes']) });
    expect(JSON.stringify(workflow.jobs.release!.steps)).not.toMatch(/CHANGELOG\.md|--check-desktop-artifacts/);
  });

  it('builds an update feed for every leg the update test downloads', () => {
    const feeds = include('package-desktop').filter((leg) => leg.updateFeed).map((leg) => leg.target).sort();
    expect([...include('desktop-update-test'), ...include('desktop-update-test-windows')].map((leg) => leg.target).sort()).toEqual(feeds);
  });
});

describe('sign-windows signs the Windows legs (docs/desktop-signing.md)', () => {
  const job = workflow.jobs['sign-windows']!;
  const windowsTargets = Object.entries(desktopTargets).filter(([, spec]) => spec.os === 'win32').map(([target]) => target).sort();

  it('signs a tag with the release certificate and a manual run with the test certificate', () => {
    expect(job.env?.SIGNPATH_SIGNING_POLICY_SLUG).toBe("${{ github.event_name == 'push' && 'release-signing' || 'test-signing' }}");
    const requests = job.steps.filter((step) => step.uses?.startsWith('signpath/github-action-submit-signing-request@'));
    expect(requests.map((step) => step.with!['artifact-configuration-slug'])).toEqual(['app-executables', 'installers']);
    for (const step of requests) expect(step.with!['signing-policy-slug']).toBe('${{ env.SIGNPATH_SIGNING_POLICY_SLUG }}');
  });

  // Every signing spends SignPath's yearly artifact quota, so a manual run signs only when asked.
  it('signs every tag, and a manual run only with its sign input on, which defaults to off', () => {
    const sign = (parse(workflowText) as { on: { workflow_dispatch: { inputs: Record<string, { type: string; default: boolean }> } } }).on.workflow_dispatch.inputs.sign;
    expect(sign).toMatchObject({ type: 'boolean', default: false });
    expect(job.env?.SIGN_WINDOWS).toBe("${{ github.event_name == 'push' || inputs.sign }}");
    const signPathSteps = job.steps.filter((step) =>
      step.uses?.startsWith('signpath/') || step.with?.name?.startsWith('unsigned-win-') || step.run?.includes('check-authenticode.ps1') || step.run?.includes('signed-windows-feed.mjs --rewrite') || step.id === 'collect-executables');
    expect(signPathSteps).toHaveLength(8);
    for (const step of signPathSteps) expect({ name: step.name, if: step.if }).toEqual({ name: step.name, if: "env.SIGN_WINDOWS == 'true'" });
  });

  it('passes both requests the package.json version, which the artifact configurations enforce as each file\'s product version', () => {
    const version = job.steps.find((step) => step.id === 'version');
    expect(version?.run).toContain("require('./package.json').version");
    const requests = job.steps.filter((step) => step.uses?.startsWith('signpath/github-action-submit-signing-request@'));
    for (const step of requests) expect(step.with!.parameters?.trim()).toBe('version: "${{ steps.version.outputs.version }}"');
  });

  // SignPath Foundation signs only files built from this repository; Electron's DLLs, ripgrep, koffi and node-pty ship as published.
  it('submits only Damocles.exe and the SSH askpass trampoline from the apps', () => {
    const upload = job.steps.find((step) => step.id === 'upload-unsigned-executables');
    const request = job.steps.find((step) => step.with?.['artifact-configuration-slug'] === 'app-executables');
    expect(request?.with!['github-artifact-id']).toBe('${{ steps.upload-unsigned-executables.outputs.artifact-id }}');
    const collect = job.steps.find((step) => step.id === 'collect-executables');
    const copied = collect!.run!.split('\n').filter((line) => line.trim().startsWith('cp ')).map((line) => line.trim().split(/\s+/)[1]);
    expect(copied).toEqual(['unsigned/x64/Damocles.exe', 'unsigned/x64/resources/app.asar.unpacked/dist/askpass/ssh-askpass.exe', 'unsigned/arm64/Damocles.exe', 'unsigned/arm64/resources/app.asar.unpacked/dist/askpass/ssh-askpass.exe']);
    expect(upload?.with?.path).toBe('executables/');
  });

  it('receives every Windows leg\'s unpacked app, and no Windows leg uploads an unsigned installer', () => {
    const legUpload = workflow.jobs['package-desktop']!.steps.find((step) => step.with?.name === 'unpacked-${{ matrix.target }}');
    expect(legUpload?.if).toBe("matrix.os == 'win32'");
    const downloads = job.steps.filter((step) => step.uses?.startsWith('actions/download-artifact@')).map((step) => step.with!.name);
    expect(downloads.filter((name) => name?.startsWith('unpacked-')).sort()).toEqual(windowsTargets.map((target) => `unpacked-${target}`));
  });

  it('restores the grammars and wake models before the package check, which compares the apps with them', () => {
    const restore = job.steps.findIndex((step) => step.uses?.startsWith('actions/download-artifact@') && step.with?.name === 'fetched-assets');
    const check = job.steps.findIndex((step) => step.run?.trim().startsWith('node scripts/verify-desktop-package.mjs'));
    expect(restore).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(restore);
  });

  it('is waited on by every job that installs or attaches a Windows installer', () => {
    for (const name of ['verify-desktop-install-windows', 'desktop-update-test-windows', 'attest', 'release']) {
      expect({ name, needs: [workflow.jobs[name]!.needs].flat() }).toEqual({ name, needs: expect.arrayContaining(['sign-windows']) });
    }
  });

  // The macOS and Linux install and update tests run before signing, so their failures spend no quota.
  it('splits the install and update tests at the Windows legs, with the same steps on both sides', () => {
    for (const [before, after, artifact] of [['verify-desktop-install', 'verify-desktop-install-windows', 'artifact'], ['desktop-update-test', 'desktop-update-test-windows', 'target']] as const) {
      expect(include(before).filter((leg) => String(leg[artifact]).includes('win'))).toEqual([]);
      expect(include(after).length).toBeGreaterThan(0);
      expect(include(after).every((leg) => String(leg[artifact]).includes('win'))).toBe(true);
      expect(workflow.jobs[after]!.steps).toEqual(workflow.jobs[before]!.steps);
      expect(workflow.jobs['sign-windows']!.needs).toContain(before);
    }
  });

  // Each signing request spends SignPath's yearly artifact quota, so a run that fails a check must fail before it signs.
  it('waits for every job that does not need the signed files', () => {
    const needsOf = (name: string): string[] => [workflow.jobs[name]!.needs ?? []].flat();
    const ancestors = (name: string): Set<string> => {
      const seen = new Set<string>();
      const visit = (job: string): void => {
        for (const parent of needsOf(job)) if (!seen.has(parent)) { seen.add(parent); visit(parent); }
      };
      visit(name);
      return seen;
    };
    const independent = Object.keys(workflow.jobs).filter((name) => name !== 'sign-windows' && !ancestors(name).has('sign-windows'));
    expect(independent.length).toBeGreaterThan(0);
    expect(independent.filter((name) => !ancestors('sign-windows').has(name))).toEqual([]);
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

describe('the verify job', () => {
  // A tag can name a commit no pull request checked, so the release checks the wire's snapshot itself.
  it('checks the committed protocol snapshot against the contracts', () => {
    expect(workflow.jobs.verify!.steps.some((step) => step.run?.trim() === 'node scripts/protocol-compat.mjs --check')).toBe(true);
  });
});

type Workflow = { permissions?: unknown; jobs: Record<string, Job & { 'runs-on'?: string; strategy?: { 'fail-fast'?: boolean; matrix: Record<string, unknown> } }> };
const readWorkflow = (name: string): Workflow => parse(readFileSync(join(__dirname, '..', '..', '.github', 'workflows', name), 'utf8')) as Workflow;
const prWorkflow = readWorkflow('pr.yml');
const nightlyWorkflow = readWorkflow('remote-e2e-nightly.yml');

// docs/release.md "Time limits": test:remote's builds before Playwright's clock starts (the app, the server packages it was not
// given prebuilt, the fixture images) and the HTML report after.
const REMOTE_BUILD_AND_REPORT_BUDGET_MIN = 15;
const REMOTE_SUITE = /npm run test:remote\b/;
const limitedMinutes = (job: Job): number => job.steps.reduce((total, step) => total + (step['timeout-minutes'] ?? 0), 0);

describe('the remote suites keep a hung run\'s report (docs/release.md "Time limits")', () => {
  const jobs: [string, Job][] = [
    ['pr.yml ssh', prWorkflow.jobs.ssh!],
    ['release.yml reference-e2e', workflow.jobs['reference-e2e']!],
    ['remote-e2e-nightly.yml windows-target', nightlyWorkflow.jobs['windows-target']!],
    ['remote-e2e-nightly.yml darwin-target', nightlyWorkflow.jobs['darwin-target']!],
  ];

  for (const [name, job] of jobs) {
    it(`${name}: each suite step outlasts globalTimeout with test:remote's builds and report, and the job outlasts install, every limited step and each upload`, async () => {
      const { globalTimeout } = await loadPlaywrightConfig('1', 'remote');
      expect(globalTimeout).toBeGreaterThan(0);
      const suites = job.steps.filter((step) => REMOTE_SUITE.test(step.run ?? ''));
      expect(suites.length).toBeGreaterThan(0);
      for (const step of suites) expect(step['timeout-minutes']! * 60_000, step.name).toBeGreaterThanOrEqual(globalTimeout! + REMOTE_BUILD_AND_REPORT_BUDGET_MIN * 60_000);
      expect(job['timeout-minutes']).toBeGreaterThanOrEqual(INSTALL_BUDGET_MIN + limitedMinutes(job) + UPLOAD_BUDGET_MIN * suites.length);
    });
  }

  it('pr.yml ssh-build: the job outlasts install, its two limited build steps and the uploads', () => {
    const job = prWorkflow.jobs['ssh-build']!;
    const builds = job.steps.filter((step) => /reference-package\.mjs .*--out|--build-server-packages/.test(step.run ?? ''));
    expect(builds).toHaveLength(2);
    for (const step of builds) expect(step['timeout-minutes'], step.name).toBeTypeOf('number');
    expect(job['timeout-minutes']).toBeGreaterThanOrEqual(INSTALL_BUDGET_MIN + limitedMinutes(job) + UPLOAD_BUDGET_MIN);
  });

  it('fails a CI run on a flaky test, and runs the target suites, which share the runner account\'s daemon, one test at a time', async () => {
    expect((await loadPlaywrightConfig('1', 'remote')).failOnFlakyTests).toBe(true);
    expect((await loadPlaywrightConfig('1', 'remote', '@windows-target')).workers).toBe(1);
    expect((await loadPlaywrightConfig('1', 'remote', '@darwin-target')).workers).toBe(1);
  });

  it('remote-e2e-nightly.yml windows-target: the PowerShell run reuses the cmd run\'s builds, and the OpenSSH install has its own limit', () => {
    const job = nightlyWorkflow.jobs['windows-target']!;
    expect(job.steps.filter((step) => REMOTE_SUITE.test(step.run ?? '')).map((step) => step.env?.DAMOCLES_E2E_PREBUILT)).toEqual([undefined, 'app,server-packages']);
    expect(job.steps.find((step) => step.run?.includes('Add-WindowsCapability'))?.['timeout-minutes']).toBeTypeOf('number');
  });
});

describe('the pull request ssh jobs', () => {
  const ssh = prWorkflow.jobs.ssh!;
  const build = prWorkflow.jobs['ssh-build']!;
  const suiteAt = ssh.steps.findIndex((step) => REMOTE_SUITE.test(step.run ?? ''));
  const artifactNames = (steps: Step[], action: string): string[] => steps.filter((step) => step.uses?.startsWith(`actions/${action}@`)).map((step) => step.with!.name!).sort();

  it('runs shards 1 to N of the suite, where N is the shard count it passes to Playwright, and reports every shard', () => {
    const matrix = ssh.strategy!.matrix as { shard: number[]; shards: number[] };
    expect(matrix.shards).toEqual([4]);
    expect(matrix.shard).toEqual([1, 2, 3, 4]);
    expect(ssh.strategy!['fail-fast']).toBe(false);
    expect(ssh.steps[suiteAt]!.run).toContain('--shard="$SHARD"');
    expect(ssh.steps[suiteAt]!.env).toMatchObject({ SHARD: '${{ matrix.shard }}/${{ matrix.shards }}' });
  });

  it('builds what every shard shares once, in ssh-build, and each shard downloads all of it before its suite and builds none of it', () => {
    expect(ssh.needs).toBe('ssh-build');
    expect(artifactNames(ssh.steps.slice(0, suiteAt), 'download-artifact')).toEqual(artifactNames(build.steps, 'upload-artifact'));
    expect(artifactNames(build.steps, 'upload-artifact')).toEqual(['fetched-assets', 'ssh-reference-package', 'ssh-server-packages']);
    expect(ssh.steps[suiteAt]!.env?.DAMOCLES_E2E_PREBUILT).toBe('server-packages');
    expect(ssh.steps.filter((step) => /build-server|reference-package\.mjs|fetch:assets/.test(step.run ?? ''))).toEqual([]);
  });

  it('checks the reference tag before it installs or builds anything', () => {
    for (const job of [build, workflow.jobs['reference-e2e']!]) {
      const runs = job.steps.map((step) => step.run?.trim() ?? '');
      const check = runs.indexOf('node e2e/remote/support/reference-package.mjs --ref remote-protocol-ref --check');
      expect(check).toBeGreaterThan(-1);
      expect(check).toBeLessThan(runs.findIndex((run) => /\bnpm ci\b/.test(run)));
    }
  });

  it('uploads each shard\'s report under its own name unless the run was cancelled', () => {
    const uploads = ssh.steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(uploads.map((step) => ({ name: step.with!.name, if: step.if, retention: step.with!['retention-days'], missing: step.with!['if-no-files-found'] })))
      .toEqual([{ name: 'ssh-e2e-report-${{ matrix.shard }}', if: '${{ !cancelled() }}', retention: 7, missing: 'ignore' }]);
  });

  it('keeps the token read-only, persists no credentials, pins every action to a full commit SHA and reads no secret', () => {
    expect(prWorkflow.permissions).toEqual({ contents: 'read' });
    for (const [name, job] of Object.entries(prWorkflow.jobs)) {
      expect({ name, permissions: job.permissions }).toEqual({ name, permissions: undefined });
      for (const step of job.steps.filter((candidate) => candidate.uses !== undefined)) expect(`${name}: ${step.uses}`).toMatch(/@[0-9a-f]{40}$/);
      for (const step of job.steps.filter((candidate) => candidate.uses?.startsWith('actions/checkout@'))) expect({ name, persist: step.with?.['persist-credentials'] }).toEqual({ name, persist: false });
      expect(JSON.stringify(job)).not.toMatch(/secrets\./);
    }
  });

  // A runner image update must not change the rules a pull request is checked against.
  it('runs shellcheck from an image pinned by digest', () => {
    const step = prWorkflow.jobs.shellcheck!.steps.find((candidate) => candidate.run?.includes('shellcheck'));
    expect(step?.run).toMatch(/koalaman\/shellcheck:v[\d.]+@sha256:[0-9a-f]{64}\s/);
  });
});
