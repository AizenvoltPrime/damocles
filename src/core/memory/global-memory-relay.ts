import * as crypto from 'node:crypto';
import type { Disposable } from '../../platform/disposable';
import type { RemoteHost } from '../../platform/remote-host';
import { LocalizedError, type LocalizedText } from '../../shared/localized-text';
import {
  CLIENT_FEATURE_MISSING,
  CLIENT_MEMORY_OFF,
  CREDENTIAL_CLIENT_ABSENT,
  GLOBAL_MEMORY_HOLD_MS,
  globalMemoryWriteFits,
  listedAfter,
  MAX_GLOBAL_MEMORY_APPLY_BYTES,
  MAX_GLOBAL_MEMORY_ID_CHARS,
  MAX_GLOBAL_MEMORY_LABEL_CHARS,
  MAX_GLOBAL_MEMORY_TAGS,
  MAX_HELD_MEMORY_QUEUES,
  MAX_RELAYED_MEMORIES,
  type ClientGlobalProfile,
  type GlobalMemoryListCursor,
  type GlobalMemoryListPage,
  type GlobalMemoryResolution,
  type GlobalMemorySearchFilters,
  type GlobalMemoryWrite,
  type HeldMemoryQueue,
  type ListedGlobalMemory,
  type RelayedGlobalMemory,
  type SearchedGlobalMemory,
} from '../../shared/remote-user';
import type { UserProfile } from '../../shared/types/memory';
import { currentPin } from '../client-snapshots';
import { l } from '../l10n';
import { log } from '../logger';
import { globalMemoryClosedReason, globalMemoryListOutdatedReason, globalMemoryOffReason } from '../user-scope';
import type { MemoryOutbox, OutboxEntry } from './memory-outbox';

// A global memory a daemon's core holds names the client it came from: `global:<clientId>:<the client's own id>`.
const GLOBAL_ID_PREFIX = 'global:';

// A drain that failed for another reason than an absent client is tried again while that client stays attached, after
// DRAIN_RETRY_MIN_MS, doubling up to DRAIN_RETRY_MAX_MS.
const DRAIN_RETRY_MIN_MS = 5_000;
const DRAIN_RETRY_MAX_MS: number = 5 * 60_000;

export function globalMemoryId(clientId: string, id: string): string {
  return `${GLOBAL_ID_PREFIX}${clientId}:${id}`;
}

/** The client and its own id a global memory id names; undefined for an id of this host's own store. */
export function parseGlobalMemoryId(id: string): { readonly clientId: string; readonly id: string } | undefined {
  if (!id.startsWith(GLOBAL_ID_PREFIX)) return undefined;
  const rest = id.slice(GLOBAL_ID_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0 || colon === rest.length - 1) return undefined;
  return { clientId: rest.slice(0, colon), id: rest.slice(colon + 1) };
}

const qualified = <M extends RelayedGlobalMemory>(clientId: string, memory: M): M => ({ ...memory, id: globalMemoryId(clientId, memory.id) });

const isAbsent = (err: unknown): boolean => err instanceof Error && err.message === CREDENTIAL_CLIENT_ABSENT;
const isOutdated = (err: unknown): boolean => err instanceof Error && err.message === CLIENT_FEATURE_MISSING;
const isMemoryOff = (err: unknown): boolean => err instanceof Error && err.message === CLIENT_MEMORY_OFF;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const EMPTY_PROFILE: UserProfile = { static: '', dynamic: '' };

// a count user.memory.search takes: whole, and at most MAX_RELAYED_MEMORIES
const searchCount = (k: number): number => Math.min(Math.max(Math.floor(k), 0), MAX_RELAYED_MEMORIES);

