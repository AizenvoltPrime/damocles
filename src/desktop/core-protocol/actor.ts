// The acting client: the client whose request or panel message the work in progress came from (a daemon's clients only).
import { AsyncLocalStorage } from 'node:async_hooks';

export interface ActorContext {
  run<T>(actor: string | undefined, body: () => T): T;
  // undefined outside every served request and panel message, and inside one that named no actor
  current(): string | undefined;
}

export function createActorContext(): ActorContext {
  const store = new AsyncLocalStorage<string | undefined>();
  return {
    run: (actor, body) => store.run(actor, body),
    current: () => store.getStore(),
  };
}

// This process's: a daemon's core runs what it serves under it and stamps it on what it sends; the daemon stamps what it forwards.
export const processActor: ActorContext = createActorContext();

/** The client a daemon's core is acting for now; undefined on a local core and outside every client's request. */
export function currentActor(): string | undefined {
  return processActor.current();
}
