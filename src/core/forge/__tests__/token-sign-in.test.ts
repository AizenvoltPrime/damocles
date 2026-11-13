import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createForgeHttp } from '../http';
import { signInWithToken } from '../oauth/token-sign-in';
import { providerFor } from '../providers/provider';
import { createServerRegistry } from '../servers';
import { createTokenStore } from '../accounts/token-store';
import { ForgeSignInError, type ForgeServer } from '../types';
import { createHarness, type Harness } from './support/harness';

const MISSING = 'This token is missing the {0} scope. Create one with the scopes above and try again.';

let harness: Harness;
let github: ForgeServer;
let gitlab: ForgeServer;

beforeAll(async () => {
  harness = await createHarness();
  const deps = harness.deps();
  const registry = createServerRegistry({ forgeDir: harness.forgeDir, tokens: createTokenStore(harness.secrets, () => undefined), buildOAuth: {}, overrides: deps.overrides!, log: () => undefined });
  await registry.load();
  github = registry.get('github.com')!;
  gitlab = registry.get('gitlab.com')!;
});

afterAll(async () => {
  await harness.close();
});

const http = () => createForgeHttp({ fetch: harness.fetch, userAgent: 'Damocles/test', log: () => undefined });
const refusal = async (server: ForgeServer, token: string): Promise<unknown> => {
  const error = await signInWithToken(http(), server, providerFor(server.kind), token).catch((err: unknown) => err);
  expect(error).toBeInstanceOf(ForgeSignInError);
  return (error as ForgeSignInError).text;
};

describe('token sign-in', () => {
  it('signs in work-alexios on gitlab.com with an api token', async () => {
    const { user, grant } = await signInWithToken(http(), gitlab, providerFor('gitlab'), ' glpat-stubWorkAlexiosApi000001 ');
    expect(user).toMatchObject({ login: 'work-alexios', id: '2002' });
    expect(grant.tokens).toEqual({ access: 'glpat-stubWorkAlexiosApi000001', tokenType: 'personal' });
    expect(grant.scopes).toEqual(['api']);
  });

  it('refuses a GitLab token without api with the Git hosting section\'s exact text', async () => {
    expect(await refusal(gitlab, 'glpat-stubWorkAlexiosRead00002')).toEqual({ message: MISSING, args: ['api'] });
  });

  it('refuses a GitLab bot token whose api scope does not cover git over HTTP', async () => {
    expect(await refusal(gitlab, 'glpat-stubProjectBotApiOnly003')).toEqual({ message: MISSING, args: ['write_repository'] });
  });

  it('checks a classic GitHub token\'s X-OAuth-Scopes for repo and a fine-grained one by GET /user only', async () => {
    expect(await refusal(github, 'ghp_stubAstefanopoulosNoRepo00000002')).toEqual({ message: MISSING, args: ['repo'] });
    await expect(signInWithToken(http(), github, providerFor('github'), 'ghp_stubAstefanopoulosRepo0000000001')).resolves.toMatchObject({ user: { login: 'astefanopoulos' } });
    await expect(signInWithToken(http(), github, providerFor('github'), 'github_pat_stubFineGrainedAstefAdmin000003')).resolves.toMatchObject({ user: { login: 'astef-admin' }, grant: { scopes: [] } });
  });

  it('says the server refused an unknown token, and asks for a token when the field is empty', async () => {
    expect(await refusal(gitlab, 'glpat-unknown-token-0000000000')).toEqual({ message: 'The server refused this token. Check that you copied all of it and that it has not expired.' });
    expect(await refusal(gitlab, '   ')).toEqual({ message: 'Paste a token first.' });
    expect(await refusal(gitlab, 'two words')).toEqual({ message: 'That is not a token. Paste the whole token, with nothing before or after it.' });
  });

  it('opens a token page prefilled with the name and scopes', () => {
    expect(providerFor('gitlab').tokenPage(gitlab)).toBe(`${harness.stub.gitlab.webUrl}/-/user_settings/personal_access_tokens?name=Damocles&scopes=api`);
    expect(providerFor('github').tokenPage(github)).toBe(`${harness.stub.github.webUrl}/settings/tokens/new?description=Damocles&scopes=repo%2Cworkflow%2Cread%3Auser%2Cuser%3Aemail%2Cread%3Aorg`);
  });
});
