// The launcher on the calling thread, for tests: the worker's own request handling, without the thread.
import { abortError, createRemoteProcess, type Launcher, type RemoteProcess } from './launcher';
import type { LauncherEvent, LauncherRequest } from './protocol';
import type { SpawnFunction } from './worker';

export function createInProcessLauncher(deps: { readonly spawn?: SpawnFunction } = {}): Launcher {
  const procs = new Map<number, RemoteProcess>();
  let nextId = 1;
  let nextJobId = 1;
  const deliver = (event: LauncherEvent): void => {
    if (event.type === 'log' || event.type === 'sessionJob' || event.type === 'reaped') return;
    const remote = procs.get(event.id);
    remote?.deliver(event);
    if (event.type === 'error' || event.type === 'close') procs.delete(event.id);
  };
  // Loaded on first use, so a test's vi.mock of child_process or process-tree applies to it.
  let host: Promise<(request: LauncherRequest) => void> | undefined;
  const send = (request: LauncherRequest): void => {
    host ??= import('./worker').then(({ createLauncherHost }) => createLauncherHost({ post: deliver, ...(deps.spawn ? { spawn: deps.spawn } : {}) }));
    void host.then((handle) => handle(request));
  };
  return {
    launch(spec, options = {}) {
      const id = nextId++;
      const remote = createRemoteProcess(id, send, options);
      if (options.signal?.aborted) {
        remote.fail(abortError(options.signal));
        return remote.process;
      }
      procs.set(id, remote);
      const { job, ...rest } = spec;
      send({ type: 'spawn', id, spec: rest, ...(job !== undefined ? { job: { id: job } } : {}) });
      return remote.process;
    },
    createSessionJob() {
      const id = nextJobId++;
      send({ type: 'createSessionJob', job: id });
      let open = true;
      return {
        id,
        dispose: () => {
          if (!open) return;
          open = false;
          send({ type: 'closeSessionJob', job: id });
        },
      };
    },
    dispose: async () => undefined,
  };
}
