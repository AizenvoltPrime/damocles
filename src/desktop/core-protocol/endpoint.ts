import type { Disposable } from '../../platform/disposable';
import { MAX_ID_CHARS, type Call, type Contract, type Method, type Tables } from './messages';
import { INVALID, type Parser } from './schema';

/** One ordered, bidirectional message channel between main and core. */
export interface CoreTransport {
  post(message: unknown): void;
  onMessage(listener: (raw: unknown) => void): Disposable;
}

/** A message outside the contract. In process it is thrown; with core in its own process it kills core. */
export class CoreProtocolError extends Error {
  override readonly name: string = 'CoreProtocolError';
}

type Envelope =
  | { readonly kind: 'request'; readonly id: number; readonly method: string; readonly params: unknown }
  | { readonly kind: 'response'; readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly kind: 'response'; readonly id: number; readonly ok: false; readonly error: string; readonly fault?: Fault }
  | { readonly kind: 'cancel'; readonly id: number }
  | { readonly kind: 'event'; readonly name: string; readonly payload: unknown }
  | { readonly kind: 'mirror'; readonly topic: string; readonly version: number; readonly patch: unknown }
  | { readonly kind: 'panel'; readonly panelId: string; readonly op: string; readonly payload: unknown };

/** An error class the contract carries by name, with its own fields as data (errors.ts ERROR_CODEC). */
export interface Fault {
  readonly name: string;
  readonly data: unknown;
}

/** Turns a thrown error into a fault the other side rebuilds, and back; a name outside it is a protocol violation. */
export interface ErrorCodec {
  encode(err: unknown): Fault | undefined;
  // undefined: the fault's name or data is not one the contract knows
  decode(fault: Fault, message: string): Error | undefined;
}

const MAX_NAME_CHARS = 64;
const MAX_ERROR_CHARS = 64 * 1024;

const isSeq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
// Names reach log lines (a violation names the message), so they hold no character that could forge one.
const NAME = /^[A-Za-z0-9._-]+$/;
const isName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME_CHARS && NAME.test(value);

function parseEnvelope(raw: unknown): Envelope | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const own = (key: string): unknown => (Object.hasOwn(value, key) ? value[key] : undefined);
  const id = own('id');
  switch (own('kind')) {
    case 'request': {
      const method = own('method');
      return isSeq(id) && isName(method) ? { kind: 'request', id, method, params: own('params') } : undefined;
    }
    case 'response': {
      if (!isSeq(id)) return undefined;
      if (own('ok') === true) return { kind: 'response', id, ok: true, result: own('result') };
      const error = own('error');
      if (own('ok') !== false || typeof error !== 'string' || error.length > MAX_ERROR_CHARS) return undefined;
      const fault = own('fault');
      if (fault === undefined) return { kind: 'response', id, ok: false, error };
      if (typeof fault !== 'object' || fault === null || Array.isArray(fault)) return undefined;
      const name = (fault as Record<string, unknown>)['name'];
      return isName(name) ? { kind: 'response', id, ok: false, error, fault: { name, data: (fault as Record<string, unknown>)['data'] } } : undefined;
    }
    case 'cancel':
      return isSeq(id) ? { kind: 'cancel', id } : undefined;
    case 'event': {
      const name = own('name');
      return isName(name) ? { kind: 'event', name, payload: own('payload') } : undefined;
    }
    case 'mirror': {
      const topic = own('topic');
      const version = own('version');
      return isName(topic) && isSeq(version) ? { kind: 'mirror', topic, version, patch: own('patch') } : undefined;
    }
    case 'panel': {
      const panelId = own('panelId');
      const op = own('op');
      return typeof panelId === 'string' && panelId.length > 0 && panelId.length <= MAX_ID_CHARS && isName(op)
        ? { kind: 'panel', panelId, op, payload: own('payload') }
        : undefined;
    }
    default:
      return undefined;
  }
}

type Key<T> = keyof T & string;
type Params<C extends Contract, M extends Key<C['requests']>> = C['requests'][M] extends Call<infer P, unknown> ? P : never;
type Result<C extends Contract, M extends Key<C['requests']>> = C['requests'][M] extends Call<unknown, infer R> ? R : never;
type Of<T, K extends keyof T> = T[K];

export type PanelEnvelope<T extends object> = { [O in Key<T>]: { readonly op: O; readonly payload: T[O] } }[Key<T>];

