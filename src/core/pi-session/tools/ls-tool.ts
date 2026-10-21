import { access, readdir, stat } from 'node:fs/promises';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import type { AnyToolDefinition } from './any-tool-definition';

/** The `ls` override: pi's ls with its default operations written here, on the bundle's fs (docs/invariants.md "Tool overrides"). */
export function createLsTool(pi: PiCodingAgentModule, cwd: string): ToolDefinition {
  const ls: AnyToolDefinition = pi.createLsToolDefinition(cwd, {
    operations: {
      exists: (absolutePath) => access(absolutePath).then(() => true, () => false),
      stat: (absolutePath) => stat(absolutePath),
      readdir: (absolutePath) => readdir(absolutePath),
    },
  });
  return ls;
}