/** The leading entries one user.memory.apply sends: at most MAX_RELAYED_MEMORIES, and MAX_GLOBAL_MEMORY_APPLY_BYTES unless the first alone is larger. */
function applyBatch(entries: readonly OutboxEntry[]): OutboxEntry[] {
  const batch: OutboxEntry[] = [];
  let bytes = 0;
  let start = 0;
  for (const entry of entries) {
    // an entry's line, which skipped lines before it inflate, overstates its JSON, never understates it
    const size = entry.end - start;
    if (batch.length === MAX_RELAYED_MEMORIES || (batch.length > 0 && bytes + size > MAX_GLOBAL_MEMORY_APPLY_BYTES)) break;
    batch.push(entry);
    bytes += size;
    start = entry.end;
  }
  return batch;
}

/** A search of the acting client's global rows: its rows, or why it has none to give. */
export type GlobalSearchOutcome = { readonly rows: RelayedGlobalMemory[] } | { readonly unreachable: LocalizedText };

/** A global memory write as a daemon's core makes it, before it has a uuid. */
export type GlobalMemoryFields = Omit<GlobalMemoryWrite, 'uuid'>;

/**
 * Where a write went: applied on its client now, or held in that client's outbox until it attaches. id: the client's row
 * that holds it, an earlier duplicate it folded into included; the uuid while it is queued.
 */
export type GlobalMemoryWriteOutcome = { readonly uuid: string; readonly clientId: string; readonly queued: boolean; readonly id: string };

/** The write as user.memory.apply carries it: each tag once, and at most MAX_GLOBAL_MEMORY_TAGS of them. */
function boundedWrite(write: GlobalMemoryWrite): GlobalMemoryWrite {
  if (write.tags === undefined) return write;
  const { tags: all, ...rest } = write;
  const tags = [...new Set(all)].slice(0, MAX_GLOBAL_MEMORY_TAGS);
  return tags.length > 0 ? { ...rest, tags } : rest;
}

/**
 * A daemon's core's global memory, which lives on its clients (docs/invariants.md "Data scopes"): searches and the profile
 * go to the acting client, injected ids resolve through the client that returned them, and writes go to the turn's pinned
 * client, else to that client's outbox, which drains to that client alone when it attaches. An outbox whose client has
 * not attached for GLOBAL_MEMORY_HOLD_MS is held: another attached device may take it or discard it.
 */
export class GlobalMemoryRelay implements Disposable {
  private readonly remote: RemoteHost;
  private readonly outbox: MemoryOutbox;
  // each attached client's profile, pinned globals and global preferences, read once per attach
  private readonly profiles = new Map<string, ClientGlobalProfile>();
  // the latest profile read of each client; an older read that lands after it is dropped
  private readonly profileReads = new Map<string, number>();
  // one drain per client at a time; a drain asked for meanwhile runs once after it
  private readonly drains = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  // a failed drain's next try, and how many tries in a row failed
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly failures = new Map<string, number>();
  // each client's writes, one after another, so they reach it in the order they were made
  private readonly writes = new Map<string, Promise<unknown>>();
  // one held queue listing at a time, the last one published
  private heldList: Promise<void> = Promise.resolve();
  private readonly subscription: Disposable;
  private disposed = false;

  constructor(remote: RemoteHost, outbox: MemoryOutbox) {
    this.remote = remote;
    this.outbox = outbox;
    this.subscription = remote.clients.onDidChange((change) => {
      if (change.topic !== 'clientAuth' || change.clientId === undefined) return;
      if (change.detached) this.detached(change.clientId);
      else if (change.before === undefined || !this.profiles.has(change.clientId)) this.attached(change.clientId);
    });
  }

  /** Reads what each client attached at this core's start needs: its profile and its outbox; then lists the held queues. */
  start(): void {
    for (const clientId of this.remote.clients.attachedClients()) this.attached(clientId);
    this.publishHeld();
  }

  private attached(clientId: string): void {
    const generation = (this.profileReads.get(clientId) ?? 0) + 1;
    this.profileReads.set(clientId, generation);
    void this.remote.memoryProfile(clientId).then(
      (profile) => {
        if (this.profileReads.get(clientId) === generation && this.remote.clients.attached(clientId)) this.profiles.set(clientId, profile);
      },
      (err: unknown) => log(`[GlobalMemory] reading the global profile of client ${clientId} failed: ${errorText(err)}`),
    );
    void this.drain(clientId);
    this.publishHeld();
  }

