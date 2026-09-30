// Bundled by folder-repo.cross-process.test.ts and forked; argv: <cwd> <sessionId> <sessionFile> <turns> <resultFile>.
import * as fs from 'fs';
import * as path from 'path';
import { AutoCheckpointProducer } from '../../auto-checkpoint';

const [cwd, sessionId, sessionFile, turnsArg, resultFile] = process.argv.slice(2);
if (!cwd || !sessionId || !sessionFile || !turnsArg || !resultFile) {
  throw new Error('usage: checkpoint-writer-child <cwd> <sessionId> <sessionFile> <turns> <resultFile>');
}

async function run(cwd: string, sessionId: string, sessionFile: string, turns: number, resultFile: string): Promise<void> {
  const producer = new AutoCheckpointProducer({
    sessionId,
    sessionFile,
    cwd,
    maxFileSizeBytes: () => 25 * 1024 * 1024,
    createTurnId: () => `turn-${sessionId}`,
    now: () => new Date(),
  });
  const records: unknown[] = [];
  for (let i = 0; i < turns; i++) {
    const started = await producer.turnStart({ userEntryId: `${sessionId}-u${i}`, prompt: `turn ${i}` });
    if (!started.ok) throw new Error(`turn ${i} baseline failed: ${started.message}`);
    fs.writeFileSync(path.join(cwd, `${sessionId}-${i}.txt`), `written by ${sessionId} in turn ${i}\n`);
    const finalized = await producer.finalizeRun();
    if (!finalized.ok) throw new Error(`turn ${i} finalize failed`);
    records.push(finalized.record);
  }
  fs.writeFileSync(resultFile, JSON.stringify(records));
}

// The parent sends 'go' to every child at once so both contend for the folder repo from the first turn.
process.once('message', () => {
  run(cwd, sessionId, sessionFile, Number(turnsArg), resultFile).then(
    () => process.exit(0),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    },
  );
});
process.send!('ready');
