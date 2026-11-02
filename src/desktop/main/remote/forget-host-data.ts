// Forget host's local data (docs/invariants.md "Remote daemon and wire", remote-hosts.json): what main keeps of one host
// outside its record. Every step runs after a failed one and the first failure is thrown, so a failure leaves only that step's
// datum, which Forget host run again removes.
import { promises as fs } from 'node:fs';

export interface ForgetHostDataSteps {
  // its remote engine and the in-memory state main keeps for the host
  readonly dropEngine: () => Promise<void>;
  readonly exitControlMaster: () => Promise<void>;
  // the session mirror's sync under way, which could write into mirrorFolder after its removal
  readonly mirrorIdle: () => Promise<void>;
  readonly mirrorFolder: string;
  // its forwards and waiting link notices
  readonly forgetPorts: () => void;
  readonly engineHalted: () => boolean;
  // this computer's core closes the host's browser context, which holds profileFolder open
  readonly releaseBrowser: () => Promise<void>;
  readonly profileFolder: string;
  // its offline queue and last chats in memory, then its remote-state.json entries
  readonly forgetChats: () => void;
  readonly forgetRemoteState: () => Promise<void>;
  readonly log: (line: string) => void;
}

// a junction or link is removed as itself, never followed
async function removeTree(folder: string): Promise<void> {
  const stat = await fs.lstat(folder).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  });
  if (!stat) return;
  if (stat.isSymbolicLink()) await fs.unlink(folder);
  else await fs.rm(folder, { recursive: true, force: true, maxRetries: 3 });
}

export async function forgetHostData(steps: ForgetHostDataSteps): Promise<void> {
  const failures: unknown[] = [];
  const step = async (work: () => unknown): Promise<boolean> => {
    try {
      await work();
      return true;
    } catch (err) {
      failures.push(err);
      return false;
    }
  };
  await step(steps.dropEngine);
  await step(steps.exitControlMaster);
  if (await step(steps.mirrorIdle)) await step(() => removeTree(steps.mirrorFolder));
  await step(steps.forgetPorts);
  // a halted engine holds no browser context, and the profile of a context still open stays until a later forget
  if (steps.engineHalted() || (await step(steps.releaseBrowser))) await step(() => removeTree(steps.profileFolder));
  await step(steps.forgetChats);
  await step(steps.forgetRemoteState);
  for (const err of failures) steps.log(`[remote] a Forget host step failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  if (failures.length > 0) throw failures[0];
}
