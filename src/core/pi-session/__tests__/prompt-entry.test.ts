import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { ImageContent } from '@earendil-works/pi-ai';
import { queuedPromptEntries, watchPromptEntry, type QueuedPromptHandlers } from '../prompt-entry';

interface FakeSession {
  isStreaming: boolean;
  listeners: Set<(event: unknown) => void>;
  branch: Array<{ type: 'message'; id: string; message: unknown }>;
  /** pi's follow-up texts, which pi pushes right before it reports `queued`. */
  followUps: string[];
  /** pi's order: listeners hear message_end, then the message is appended to the tree. */
  commit: (id: string, message: { role: string; content: unknown }) => void;
  asSession: () => AgentSession;
}

function fakeSession(): FakeSession {
  const listeners = new Set<(event: unknown) => void>();
  const branch: FakeSession['branch'] = [];
  let session: AgentSession | undefined;
  const fake: FakeSession = {
    isStreaming: false,
    listeners,
    branch,
    followUps: [],
    commit: (id, message) => {
      for (const listener of [...listeners]) listener({ type: 'message_end', message });
      branch.push({ type: 'message', id, message });
    },
    asSession: () =>
      (session ??= {
        get isStreaming() { return fake.isStreaming; },
        subscribe: (listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        sessionManager: { getLeafId: () => branch.at(-1)?.id ?? null, getBranch: () => branch },
        getFollowUpMessages: () => fake.followUps,
      } as unknown as AgentSession),
  };
  return fake;
}

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });

describe('watchPromptEntry', () => {
  it('names the entry the prompt committed, not a note steered into the same run after it', () => {
    const fake = fakeSession();
    fake.commit('u-prior', user('earlier prompt'));
    const watch = watchPromptEntry(fake.asSession());

    // pi accepts the prompt with no run in progress, then the run it starts commits the prompt and,
    // at the next tool boundary, a cancel note.
    watch.preflightResult('started');
    fake.isStreaming = true;
    fake.commit('u-prompt', user('Run Start-Sleep -Seconds 60; echo done in PowerShell.'));
    fake.commit('u-note', user('skip it'));
    fake.isStreaming = false;

    expect(watch.entry()).toEqual({ id: 'u-prompt', text: 'Run Start-Sleep -Seconds 60; echo done in PowerShell.' });
    watch.dispose();
  });

  it('names no entry for a prompt pi queued into a running run', () => {
    const fake = fakeSession();
    fake.isStreaming = true;
    const watch = watchPromptEntry(fake.asSession());

    watch.preflightResult('queued');
    fake.commit('u-other', user('a steer the running run delivered'));

    expect(watch.entry()).toBeNull();
    watch.dispose();
  });

  it('names no entry when pi ran the prompt as a command and committed nothing', () => {
    const fake = fakeSession();
    fake.commit('u-prior', user('earlier prompt'));
    const watch = watchPromptEntry(fake.asSession());

    watch.preflightResult('handled');

    expect(watch.entry()).toBeNull();
    watch.dispose();
  });

  it('names no entry when pi refused the prompt', () => {
    const fake = fakeSession();
    const watch = watchPromptEntry(fake.asSession());

    // pi throws from prompt() and never calls preflightResult for a refused prompt.
    fake.commit('u-later', user('a later prompt'));

    expect(watch.entry()).toBeNull();
    watch.dispose();
  });

  it('stops listening once disposed', () => {
    const fake = fakeSession();
    const watch = watchPromptEntry(fake.asSession());
    watch.dispose();

    expect(fake.listeners.size).toBe(0);
  });
});

describe('watchPromptEntry onCommitted', () => {
  it('reports the prompt entry once pi has committed it, one microtask after its message_end', async () => {
    const fake = fakeSession();
    const committed: Array<{ id: string; text: string }> = [];
    const watch = watchPromptEntry(fake.asSession(), (entry) => committed.push(entry));
    watch.preflightResult('started');
    fake.isStreaming = true;
    fake.commit('u-prompt', user('build it'));
    // pi appends synchronously after notifying listeners, so nothing is reported inside the notification.
    expect(committed).toEqual([]);
    await Promise.resolve();
    expect(committed).toEqual([{ id: 'u-prompt', text: 'build it' }]);
    fake.commit('u-note', user('skip it'));
    await Promise.resolve();
    expect(committed).toHaveLength(1);
    watch.dispose();
  });

  it('reports nothing for a prompt pi queued into a running run', async () => {
    const fake = fakeSession();
    fake.isStreaming = true;
    const committed: unknown[] = [];
    const watch = watchPromptEntry(fake.asSession(), (entry) => committed.push(entry));
    watch.preflightResult('queued');
    fake.commit('u-other', user('someone else'));
    await Promise.resolve();
    expect(committed).toEqual([]);
    watch.dispose();
  });
});

