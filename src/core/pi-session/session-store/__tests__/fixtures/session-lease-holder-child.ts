// Bundled by session-lease.test.ts and forked: another Damocles process holding a session lease.
// argv: <sessionId> [mode] [panelToken]. Modes:
//   panel      (default) a panel that leaves only when told over IPC.
//   windowless a live extension host with no window: it hands the session over when another process asks.
//   old        a Damocles release from before handoffs: the bare lock, no owner record, never answers.
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as lockfile from 'proper-lockfile';
import { SESSION_LEASE_DIR, acquireSessionLease, releaseSessionLease, type SessionLeaseHolder } from '../../session-lease';

const [sessionId, mode = 'panel', panelToken = null] = process.argv.slice(2);
if (sessionId === undefined) throw new Error('usage: session-lease-holder-child <sessionId> [panel|windowless|old] [panelToken]');

if (mode === 'old') {
  const lockPath = path.join(SESSION_LEASE_DIR, `${sessionId}.lock`);
  fs.mkdirSync(SESSION_LEASE_DIR, { recursive: true });
  lockfile.lockSync(lockPath, { lockfilePath: lockPath, realpath: false, stale: 20_000, update: 2_000 });
  // A 'message' listener keeps the IPC channel, and so the process, alive; nothing else here would.
  process.on('message', () => undefined);
  process.send!('held');
} else {
  const holder: SessionLeaseHolder = {
    onSessionLeaseLost: (id) => process.send!({ lost: id }),
    sessionLeasePanelToken: () => panelToken,
    ...(mode === 'windowless'
      ? {
          onSessionReleaseRequested: async (id: string) => {
            releaseSessionLease(id, holder);
            process.send!('handed-off');
          },
        }
      : {}),
  };
  process.on('message', (message) => {
    if (message !== 'release') return;
    releaseSessionLease(sessionId, holder);
    process.send!('released');
  });
  process.send!(acquireSessionLease(sessionId, holder) ? 'held' : 'refused');
}
