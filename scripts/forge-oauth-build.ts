// The built-in GitHub and GitLab OAuth apps the core-host bundle carries as __DAMOCLES_FORGE_OAUTH__ (esbuild.config.ts), from
// the release workflow's repository variables and secret or a developer's shell. Without them, built-in servers offer the token route only.

export interface ForgeOAuthBuild {
  readonly github?: { readonly clientId: string; readonly clientSecret?: string };
  readonly gitlab?: { readonly clientId: string };
}

const GITHUB_CLIENT_ID = 'DAMOCLES_FORGE_GITHUB_CLIENT_ID';
const GITHUB_CLIENT_SECRET = 'DAMOCLES_FORGE_GITHUB_CLIENT_SECRET';
const GITLAB_CLIENT_ID = 'DAMOCLES_FORGE_GITLAB_CLIENT_ID';
/** Every variable forgeOAuthBuild reads. */
export const FORGE_OAUTH_VARIABLES: readonly string[] = [GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITLAB_CLIENT_ID];

const CLIENT_VALUE = /^[A-Za-z0-9._-]{1,200}$/;

function value(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return undefined;
  if (!CLIENT_VALUE.test(raw)) throw new Error(`${name} is not a valid OAuth client value`);
  return raw;
}

export function forgeOAuthBuild(env: Readonly<Record<string, string | undefined>>): ForgeOAuthBuild {
  const githubId = value(env, GITHUB_CLIENT_ID);
  const githubSecret = value(env, GITHUB_CLIENT_SECRET);
  const gitlabId = value(env, GITLAB_CLIENT_ID);
  if (githubSecret !== undefined && githubId === undefined) throw new Error(`${GITHUB_CLIENT_SECRET} is set without ${GITHUB_CLIENT_ID}`);
  return {
    ...(githubId !== undefined ? { github: { clientId: githubId, ...(githubSecret !== undefined ? { clientSecret: githubSecret } : {}) } } : {}),
    ...(gitlabId !== undefined ? { gitlab: { clientId: gitlabId } } : {}),
  };
}