  private detached(clientId: string): void {
    this.profiles.delete(clientId);
    this.stopRetry(clientId);
    this.failures.delete(clientId);
    const at = Date.now();
    this.heldList = this.heldList.then(() => this.outbox.recordSeen([clientId], at)).catch((err: unknown) => log(`[GlobalMemory] recording when client ${clientId} left failed: ${errorText(err)}`));
    this.publishHeld();
  }

  /** The acting client while it is attached. */
  private actingClient(): string | undefined {
    const clientId = this.remote.clients.acting();
    return clientId !== undefined && this.remote.clients.attached(clientId) ? clientId : undefined;
  }

  /** Whether a client is attached whose global memories a search reaches. */
  reachable(): boolean {
    return this.actingClient() !== undefined;
  }

  /**
   * The acting client's own ranked search of its global rows, filtered as its own search filters them, ids qualified by that
   * client; the reason it has none while none is attached (a client that left during the search included) or memory is off
   * on it.
   */
  async search(query: string, k: number, tiers: readonly ('global' | 'note')[], filters: GlobalMemorySearchFilters = {}): Promise<GlobalSearchOutcome> {
    const clientId = this.actingClient();
    if (clientId === undefined) return { unreachable: globalMemoryClosedReason() };
    const count = searchCount(k);
    const asked = [...new Set(tiers)];
    if (count === 0 || asked.length === 0) return { rows: [] };
    const sent: GlobalMemorySearchFilters = {
      ...(filters.since !== undefined ? { since: filters.since } : {}),
      ...(filters.until !== undefined ? { until: filters.until } : {}),
      ...(filters.includeForgotten === true ? { includeForgotten: true } : {}),
    };
    try {
      return { rows: (await this.remote.memorySearch(clientId, query, count, asked, false, sent)).map((memory) => qualified(clientId, memory)) };
    } catch (err) {
      if (isAbsent(err)) return { unreachable: globalMemoryClosedReason() };
      if (isMemoryOff(err)) return { unreachable: globalMemoryOffReason() };
      throw err;
    }
  }

  /**
   * The acting client's global facts, preferences and episodes a prompt passes that client's injection gate for, each saying
   * whether it may render full; none while no client is attached.
   */
  async injectable(prompt: string, k: number): Promise<SearchedGlobalMemory[]> {
    const clientId = this.actingClient();
    const count = searchCount(k);
    if (clientId === undefined || count === 0) return [];
    try {
      return (await this.remote.memorySearch(clientId, prompt, count, ['global'], true)).map((memory) => qualified(clientId, memory));
    } catch (err) {
      // a client that left during the search is away for this prompt, as one that left before it
      if (isAbsent(err)) return [];
      throw err;
    }
  }

  /**
   * Every latest note with any of the tags on the acting client, forgotten ones included, newest first,
   * ids qualified, read page by page. Refused with the closed reason while no client is attached or when it leaves part way,
   * with the outdated reason when its Damocles cannot list, with the memory-off reason while memory is off on it, and when a
   * page's next does not advance.
   */
  async listNotes(tags: readonly string[] = []): Promise<ListedGlobalMemory[]> {
    const asked = [...new Set(tags)];
    if (asked.length > MAX_GLOBAL_MEMORY_TAGS || asked.some((tag) => tag.length > MAX_GLOBAL_MEMORY_LABEL_CHARS)) {
      throw new LocalizedError(l('In a chat on a remote host, list notes by at most {0} tags of at most {1} characters each.', MAX_GLOBAL_MEMORY_TAGS, MAX_GLOBAL_MEMORY_LABEL_CHARS));
    }
    const clientId = this.actingClient();
    if (clientId === undefined) throw new LocalizedError(globalMemoryClosedReason());
    const rows: ListedGlobalMemory[] = [];
    let cursor: GlobalMemoryListCursor | undefined;
    for (;;) {
      let page: GlobalMemoryListPage;
      try {
        page = await this.remote.memoryList(clientId, { kinds: ['note'], ...(asked.length > 0 ? { tags: asked } : {}), ...(cursor !== undefined ? { cursor } : {}) });
      } catch (err) {
        if (isAbsent(err)) throw new LocalizedError(globalMemoryClosedReason());
        if (isOutdated(err)) throw new LocalizedError(globalMemoryListOutdatedReason());
        if (isMemoryOff(err)) throw new LocalizedError(globalMemoryOffReason());
        throw err;
      }
      rows.push(...page.rows.map((row) => qualified(clientId, row)));
      if (page.next === undefined) return rows;
      if (cursor !== undefined && !listedAfter(page.next, cursor)) throw new Error(`Client ${clientId} answered a page of its global memories whose next does not advance`);
      cursor = page.next;
    }
  }

