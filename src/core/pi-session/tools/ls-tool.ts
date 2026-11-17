import { access, lstat, readdir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import type { AnyToolDefinition } from './any-tool-definition';
import { networkReach } from '../../local-links';

/**
 * The `ls` override: pi's ls with its default operations written here, on the bundle's fs (docs/invariants.md "Tool overrides").
 * On win32 a child link is followed only when `networkReach` with allowedNetworkHosts keeps it on this computer, else listed from
 * its lstat ("Permissions and plan mode").
 */
export function createLsTool(pi: PiCodingAgentModule, cwd: string, allowedNetworkHosts: () => Promise<ReadonlySet<string>>): ToolDefinition {
  const definition = (childStat: (absolutePath: string) => Promise<Stats>, listed: () => void): AnyToolDefinition =>
    pi.createLsToolDefinition(cwd, {
      operations: {
        exists: (absolutePath) => access(absolutePath).then(() => true, () => false),
        stat: (absolutePath) => childStat(absolutePath),
        readdir: async (absolutePath) => {
          const entries = await readdir(absolutePath);
          listed();
          return entries;
        },
      },
    });
  const ls = definition(stat, () => undefined);
  if (process.platform !== 'win32') return ls;
  return {
    ...ls,
    execute: (...args) => {
      // pi reads the folder once, between its own stat and its children's
      let children = false;
      let hosts: Promise<ReadonlySet<string>> | undefined;
      const childStat = async (absolutePath: string): Promise<Stats> => {
        if (!children) return stat(absolutePath);
        const own = await lstat(absolutePath);
        if (!own.isSymbolicLink()) return own;
        return (await networkReach(absolutePath, await (hosts ??= allowedNetworkHosts()))) === null ? stat(absolutePath) : own;
      };
      return definition(childStat, () => { children = true; }).execute(...args);
    },
  };
}
