import { createRequire } from 'node:module';
import * as path from 'node:path';
import { build } from 'esbuild';
import type { registryTerminalEnvironment } from '../../../src/desktop/main/workspace/windows-terminal-environment';
import { REPO_ROOT } from './hermetic';

// Under the repo, so the bundle's koffi resolves from node_modules.
export const REGISTRY_ENVIRONMENT_BUNDLE = path.join(REPO_ROOT, 'dist', 'e2e', 'registry-environment.cjs');

/**
 * registryTerminalEnvironment, from a CommonJS bundle: it loads koffi through require, which Playwright's ES module loader
 * leaves unbound (docs/invariants.md "No source Playwright loads reads a CommonJS global").
 */
export async function loadRegistryTerminalEnvironment(outfile: string = REGISTRY_ENVIRONMENT_BUNDLE): Promise<typeof registryTerminalEnvironment> {
  await build({
    entryPoints: [path.join(REPO_ROOT, 'src', 'desktop', 'main', 'workspace', 'windows-terminal-environment.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile,
    packages: 'external',
    logLevel: 'warning',
  });
  const loaded = createRequire(import.meta.url)(outfile) as { registryTerminalEnvironment: typeof registryTerminalEnvironment };
  return loaded.registryTerminalEnvironment;
}
