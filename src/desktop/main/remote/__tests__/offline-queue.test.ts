import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_HELD_BYTES, MAX_HELD_PER_PANEL, OfflineQueue, VERDICT_WAIT_MS, type QueuedSend } from '../offline-queue';
import { REMOTE_STATE_FILE, RemoteState } from '../remote-state';

const TOKEN = '6f1c2a9e-0d4b-4c1e-9a1f-1b2c3d4e5f60';
const OTHER_PAGE = '1a2b3c4d-0d4b-4c1e-9a1f-1b2c3d4e5f60';
const AUTHORITY = 'ssh+h1';

let userData: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-offline-queue-'));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

async function queueOn(state: RemoteState) {
  const changed: string[] = [];
  const failures: unknown[] = [];
  const queue = new OfflineQueue({
    stored: state.offlineQueue(),
    save: (token, panel) => state.setOfflineQueue(token, panel),
    canSave: () => state.unreadable() === undefined,
    changed: (token) => changed.push(token),
    newId: () => randomUUID(),
    report: (err) => failures.push(err),
  });
  return { queue, changed, failures };
}

const flushAll = (queue: OfflineQueue, busy = false): QueuedSend[] => {
  const sent: QueuedSend[] = [];
  queue.flush(TOKEN, busy, (message) => sent.push(message));
  return sent;
};

