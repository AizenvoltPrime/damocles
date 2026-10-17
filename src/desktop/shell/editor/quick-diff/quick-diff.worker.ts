// The quick diff's line diffs run here, off the shell's main thread (docs/invariants.md names this worker).
import { createQuickDiffHandler, type QuickDiffRequest } from './quick-diff-compute';

const handle = createQuickDiffHandler();

self.addEventListener('message', (event: MessageEvent<QuickDiffRequest>) => {
  const reply = handle(event.data);
  if (reply !== undefined) self.postMessage(reply);
});
