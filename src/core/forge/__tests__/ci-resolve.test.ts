import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ForgeService } from '..';
import type { CiRepo } from '../ci-watch';
import { createHarness, type Harness } from './support/harness';
import { CI_UI_FIXTURES } from './support/forge-stub-ci';

// A repository whose account only the access check can settle (two accounts on the server, no binding): while the server
// cannot answer, CI says why instead of showing no chip, and it resolves again once the server answers.

let harness: Harness;
let service: ForgeService;

beforeAll(async () => {
  harness = await createHarness();
  service = harness.service();
  await service.load();
  await service.signIn({ serverId: 'gitlab.com', route: 'token', token: 'glpat-stubAlexiosSApi000000008', agentShells: false });
  await service.signIn({ serverId: 'gitlab.com', route: 'token', token: 'glpat-stubWorkAlexiosApi000001', agentShells: false });
}, 60_000);

afterAll(async () => {
  await harness.close();
});

describe('CI resolution by the access check', () => {
  it('answers an error while the server cannot answer the check, and the pipeline once it can', async () => {
    const url = new URL(harness.stub.gitlab.webUrl);
    const repo: CiRepo = {
      authorityKey: 'local',
      projectKey: 'c:/src/deploy',
      project: 'deploy',
      endpoints: [{ remote: 'origin', fetch: { protocol: 'https', host: url.hostname, port: Number(url.port), path: 'indigital/tools/deploy.git', aliasResolved: false } }],
      branch: CI_UI_FIXTURES.branch,
    };
    harness.stub.gitlab.failAccess = true;
    expect(await service.ci.watch('w', repo, false)).toEqual({ status: 'error', message: { message: 'Could not reach {0}. Check the connection and try again.', args: ['gitlab.com'] } });
    expect(await service.ci.commitStatus(repo, CI_UI_FIXTURES.sha, true)).toMatchObject({ status: 'error' });
    harness.stub.gitlab.failAccess = false;
    expect(await service.ci.jobs('w')).toMatchObject({ status: 'ready', pipeline: { number: 4312 } });
    service.ci.unwatch('w');
  });

  it('maps the remotes against the servers with an account, as history and links do', async () => {
    const gitlab = new URL(harness.stub.gitlab.webUrl);
    const github = new URL(harness.stub.github.webUrl);
    // the branch tracks a remote on github.com, where no account exists; origin is on gitlab.com, where one does
    const repo: CiRepo = {
      authorityKey: 'local',
      projectKey: 'c:/src/deploy',
      project: 'deploy',
      pushRemote: 'mirror',
      endpoints: [
        { remote: 'mirror', fetch: { protocol: 'https', host: github.hostname, port: Number(github.port), path: 'indigital/deploy.git', aliasResolved: false } },
        { remote: 'origin', fetch: { protocol: 'https', host: gitlab.hostname, port: Number(gitlab.port), path: 'indigital/tools/deploy.git', aliasResolved: false } },
      ],
      branch: CI_UI_FIXTURES.branch,
    };
    expect(await service.ci.watch('w2', repo, false)).toMatchObject({ status: 'ready', pipeline: { number: 4312 } });
    expect(service.historyContext(repo)).toMatchObject({ kind: 'gitlab', serverName: 'gitlab.com' });
    expect(service.link(repo, { kind: 'commit', sha: CI_UI_FIXTURES.sha })).toMatchObject({ serverName: 'gitlab.com', remote: 'origin' });
    service.ci.unwatch('w2');
  });
});