describe('OfflineQueue', () => {
  it('holds the page\'s sends and queued messages in order, each naming the conversation the page showed', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    const { queue, changed } = await queueOn(state);
    expect(queue.hold(AUTHORITY, TOKEN, { type: 'sendMessage', content: 'first', sessionId: 'conv-1' })).toBe('held');
    expect(queue.hold(AUTHORITY, TOKEN, { type: 'queueMessage', content: [{ type: 'text', text: 'second' }], sessionId: 'conv-1' })).toBe('held');
    expect(queue.hold(AUTHORITY, TOKEN, { type: 'cancelSession' })).toBe('ignored');
    expect(queue.queued(TOKEN).map((message) => [message.text, message.status])).toEqual([['first', 'queued'], ['second', 'queued']]);
    expect(changed).toEqual([TOKEN, TOKEN]);
    expect(queue.waiting(AUTHORITY)).toEqual([TOKEN]);

    const sent = flushAll(queue);
    expect(sent).toEqual([
      { type: 'sendMessage', content: 'first', sessionId: 'conv-1' },
      { type: 'queueMessage', content: [{ type: 'text', text: 'second' }], sessionId: 'conv-1' },
    ]);
    expect(queue.queued(TOKEN)).toEqual([]);
    expect(queue.waiting(AUTHORITY)).toEqual([]);
  });

  it('queues every flushed message behind a turn that still runs', async () => {
    const { queue } = await queueOn(await RemoteState.open(userData, () => undefined));
    queue.hold(AUTHORITY, TOKEN, { type: 'sendMessage', content: 'a', sessionId: 'conv-1' });
    queue.hold(AUTHORITY, TOKEN, { type: 'sendMessage', content: 'b', sessionId: 'conv-1' });
    expect(flushAll(queue, true).map((message) => message.type)).toEqual(['queueMessage', 'queueMessage']);
  });

  it('keeps held messages in remote-state.json across a relaunch, without the page\'s other fields', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    const { queue } = await queueOn(state);
    queue.hold(AUTHORITY, TOKEN, {
      type: 'sendMessage',
      content: [{ type: 'text', text: 'deploy it' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' }, apiKey: 'sk-leak' }],
      sessionId: 'conv-1',
      includeIdeContext: true,
      terminalAttachmentIds: ['att-1'],
      apiKey: 'sk-secret',
    });
    await state.flush();
    const text = fs.readFileSync(path.join(userData, REMOTE_STATE_FILE), 'utf8');
    expect(text).not.toContain('sk-');
    expect(text).not.toContain('att-1');
    expect(text).not.toContain('includeIdeContext');
    const persisted = (JSON.parse(text) as { offlineQueue: Record<string, { authority: string; entries: Array<Record<string, unknown>> }> }).offlineQueue[TOKEN]!;
    expect(persisted.authority).toBe(AUTHORITY);
    expect(Object.keys(persisted.entries[0]!).sort()).toEqual(['content', 'conversationId', 'id', 'status']);

    const relaunched = await queueOn(await RemoteState.open(userData, () => undefined));
    expect(relaunched.queue.queued(TOKEN)).toEqual([{ id: persisted.entries[0]!['id'], text: 'deploy it', imageCount: 1, status: 'queued' }]);
    expect(relaunched.queue.waiting(AUTHORITY)).toEqual([TOKEN]);
  });

  it('Cancel removes one waiting message and the file follows; Discard does not touch a waiting one', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    const { queue } = await queueOn(state);
    queue.hold(AUTHORITY, TOKEN, { type: 'sendMessage', content: 'keep', sessionId: 'conv-1' });
    queue.hold(AUTHORITY, TOKEN, { type: 'queueMessage', content: 'drop', sessionId: 'conv-1' });
    const [, dropped] = queue.queued(TOKEN);
    expect(queue.remove(TOKEN, dropped!.id, 'notSent')).toBe(false);
    expect(queue.remove(TOKEN, dropped!.id, 'queued')).toBe(true);
    expect(queue.remove(TOKEN, dropped!.id, 'queued')).toBe(false);
    await state.flush();
    const relaunched = await queueOn(await RemoteState.open(userData, () => undefined));
    expect(relaunched.queue.queued(TOKEN).map((message) => message.text)).toEqual(['keep']);
    expect(flushAll(relaunched.queue).map((message) => message.content)).toEqual(['keep']);
  });

  it('turns a flushed message core returned as conversationChanged into a not-sent chip that never sends again', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    const { queue } = await queueOn(state);
    queue.hold(AUTHORITY, TOKEN, { type: 'sendMessage', content: 'first', sessionId: 'conv-1' });
    queue.hold(AUTHORITY, TOKEN, { type: 'queueMessage', content: 'second', sessionId: 'conv-1' });
    flushAll(queue);
    expect(queue.awaitsVerdict(TOKEN)).toBe(true);
    // core accepted the first and returned the second: the chat had moved to another conversation
    expect(queue.fromCore(TOKEN, { type: 'userMessage', content: 'first', correlationId: 'c', promptIndex: 0 })).toBe(false);
    expect(queue.fromCore(TOKEN, { type: 'promptReturned', content: [{ type: 'text', text: 'second' }], reason: 'conversationChanged' })).toBe(true);
    expect(queue.awaitsVerdict(TOKEN)).toBe(false);
    expect(queue.queued(TOKEN).map((message) => [message.text, message.status])).toEqual([['second', 'notSent']]);
    expect(queue.waiting(AUTHORITY)).toEqual([]);
    expect(flushAll(queue)).toEqual([]);
    // once no flushed message awaits a verdict, a return of the same text is the page's own later send, the page's to show
    expect(queue.fromCore(TOKEN, { type: 'promptReturned', content: [{ type: 'text', text: 'second' }], reason: 'conversationChanged' })).toBe(false);

    const [notSent] = queue.queued(TOKEN);
    expect(queue.remove(TOKEN, notSent!.id, 'queued')).toBe(false);
    expect(queue.remove(TOKEN, notSent!.id, 'notSent')).toBe(true);
    expect(queue.queued(TOKEN)).toEqual([]);
  });

  it('hands the page any other return of a flushed message, and still reads verdicts after a resume', async () => {
    const { queue } = await queueOn(await RemoteState.open(userData, () => undefined));
    queue.hold(AUTHORITY, TOKEN, { type: 'sendMessage', content: 'one', sessionId: null });
    queue.hold(AUTHORITY, TOKEN, { type: 'queueMessage', content: 'two', sessionId: null });
    flushAll(queue);
    expect(queue.fromCore(TOKEN, { type: 'promptReturned', content: [{ type: 'text', text: 'one' }], reason: 'worktreeFinishing' })).toBe(false);
    queue.hostLost(AUTHORITY);
    queue.hostResumed(AUTHORITY);
    expect(queue.awaitsVerdict(TOKEN)).toBe(true);
    expect(queue.fromCore(TOKEN, { type: 'promptReturned', content: [{ type: 'text', text: 'two' }], reason: 'conversationChanged' })).toBe(true);
    expect(queue.queued(TOKEN).map((message) => [message.text, message.status])).toEqual([['two', 'notSent']]);
  });

  // the daemon refusing the resume (a restart, past the grace) drops what the old connection still carried
  it('turns flushed messages core never answered into not-sent chips when their connection ends without resuming', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    const { queue, changed } = await queueOn(state);
    queue.hold(AUTHORITY, TOKEN, { type: 'sendMessage', content: 'answered', sessionId: null });
    queue.hold(AUTHORITY, TOKEN, { type: 'queueMessage', content: 'unanswered', sessionId: null });
    flushAll(queue);
    queue.fromCore(TOKEN, { type: 'userMessage', content: 'answered', correlationId: 'c', promptIndex: 0 });
    queue.hostLost(AUTHORITY);
    changed.length = 0;
    queue.connectionEnded(AUTHORITY);
    expect(queue.queued(TOKEN).map((message) => [message.text, message.status])).toEqual([['unanswered', 'notSent']]);
    expect(changed).toEqual([TOKEN]);
    expect(queue.awaitsVerdict(TOKEN)).toBe(false);
    expect(flushAll(queue)).toEqual([]);
    await state.flush();
    expect((await queueOn(await RemoteState.open(userData, () => undefined))).queue.queued(TOKEN).map((message) => message.status)).toEqual(['notSent']);
  });

  it('matches a verdict to the oldest flushed message of its text, and lets go of one core answered in a way it does not read', async () => {
    let now = 1_000;
    const state = await RemoteState.open(userData, () => undefined);
    const queue = new OfflineQueue({ stored: state.offlineQueue(), save: (token, panel) => state.setOfflineQueue(token, panel), canSave: () => state.unreadable() === undefined, changed: () => undefined, newId: () => randomUUID(), report: () => undefined, now: () => now });
    queue.hold(AUTHORITY, TOKEN, { type: 'sendMessage', content: 'yes', sessionId: 'conv-1' });
    queue.hold(AUTHORITY, TOKEN, { type: 'queueMessage', content: 'yes', sessionId: 'conv-2' });
    const [first] = queue.queued(TOKEN);
    flushAll(queue);
    expect(queue.fromCore(TOKEN, { type: 'promptReturned', content: [{ type: 'text', text: 'yes' }], reason: 'conversationChanged' })).toBe(true);
    expect(queue.queued(TOKEN).map((message) => message.id)).toEqual([first!.id]);
    // the second got an answer this queue does not read; while the host stayed connected it is settled after the bound
    now += VERDICT_WAIT_MS;
    expect(queue.awaitsVerdict(TOKEN)).toBe(false);
    queue.connectionEnded(AUTHORITY);
    expect(queue.queued(TOKEN)).toHaveLength(1);
  });

  it('passes on core text that is not JSON instead of throwing in the relay, still awaiting its verdicts', async () => {
    const { queue } = await queueOn(await RemoteState.open(userData, () => undefined));
    queue.hold(AUTHORITY, TOKEN, { type: 'sendMessage', content: 'deploy', sessionId: null });
    flushAll(queue);
    expect(queue.fromCoreText(TOKEN, '{"type":"promptReturned",')).toBe(false);
    expect(queue.fromCoreText(TOKEN, JSON.stringify({ type: 'promptReturned', content: [{ type: 'text', text: 'deploy' }], reason: 'conversationChanged' }))).toBe(true);
  });

  it('never lets the bound run out on a flushed message while its connection is dropped', async () => {
    let now = 1_000;
    const state = await RemoteState.open(userData, () => undefined);
    const queue = new OfflineQueue({ stored: state.offlineQueue(), save: (token, panel) => state.setOfflineQueue(token, panel), canSave: () => state.unreadable() === undefined, changed: () => undefined, newId: () => randomUUID(), report: () => undefined, now: () => now });
    queue.hold(AUTHORITY, TOKEN, { type: 'sendMessage', content: 'deploy', sessionId: null });
    flushAll(queue);
    queue.hostLost(AUTHORITY);
    now += 10 * VERDICT_WAIT_MS;
    expect(queue.awaitsVerdict(TOKEN)).toBe(true);
    queue.connectionEnded(AUTHORITY);
    expect(queue.queued(TOKEN).map((message) => [message.text, message.status])).toEqual([['deploy', 'notSent']]);
  });

  it('refuses a send past a page\'s count or the bytes every page holds, holding nothing', async () => {
    const { queue, changed } = await queueOn(await RemoteState.open(userData, () => undefined));
    for (let index = 0; index < MAX_HELD_PER_PANEL; index++) expect(queue.hold(AUTHORITY, TOKEN, { type: 'queueMessage', content: `m${index}`, sessionId: null })).toBe('held');
    expect(queue.hold(AUTHORITY, TOKEN, { type: 'queueMessage', content: 'one more', sessionId: null })).toBe('tooMany');
    expect(queue.queued(TOKEN)).toHaveLength(MAX_HELD_PER_PANEL);
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(MAX_HELD_BYTES) } };
    changed.length = 0;
    expect(queue.hold(AUTHORITY, OTHER_PAGE, { type: 'sendMessage', content: [image], sessionId: null })).toBe('tooLarge');
    expect(queue.queued(OTHER_PAGE)).toEqual([]);
    expect(changed).toEqual([]);
  });

  it('holds nothing for a page whose token remote-state.json could not keep, so memory and the file never disagree', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    const { queue, failures, changed } = await queueOn(state);
    expect(queue.hold(AUTHORITY, '../not a token', { type: 'sendMessage', content: 'hi', sessionId: null })).toBe('ignored');
    expect(queue.queued('../not a token')).toEqual([]);
    expect(changed).toEqual([]);
    await expect(state.setOfflineQueue('../not a token', undefined)).rejects.toThrow('panel token');
    expect(failures).toEqual([]);
  });

  it('holds nothing while remote-state.json takes no writes, so no held message lives in memory alone', async () => {
    fs.writeFileSync(path.join(userData, REMOTE_STATE_FILE), '{ "version": 1, "authorities": ');
    const state = await RemoteState.open(userData, () => undefined);
    const { queue, changed, failures } = await queueOn(state);
    expect(queue.hold(AUTHORITY, TOKEN, { type: 'sendMessage', content: 'hi', sessionId: null })).toBe('unsaved');
    expect(queue.hold(AUTHORITY, TOKEN, { type: 'cancelSession' })).toBe('ignored');
    expect(queue.queued(TOKEN)).toEqual([]);
    expect(changed).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('lets go of a forgotten host\'s pages, chips and awaited verdicts included', async () => {
    const { queue } = await queueOn(await RemoteState.open(userData, () => undefined));
    queue.hold(AUTHORITY, TOKEN, { type: 'sendMessage', content: 'sent', sessionId: null });
    flushAll(queue);
    queue.hold(AUTHORITY, TOKEN, { type: 'sendMessage', content: 'waiting', sessionId: null });
    queue.hold('ssh+h2', OTHER_PAGE, { type: 'sendMessage', content: 'other host', sessionId: null });
    queue.forgetAuthority(AUTHORITY);
    expect(queue.queued(TOKEN)).toEqual([]);
    expect(queue.waiting(AUTHORITY)).toEqual([]);
    expect(queue.awaitsVerdict(TOKEN)).toBe(false);
    expect(queue.waiting('ssh+h2')).toEqual([OTHER_PAGE]);
  });

  it('refuses an empty send or one with a malformed conversation id, and forgets a closed chat\'s messages', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    const { queue } = await queueOn(state);
    expect(queue.hold(AUTHORITY, TOKEN, { type: 'sendMessage', content: '   ', sessionId: null })).toBe('ignored');
    expect(queue.hold(AUTHORITY, TOKEN, { type: 'sendMessage', content: 'hi', sessionId: 42 })).toBe('ignored');
    expect(queue.hold(AUTHORITY, TOKEN, { type: 'sendMessage', content: [{ type: 'tool_use', id: 'x' }], sessionId: null })).toBe('ignored');
    queue.hold(AUTHORITY, TOKEN, { type: 'sendMessage', content: 'hi', sessionId: null });
    queue.forget(TOKEN);
    await state.flush();
    expect((await RemoteState.open(userData, () => undefined)).offlineQueue().size).toBe(0);
  });
});