/** Out: what this side sends (its requests' results are parsed with it); In: what it receives. */
export interface Endpoint<Out extends Contract, In extends Contract> {
  request<M extends Key<Out['requests']>>(method: M, params: Params<Out, M>, signal?: AbortSignal): Promise<Result<Out, M>>;
  serve<M extends Key<In['requests']>>(method: M, handler: (params: Params<In, M>, signal: AbortSignal) => Result<In, M> | Promise<Result<In, M>>): void;
  emit<E extends Key<Out['events']>>(name: E, payload: Of<Out['events'], E>): void;
  onEvent<E extends Key<In['events']>>(name: E, listener: (payload: Of<In['events'], E>) => void): Disposable;
  // A delta for a topic goes out before any response that depends on it, on this same channel (the ordering rule).
  publish<T extends Key<Out['mirrors']>>(topic: T, patch: Of<Out['mirrors'], T>): void;
  onMirror<T extends Key<In['mirrors']>>(topic: T, listener: (patch: Of<In['mirrors'], T>) => void): Disposable;
  postPanel<O extends Key<Out['panelOps']>>(panelId: string, op: O, payload: Of<Out['panelOps'], O>): void;
  onPanel(listener: (panelId: string, envelope: PanelEnvelope<In['panelOps']>) => void): Disposable;
  // Rejects every pending request; nothing is received after it.
  close(reason: string): void;
}

export interface EndpointOptions<Out extends Contract, In extends Contract> {
  readonly transport: CoreTransport;
  readonly outgoing: Tables<Out>;
  readonly incoming: Tables<In>;
  readonly log: (line: string) => void;
  // in process the violation is thrown; across processes the side that sees it ends the channel (core-process.ts, core-host/index.ts)
  readonly onViolation?: (error: CoreProtocolError) => void;
  readonly errors?: ErrorCodec;
}

interface LooseTables {
  readonly requests: Readonly<Record<string, Method<unknown, unknown> | undefined>>;
  readonly events: Readonly<Record<string, Parser<unknown> | undefined>>;
  readonly mirrors: Readonly<Record<string, Parser<unknown> | undefined>>;
  readonly panelOps: Readonly<Record<string, Parser<unknown> | undefined>>;
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_CHARS);
}