  /** The acting client's global profile as read at its attach; empty while none is attached or before the read lands. */
  profile(): UserProfile {
    const clientId = this.actingClient();
    return (clientId === undefined ? undefined : this.profiles.get(clientId)?.profile) ?? EMPTY_PROFILE;
  }

  /** The acting client's pinned globals and global preferences as read at its attach, ids qualified; none while none is attached. */
  standing(): { readonly pinned: readonly RelayedGlobalMemory[]; readonly preferences: readonly RelayedGlobalMemory[] } {
    const clientId = this.actingClient();
    const held = clientId === undefined ? undefined : this.profiles.get(clientId);
    if (clientId === undefined || held === undefined) return { pinned: [], preferences: [] };
    return { pinned: held.pinned.map((memory) => qualified(clientId, memory)), preferences: held.preferences.map((memory) => qualified(clientId, memory)) };
  }

  /**
   * The current version of each global id whose client is attached, keyed by the id asked for, ids qualified. An id whose
   * client is away has no entry: it is unchanged as far as this core can know, so it is never announced as forgotten.
   */
  async resolve(ids: readonly string[]): Promise<Map<string, GlobalMemoryResolution>> {
    const byClient = new Map<string, Set<string>>();
    for (const id of ids) {
      const parsed = parseGlobalMemoryId(id);
      // an id longer than any a client issues names none of its rows
      if (!parsed || parsed.id.length > MAX_GLOBAL_MEMORY_ID_CHARS || !this.remote.clients.attached(parsed.clientId)) continue;
      const own = byClient.get(parsed.clientId) ?? new Set<string>();
      own.add(parsed.id);
      byClient.set(parsed.clientId, own);
    }
    const resolved = new Map<string, GlobalMemoryResolution>();
    for (const [clientId, own] of byClient) {
      const all = [...own];
      for (let start = 0; start < all.length; start += MAX_RELAYED_MEMORIES) {
        const batch = all.slice(start, start + MAX_RELAYED_MEMORIES);
        let answers: readonly GlobalMemoryResolution[];
        try {
          answers = await this.remote.memoryResolve(clientId, batch);
        } catch (err) {
          if (isAbsent(err)) break;
          throw err;
        }
        for (const answer of answers) {
          if (!batch.includes(answer.id)) continue;
          const id = globalMemoryId(clientId, answer.id);
          resolved.set(id, 'memory' in answer ? { id, memory: qualified(clientId, answer.memory) } : { ...answer, id });
        }
      }
    }
    return resolved;
  }

