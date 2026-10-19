import type { TranscriptMessages } from '@earendil-works/pi-ai';
import { loadedPiAi } from '../pi-loader';
import { isMcpToolName } from '../mcp/naming';
import { BUILTIN_DEFERRED_GROUPS } from './deferred-tools';

export interface RestoredDeferredTools {
  /** Loadout names deferrable now, to activate at once. */
  active: Set<string>;
  /** Loadout names not deferrable yet that can become so, which pi too keeps pending until they register or the next run starts. */
  pending: Set<string>;
}

const BUILTIN_DEFERRABLE = new Set(BUILTIN_DEFERRED_GROUPS.flatMap((group) => [...group.names]));

/** Whether a name can ever be deferrable: a built-in group's tool, the MCP resource tools among them, or an MCP tool. */
const canBecomeDeferrable = (name: string): boolean => BUILTIN_DEFERRABLE.has(name) || isMcpToolName(name);

/**
 * The tools a transcript's recorded loadout had declared at the branch tip, replayed by pi-ai's
 * `getCurrentTools` from its `toolsAdded`/`toolsRemoved` system messages, the record pi restores a
 * resumed session from.
 */
export function restoredDeferredTools(messages: TranscriptMessages, deferrable: ReadonlySet<string>): RestoredDeferredTools {
  const piAi = loadedPiAi();
  // `initPiLoader` loads pi-ai with pi, so a live session always has it.
  if (!piAi) throw new Error('pi-ai is not loaded');
  const active = new Set<string>();
  const pending = new Set<string>();
  for (const { name } of piAi.getCurrentTools(messages)) {
    if (deferrable.has(name)) active.add(name);
    else if (canBecomeDeferrable(name)) pending.add(name);
  }
  return { active, pending };
}
