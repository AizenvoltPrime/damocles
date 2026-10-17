// The merge editor's three-way alignment runs here, off the shell's main thread (docs/invariants.md names this worker).
import { handleMergeRequest, type MergeRequest } from './merge-model';

self.addEventListener('message', (event: MessageEvent<MergeRequest>) => {
  self.postMessage(handleMergeRequest(event.data));
});
