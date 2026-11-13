import { describe, expect, it, vi } from 'vitest';
import { forgeOAuthBuild } from '../forge-oauth-build.ts';

describe('forgeOAuthBuild', () => {
  it('is empty without the variables, so built-in servers offer the token route only', () => {
    expect(forgeOAuthBuild({})).toEqual({});
    expect(forgeOAuthBuild({ DAMOCLES_FORGE_GITHUB_CLIENT_ID: '  ' })).toEqual({});
  });

  it('carries the GitHub app with its secret and the GitLab app', () => {
    expect(forgeOAuthBuild({
      DAMOCLES_FORGE_GITHUB_CLIENT_ID: 'Ov23liAbc',
      DAMOCLES_FORGE_GITHUB_CLIENT_SECRET: '0123456789abcdef',
      DAMOCLES_FORGE_GITLAB_CLIENT_ID: 'abcdef0123',
    })).toEqual({ github: { clientId: 'Ov23liAbc', clientSecret: '0123456789abcdef' }, gitlab: { clientId: 'abcdef0123' } });
  });

  it('fails the build on a malformed value', () => {
    expect(() => forgeOAuthBuild({ DAMOCLES_FORGE_GITHUB_CLIENT_ID: 'id with space' })).toThrow(/not a valid/);
    expect(() => forgeOAuthBuild({ DAMOCLES_FORGE_GITLAB_CLIENT_ID: 'id/slash' })).toThrow(/not a valid/);
    expect(() => forgeOAuthBuild({ DAMOCLES_FORGE_GITHUB_CLIENT_SECRET: 'secret' })).toThrow(/without/);
  });
});

describe('__DAMOCLES_FORGE_OAUTH__', () => {
  it('is defined only in Damocles Core\'s bundle, empty except in the desktop build, so a server package\'s core carries none', async () => {
    const { DESKTOP_BUNDLES, SERVER_BUNDLES, EXTENSION_BUNDLES, desktopBuildBundles } = await import('../../esbuild.config.ts');
    const defining = (bundles: readonly { outfile: string; define?: Record<string, string> }[]) =>
      bundles.filter((bundle) => bundle.define !== undefined && '__DAMOCLES_FORGE_OAUTH__' in bundle.define);
    const values = (bundles: readonly { outfile: string; define?: Record<string, string> }[]) => defining(bundles).map((bundle) => [bundle.outfile, bundle.define!['__DAMOCLES_FORGE_OAUTH__']]);
    expect(values(DESKTOP_BUNDLES)).toEqual([['dist/core-host.js', '{}']]);
    expect(defining(EXTENSION_BUNDLES)).toEqual([]);
    expect(values(SERVER_BUNDLES)).toEqual([['dist/core-host.js', '{}']]);
    expect(values(desktopBuildBundles({ DAMOCLES_FORGE_GITLAB_CLIENT_ID: 'abcdef0123' }))).toEqual([['dist/core-host.js', '{"gitlab":{"clientId":"abcdef0123"}}']]);
  });

  it('is read only when the desktop build runs, so a malformed value fails that build and no import of the config', async () => {
    const config = await import('../../esbuild.config.ts');
    expect(() => config.desktopBuildBundles({ DAMOCLES_FORGE_GITHUB_CLIENT_ID: 'id with space' })).toThrow(/not a valid/);
    vi.resetModules();
    vi.stubEnv('DAMOCLES_FORGE_GITHUB_CLIENT_ID', 'id with space');
    try {
      await expect(import('../../esbuild.config.ts')).resolves.toHaveProperty('DESKTOP_BUNDLES');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