  /**
   * Writes a global memory on its device: `owner` when the caller knows it (an extraction's turn), else the turn's pinned
   * client, else the acting one; held in that device's outbox while it is away. A caller that may repeat one write passes
   * the same `uuid` each time, which the client applies once. One device's writes run one after another, in call order.
   */
  write(fields: GlobalMemoryFields, owner?: string, uuid: string = crypto.randomUUID()): Promise<GlobalMemoryWriteOutcome> {
    const write = boundedWrite({ uuid, ...fields });
    if (!globalMemoryWriteFits(write)) return Promise.reject(new LocalizedError(l('This global memory is too large to save on your computer.')));
    const clientId = owner ?? currentPin(this.remote).clientId;
    if (clientId === undefined) return Promise.reject(new LocalizedError(globalMemoryClosedReason()));
    const run = (this.writes.get(clientId) ?? Promise.resolve()).then(() => this.writeNow(clientId, write));
    const tail = run.catch(() => undefined);
    this.writes.set(clientId, tail);
    void tail.then(() => {
      if (this.writes.get(clientId) === tail) this.writes.delete(clientId);
    });
    return run;
  }

  private async writeNow(clientId: string, write: GlobalMemoryWrite): Promise<GlobalMemoryWriteOutcome> {
    // a write waits behind what the outbox already holds for that client, so the client applies them in order
    if (this.remote.clients.attached(clientId) && (await this.outbox.isEmpty(clientId))) {
      try {
        const { ids } = await this.remote.memoryApply(clientId, [{ end: 0, write }]);
        if (ids?.length === 1) return { uuid: write.uuid, clientId, queued: false, id: ids[0]! };
        log(`[GlobalMemory] client ${clientId} did not say it applied write ${write.uuid}; it waits in the outbox`);
      } catch (err) {
        // the client may have applied it before it went: its uuid makes the outbox copy a no-op then
        if (!isAbsent(err)) throw err;
      }
    }
    await this.outbox.append(clientId, write);
    if (this.remote.clients.attached(clientId)) void this.drain(clientId);
    else this.publishHeld();
    return { uuid: write.uuid, clientId, queued: true, id: write.uuid };
  }

  /** Sends the client's outbox to it in order and removes only the prefix it acknowledged. */
  drain(clientId: string): Promise<void> {
    const running = this.drains.get(clientId);
    if (running) {
      this.again.add(clientId);
      return running;
    }
    this.stopRetry(clientId);
    const run = this.drainLoop(clientId);
    this.drains.set(clientId, run);
    return run;
  }

  private async drainLoop(clientId: string): Promise<void> {
    try {
      do {
        this.again.delete(clientId);
        while (!this.disposed && this.remote.clients.attached(clientId) && (await this.drainOnce(clientId)));
      } while (!this.disposed && this.again.has(clientId) && this.remote.clients.attached(clientId));
      this.failures.delete(clientId);
    } catch (err) {
      const failures = (this.failures.get(clientId) ?? 0) + 1;
      this.failures.set(clientId, failures);
      const delay = Math.min(DRAIN_RETRY_MIN_MS * 2 ** (failures - 1), DRAIN_RETRY_MAX_MS);
      const retry = !this.disposed && this.remote.clients.attached(clientId);
      log(`[GlobalMemory] draining the outbox of client ${clientId} failed${retry ? `; trying again in ${delay} ms` : ''}: ${errorText(err)}`);
      if (retry) {
        this.retries.set(clientId, setTimeout(() => {
          this.retries.delete(clientId);
          void this.drain(clientId);
        }, delay));
      }
    } finally {
      // in the same turn as the loop's last check, so a drain asked for after it starts a drain of its own
      this.drains.delete(clientId);
    }
  }

  private stopRetry(clientId: string): void {
    clearTimeout(this.retries.get(clientId));
    this.retries.delete(clientId);
  }

  /** Sends the outbox's next batch; true when the client applied all of it and more entries wait. */
  private async drainOnce(clientId: string): Promise<boolean> {
    const { entries, end } = await this.outbox.read(clientId);
    if (entries.length === 0) {
      if (end > 0) await this.outbox.acknowledge(clientId, end, null);
      return false;
    }
    const batch = applyBatch(entries);
    let through: number;
    try {
      ({ through } = await this.remote.memoryApply(clientId, batch));
    } catch (err) {
      if (isAbsent(err)) return false;
      throw err;
    }
    if (through === 0) return false;
    const applied = batch.find((entry) => entry.end === through);
    if (!applied) throw new Error(`Client ${clientId} acknowledged byte ${through}, which ends no entry it was sent`);
    const whole = applied === entries.at(-1);
    // the lines a skipped unparsable tail held go with the last entry
    if (whole && end !== through) await this.outbox.acknowledge(clientId, end, null);
    else await this.outbox.acknowledge(clientId, through, applied.write.uuid);
    return applied === batch.at(-1) && !whole;
  }