describe('OfflineQueue with a chat several devices show', () => {
  // each device's main keeps its own queue, keyed by its own page's token; both pages show one core panel
  const OTHER_TOKEN = '0b9e4c1a-7f2d-4e3b-8c5a-2d1e0f9a8b7c';

  it('holds and sends only this device\'s messages, and another device\'s echo or refusal settles none of them', async () => {
    const here = await queueOn(await RemoteState.open(userData, () => undefined));
    const other = await queueOn(await RemoteState.open(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-offline-other-')), () => undefined));
    other.queue.hold(AUTHORITY, OTHER_TOKEN, { type: 'sendMessage', content: 'from the laptop', sessionId: 'conv-1' });
    here.queue.hold(AUTHORITY, TOKEN, { type: 'sendMessage', content: 'from the desk', sessionId: 'conv-1' });
    expect(here.queue.queued(OTHER_TOKEN)).toEqual([]);
    expect(here.queue.waiting(AUTHORITY)).toEqual([TOKEN]);

    expect(flushAll(here.queue).map((message) => message.content)).toEqual(['from the desk']);
    // core broadcasts every view's echo and refusal; only the page that sent a message has it delivered
    expect(here.queue.fromCore(TOKEN, { type: 'promptReturned', reason: 'conversationChanged', content: 'from the laptop' })).toBe(false);
    expect(here.queue.awaitsVerdict(TOKEN)).toBe(true);
    expect(other.queue.fromCore(OTHER_TOKEN, { type: 'promptReturned', reason: 'conversationChanged', content: 'from the desk' })).toBe(false);
    expect(other.queue.queued(OTHER_TOKEN).map((message) => [message.text, message.status])).toEqual([['from the laptop', 'queued']]);

    expect(here.queue.fromCore(TOKEN, { type: 'promptReturned', reason: 'conversationChanged', content: 'from the desk' })).toBe(true);
    expect(here.queue.queued(TOKEN).map((message) => [message.text, message.status])).toEqual([['from the desk', 'notSent']]);
  });

  it('reads no verdict from the give-back with no content that drops another device\'s echo, an image-only message included', async () => {
    const { queue } = await queueOn(await RemoteState.open(userData, () => undefined));
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
    queue.hold(AUTHORITY, TOKEN, { type: 'sendMessage', content: [image], sessionId: 'conv-1' });
    flushAll(queue);
    expect(queue.fromCore(TOKEN, { type: 'promptReturned', reason: 'conversationChanged', content: [], correlationId: 'corr-other' })).toBe(false);
    expect(queue.queued(TOKEN)).toEqual([]);
    expect(queue.awaitsVerdict(TOKEN)).toBe(true);
  });
});
