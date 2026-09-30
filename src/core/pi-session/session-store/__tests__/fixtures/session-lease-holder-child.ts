// Bundled by session-lease.test.ts and forked: another Damocles process holding a session lease. argv: <sessionId>.
import { acquireSessionLease, releaseSessionLease, type SessionLeaseHolder } from '../../session-lease';

const [sessionId] = process.argv.slice(2);
if (sessionId === undefined) throw new Error('usage: session-lease-holder-child <sessionId>');

const holder: SessionLeaseHolder = { onSessionLeaseLost: (id) => process.send!({ lost: id }) };
process.on('message', (message) => {
  if (message !== 'release') return;
  releaseSessionLease(sessionId, holder);
  process.send!('released');
});
process.send!(acquireSessionLease(sessionId, holder) ? 'held' : 'refused');
