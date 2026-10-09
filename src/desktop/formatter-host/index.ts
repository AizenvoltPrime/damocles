// The formatter host (D29): an Electron utility process, one per project root, that runs the project's own
// Prettier through its Node API. Main resolved and confined every path it sends, and kills this process on a timeout.
import { realpathSync } from 'node:fs';
import { confineModules } from './confine-modules';
import { formatRequest, type PrettierApi } from './format-request';
import { parseHostRequest, type HostReply } from './protocol';

// Before any of the project's code loads: main starts this process with its cwd at the root's real path.
const refused = confineModules(realpathSync.native(process.cwd()));

function post(reply: HostReply): void {
  process.parentPort.postMessage(reply);
}

process.parentPort.on('message', (event) => {
  const request = parseHostRequest(event.data);
  // Main builds every request; one outside the contract is a bug, and this exit fails every request main has pending here.
  if (!request) throw new Error('the formatter host received a malformed request');
  const deps = {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the project's own Prettier, which main found at run time
    load: (entry: string) => require(entry) as PrettierApi,
    refused,
    loaded: () => post({ id: request.id, kind: 'loaded' }),
  };
  void formatRequest(request, deps).then(post);
});