function fireAll<L>(listeners: ReadonlySet<L> | undefined, call: (listener: L) => void, log: (line: string) => void, what: string): void {
  for (const listener of [...(listeners ?? [])]) {
    try {
      call(listener);
    } catch (err) {
      log(`[core-protocol] a ${what} listener threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
  }
}

function listen<L>(map: Map<string, Set<L>>, key: string, listener: L): Disposable {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(listener);
  return { dispose: () => { map.get(key)?.delete(listener); } };
}

export function createEndpoint<Out extends Contract, In extends Contract>(options: EndpointOptions<Out, In>): Endpoint<Out, In> {
  const { transport, log } = options;
  const outgoing = options.outgoing as unknown as LooseTables;
  const incoming = options.incoming as unknown as LooseTables;
  const violation = options.onViolation ?? ((error: CoreProtocolError): void => { throw error; });
  let nextId = 0;
  let closed: string | undefined;
  const pending = new Map<number, Pending>();
  const inflight = new Map<number, AbortController>();
  const handlers = new Map<string, (params: unknown, signal: AbortSignal) => unknown>();
  const eventListeners = new Map<string, Set<(payload: unknown) => void>>();
  const mirrorListeners = new Map<string, Set<(patch: unknown) => void>>();
  const panelListeners = new Set<(panelId: string, envelope: unknown) => void>();
  const sentVersions = new Map<string, number>();
  const receivedVersions = new Map<string, number>();

  const fail = (detail: string): void => violation(new CoreProtocolError(`Core protocol violation: ${detail}`));
  // a table's own entry only, never an inherited one such as 'constructor'
  const own = <T>(table: Readonly<Record<string, T | undefined>>, name: string): T | undefined => (Object.hasOwn(table, name) ? table[name] : undefined);
  const parseWith = (parser: Parser<unknown> | undefined, raw: unknown): { ok: true; value: unknown } | { ok: false } => {
    if (!parser) return { ok: false };
    const value = parser(raw);
    return value === INVALID ? { ok: false } : { ok: true, value };
  };

  const failure = (err: unknown): { ok: false; error: string; fault?: Fault } => {
    const fault = options.errors?.encode(err);
    return { ok: false, error: errorText(err), ...(fault ? { fault } : {}) };
  };

  const respond = (id: number, outcome: { ok: true; result: unknown } | { ok: false; error: string; fault?: Fault }): void => {
    inflight.delete(id);
    if (closed !== undefined) return;
    try {
      transport.post({ kind: 'response', id, ...outcome });
    } catch (err) {
      // a result that cannot cross the channel still settles the request on the other side; Electron's postMessage throws a
      // plain Error for it, structuredClone a DataCloneError
      log(`[core-protocol] response ${id} could not be sent: ${errorText(err)}`);
      transport.post({ kind: 'response', id, ok: false, error: errorText(err) });
    }
  };

  const receiveRequest = (envelope: Extract<Envelope, { kind: 'request' }>): void => {
    const params = parseWith(own(incoming.requests, envelope.method)?.params, envelope.params);
    if (!params.ok || inflight.has(envelope.id)) {
      fail(`request ${envelope.method} (${envelope.id})`);
      return;
    }
    const handler = handlers.get(envelope.method);
    if (!handler) {
      respond(envelope.id, { ok: false, error: `Nothing serves ${envelope.method}` });
      return;
    }
    const controller = new AbortController();
    inflight.set(envelope.id, controller);
    let result: unknown;
    try {
      result = handler(params.value, controller.signal);
    } catch (err) {
      respond(envelope.id, failure(err));
      return;
    }
    Promise.resolve(result).then(
      (value) => respond(envelope.id, { ok: true, result: value }),
      (err: unknown) => respond(envelope.id, failure(err)),
    );
  };

  const receiveResponse = (envelope: Extract<Envelope, { kind: 'response' }>): void => {
    const entry = pending.get(envelope.id);
    if (!entry) {
      fail(`response to unknown request ${envelope.id}`);
      return;
    }
    pending.delete(envelope.id);
    if (!envelope.ok) {
      if (envelope.fault === undefined) {
        entry.reject(new Error(envelope.error));
        return;
      }
      const rebuilt = options.errors?.decode(envelope.fault, envelope.error);
      if (rebuilt) {
        entry.reject(rebuilt);
        return;
      }
      const error = new CoreProtocolError(`Core protocol violation: error ${envelope.fault.name} of ${entry.method}`);
      entry.reject(error);
      violation(error);
      return;
    }
    const result = parseWith(own(outgoing.requests, entry.method)?.result, envelope.result);
    if (result.ok) {
      entry.resolve(result.value);
      return;
    }
    const error = new CoreProtocolError(`Core protocol violation: result of ${entry.method}`);
    entry.reject(error);
    violation(error);
  };

  const receive = (raw: unknown): void => {
    if (closed !== undefined) return;
    const envelope = parseEnvelope(raw);
    if (!envelope) {
      fail('malformed envelope');
      return;
    }
    switch (envelope.kind) {
      case 'request':
        receiveRequest(envelope);
        return;
      case 'response':
        receiveResponse(envelope);
        return;
      case 'cancel':
        // a cancel crossing its response finds nothing in flight
        inflight.get(envelope.id)?.abort();
        return;
      case 'event': {
        const payload = parseWith(own(incoming.events, envelope.name), envelope.payload);
        if (!payload.ok) {
          fail(`event ${envelope.name}`);
          return;
        }
        fireAll(eventListeners.get(envelope.name), (listener) => listener(payload.value), log, envelope.name);
        return;
      }
      case 'mirror': {
        const patch = parseWith(own(incoming.mirrors, envelope.topic), envelope.patch);
        const expected = (receivedVersions.get(envelope.topic) ?? 0) + 1;
        if (!patch.ok || envelope.version !== expected) {
          fail(`mirror ${envelope.topic} v${envelope.version}, expected v${expected}`);
          return;
        }
        receivedVersions.set(envelope.topic, envelope.version);
        fireAll(mirrorListeners.get(envelope.topic), (listener) => listener(patch.value), log, `${envelope.topic} mirror`);
        return;
      }
      case 'panel': {
        const payload = parseWith(own(incoming.panelOps, envelope.op), envelope.payload);
        if (!payload.ok) {
          fail(`panel ${envelope.op}`);
          return;
        }
        fireAll(panelListeners, (listener) => listener(envelope.panelId, { op: envelope.op, payload: payload.value }), log, 'panel');
        return;
      }
    }
  };

  const subscription = transport.onMessage(receive);

  return {
    request: (method, params, signal) => {
      if (closed !== undefined) return Promise.reject(new Error(closed));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const abort = (): void => {
          if (pending.has(id) && closed === undefined) transport.post({ kind: 'cancel', id });
        };
        const settle = (): void => signal?.removeEventListener('abort', abort);
        pending.set(id, {
          method,
          resolve: (value) => { settle(); resolve(value as never); },
          reject: (err) => { settle(); reject(err); },
        });
        try {
          transport.post({ kind: 'request', id, method, params });
        } catch (err) {
          pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    },
    serve: (method, handler) => {
      handlers.set(method, handler as (params: unknown, signal: AbortSignal) => unknown);
    },
    emit: (name, payload) => {
      if (closed === undefined) transport.post({ kind: 'event', name, payload });
    },
    onEvent: (name, listener) => listen(eventListeners, name, listener as (payload: unknown) => void),
    publish: (topic, patch) => {
      if (closed !== undefined) return;
      const version = (sentVersions.get(topic) ?? 0) + 1;
      transport.post({ kind: 'mirror', topic, version, patch });
      sentVersions.set(topic, version);
    },
    onMirror: (topic, listener) => listen(mirrorListeners, topic, listener as (patch: unknown) => void),
    postPanel: (panelId, op, payload) => {
      if (closed === undefined) transport.post({ kind: 'panel', panelId, op, payload });
    },
    onPanel: (listener) => {
      const entry = listener as (panelId: string, envelope: unknown) => void;
      panelListeners.add(entry);
      return { dispose: () => { panelListeners.delete(entry); } };
    },
    close: (reason) => {
      if (closed !== undefined) return;
      closed = reason;
      subscription.dispose();
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
      const rejected = [...pending.values()];
      pending.clear();
      for (const entry of rejected) entry.reject(new Error(reason));
    },
  };
}