describe('queuedPromptEntries', () => {
  const PNG: ImageContent = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' };
  const JPEG: ImageContent = { type: 'image', data: '/9j/4AAQ', mimeType: 'image/jpeg' };
  const ignored = { onCommitted: () => {}, onWithdrawn: () => {} };

  /** A prompt pi queued: pi pushes its text, then reports `queued`. */
  function queue(fake: FakeSession, entries: ReturnType<typeof queuedPromptEntries>, text: string, images: ImageContent[], handlers: QueuedPromptHandlers = ignored): void {
    fake.followUps.push(text);
    entries.add(fake.asSession(), images, handlers);
  }

  it('hands back each follow-up pi dropped with the images it was queued with, two of one text in the order pi queued them', () => {
    const fake = fakeSession();
    const entries = queuedPromptEntries();
    queue(fake, entries, 'look at this', [PNG]);
    queue(fake, entries, 'and fix it', []);
    queue(fake, entries, 'look at this', [JPEG]);

    // A follow-up another extension queued has no record and goes back as the text pi returned.
    const requeued = entries.requeue(fake.asSession(), ['look at this', 'and fix it', 'look at this', 'from an extension']);

    expect(requeued.map(({ text, images }) => ({ text, images }))).toEqual([
      { text: 'look at this', images: [PNG] },
      { text: 'and fix it', images: [] },
      { text: 'look at this', images: [JPEG] },
      { text: 'from an extension', images: [] },
    ]);
    expect(requeued.map((queued) => queued.withdrawn())).toEqual([false, false, false, false]);
  });

  it('withdraws every pending prompt oldest first, and pi delivering one afterwards claims nothing', async () => {
    const fake = fakeSession();
    const entries = queuedPromptEntries();
    const withdrawn: string[] = [];
    const committed: unknown[] = [];
    for (const text of ['first', 'second']) {
      queue(fake, entries, text, [], { onCommitted: (entry) => committed.push(entry), onWithdrawn: () => withdrawn.push(text) });
    }
    const [first] = entries.requeue(fake.asSession(), ['first']);

    entries.withdraw();
    entries.withdraw();

    expect(withdrawn).toEqual(['first', 'second']);
    expect(first?.withdrawn()).toBe(true);
    const message = user('first');
    expect(entries.claim(fake.asSession(), 'first', message)).toBe(false);
    fake.commit('u-first', message);
    await Promise.resolve();
    expect(committed).toEqual([]);
  });

  it('withdraws only the prompts queued on the session named, and never one pi already delivered', () => {
    const live = fakeSession();
    const replaced = fakeSession();
    const entries = queuedPromptEntries();
    const withdrawn: string[] = [];
    const record = (text: string) => ({ onCommitted: () => {}, onWithdrawn: () => withdrawn.push(text) });
    queue(replaced, entries, 'on the replaced session', [], record('on the replaced session'));
    queue(live, entries, 'delivered', [], record('delivered'));
    queue(live, entries, 'still queued', [], record('still queued'));

    entries.withdraw(replaced.asSession());
    expect(withdrawn).toEqual(['on the replaced session']);
    expect(entries.claim(live.asSession(), 'delivered', user('delivered'))).toBe(true);
    entries.withdraw(live.asSession());
    expect(withdrawn).toEqual(['on the replaced session', 'still queued']);
  });

  it('withdraws one prompt alone and once, and a prompt of the same text keeps its images', () => {
    const fake = fakeSession();
    const entries = queuedPromptEntries();
    const withdrawn: string[] = [];
    queue(fake, entries, 'look at this', [PNG], { onCommitted: () => {}, onWithdrawn: () => withdrawn.push('kept') });
    fake.followUps.push('look at this');
    const later = entries.add(fake.asSession(), [JPEG], { onCommitted: () => {}, onWithdrawn: () => withdrawn.push('withdrawn') });

    entries.withdrawOne(later!);
    entries.withdrawOne(later!);

    expect(withdrawn).toEqual(['withdrawn']);
    expect(entries.requeue(fake.asSession(), ['look at this']).map(({ text, images }) => ({ text, images }))).toEqual([{ text: 'look at this', images: [PNG] }]);
  });
});
