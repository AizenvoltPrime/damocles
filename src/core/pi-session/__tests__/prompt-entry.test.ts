import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { watchPromptEntry } from '../prompt-entry';

interface FakeSession {
  isStreaming: boolean;
  listeners: Set<(event: unknown) => void>;
  branch: Array<{ type: 'message'; id: string; message: unknown }>;
  /** pi's order: listeners hear message_end, then the message is appended to the tree. */
  commit: (id: string, message: { role: string; content: unknown }) => void;
  asSession: () => AgentSession;
}

function fakeSession(): FakeSession {
  const listeners = new Set<(event: unknown) => void>();
  const branch: FakeSession['branch'] = [];
  const fake: FakeSession = {
    isStreaming: false,
    listeners,
    branch,
    commit: (id, message) => {
      for (const listener of [...listeners]) listener({ type: 'message_end', message });
      branch.push({ type: 'message', id, message });
    },
    asSession: () =>
      ({
        get isStreaming() { return fake.isStreaming; },
        subscribe: (listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        sessionManager: { getLeafId: () => branch.at(-1)?.id ?? null, getBranch: () => branch },
      }) as unknown as AgentSession,
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
    watch.preflightResult(true);
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

    watch.preflightResult(true);
    fake.commit('u-other', user('a steer the running run delivered'));

    expect(watch.entry()).toBeNull();
    watch.dispose();
  });

  it('names no entry when pi ran the prompt as a command and committed nothing', () => {
    const fake = fakeSession();
    fake.commit('u-prior', user('earlier prompt'));
    const watch = watchPromptEntry(fake.asSession());

    watch.preflightResult(true);

    expect(watch.entry()).toBeNull();
    watch.dispose();
  });

  it('names no entry when pi refused the prompt', () => {
    const fake = fakeSession();
    const watch = watchPromptEntry(fake.asSession());

    watch.preflightResult(false);
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
    watch.preflightResult(true);
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
    watch.preflightResult(true);
    fake.commit('u-other', user('someone else'));
    await Promise.resolve();
    expect(committed).toEqual([]);
    watch.dispose();
  });
});