  /** The outboxes held for devices that have not attached for GLOBAL_MEMORY_HOLD_MS, oldest first; an attached device is seen now, so its outbox never is. */
  async heldQueues(): Promise<HeldMemoryQueue[]> {
    const now = Date.now();
    await this.outbox.recordSeen(this.remote.clients.attachedClients(), now);
    const owners = await this.outbox.clients();
    const seen = await this.outbox.lastSeen(owners, now);
    const queues: HeldMemoryQueue[] = [];
    for (const clientId of owners) {
      const lastSeen = seen[clientId]!;
      if (now - lastSeen < GLOBAL_MEMORY_HOLD_MS) continue;
      const count = (await this.outbox.read(clientId)).entries.length;
      if (count > 0) queues.push({ queueId: clientId, count, lastSeen });
    }
    return queues.sort((a, b) => a.lastSeen - b.lastSeen).slice(0, MAX_HELD_MEMORY_QUEUES);
  }

  /** Lists the held queues again and publishes them, after every earlier listing. */
  private publishHeld(): void {
    this.heldList = this.heldList
      .then(async () => {
        const queues = await this.heldQueues();
        if (!this.disposed) this.remote.heldMemoryChanged(queues);
      })
      .catch((err: unknown) => log(`[GlobalMemory] listing the held memory queues failed: ${errorText(err)}`));
  }

  /**
   * Deliver here: the held queue goes to the end of the asking device's outbox, which then drains to that device; false
   * when the queue is not held (its device came back, even while this ran, or another device took or discarded it).
   */
  async deliverHeld(queueId: string): Promise<boolean> {
    const to = this.remote.clients.actor();
    if (to === undefined || !this.remote.clients.attached(to)) throw new Error('Only an attached device takes a held memory queue');
    let moved: boolean;
    try {
      if (!(await this.heldQueues()).some((queue) => queue.queueId === queueId)) return false;
      // its device attaching wins: decided under the outbox's lock, which that device's drain reads under
      moved = await this.outbox.transfer(queueId, to, () => !this.remote.clients.attached(queueId));
    } catch (err) {
      log(`[GlobalMemory] delivering the held outbox of client ${queueId} to client ${to} failed: ${errorText(err)}`);
      throw err;
    }
    log(`[GlobalMemory] the held outbox of client ${queueId} ${moved ? 'goes' : 'was gone or its device came back before it could go'} to client ${to}`);
    this.publishHeld();
    if (moved) void this.drain(to);
    return moved;
  }

  /** Discard: deletes a held queue; false when it is not held. */
  async discardHeld(queueId: string): Promise<boolean> {
    let removed: boolean;
    try {
      if (!(await this.heldQueues()).some((queue) => queue.queueId === queueId)) return false;
      removed = await this.outbox.discard(queueId, () => !this.remote.clients.attached(queueId));
    } catch (err) {
      log(`[GlobalMemory] discarding the held outbox of client ${queueId} failed: ${errorText(err)}`);
      throw err;
    }
    log(`[GlobalMemory] the held outbox of client ${queueId} ${removed ? 'was discarded' : 'was gone or its device came back before it could be discarded'}`);
    this.publishHeld();
    return removed;
  }

  /**
   * Stops retries and further batches; resolves once the held listing and seen records under way have ended. A drain or
   * write waiting on its device is not waited for, since a device that stops answering would hold the shutdown.
   */
  dispose(): Promise<void> {
    this.disposed = true;
    this.subscription.dispose();
    this.profiles.clear();
    for (const clientId of [...this.retries.keys()]) this.stopRetry(clientId);
    return this.heldList;
  }
}
