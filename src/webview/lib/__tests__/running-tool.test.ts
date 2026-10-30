import { describe, expect, it } from 'vitest';
import type { ChatMessage, ToolCall } from '@shared/types/session';
import type { SubagentState } from '@shared/types/subagents';
import { runningToolName } from '../running-tool';

const call = (id: string, name: string, status: ToolCall['status']): ToolCall => ({ id, name, input: {}, status });
const assistant = (...toolCalls: ToolCall[]): ChatMessage => ({ id: `m-${toolCalls[0]?.id ?? 'none'}`, role: 'assistant', content: '', timestamp: 0, toolCalls });
const user = (id: string, flags: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'user', content: id, timestamp: 0, ...flags });
const subagent = (messages: ChatMessage[], toolCalls: ToolCall[]): SubagentState =>
  ({ id: 'tc-agent', description: 'd', prompt: 'p', status: 'running', startTime: 0, messages, toolCalls }) as SubagentState;
const none = (): undefined => undefined;

describe('runningToolName', () => {
  it('names no tool while every call has ended', () => {
    expect(runningToolName([assistant(call('a', 'Read', 'completed'), call('b', 'Bash', 'failed'))], none)).toBeNull();
    expect(runningToolName([assistant(call('a', 'Bash', 'unrecorded'), call('b', 'Bash', 'abandoned'))], none)).toBeNull();
  });

  it('names the newest call that has not ended, pending, running or waiting for approval', () => {
    const older = assistant(call('a', 'Grep', 'running'));
    expect(runningToolName([older, assistant(call('b', 'Read', 'running'), call('c', 'Bash', 'completed'))], none)).toBe('Read');
    expect(runningToolName([assistant(call('a', 'Bash', 'pending'))], none)).toBe('Bash');
    expect(runningToolName([assistant(call('a', 'Bash', 'awaiting_approval'))], none)).toBe('Bash');
    expect(runningToolName([assistant(call('a', 'Edit', 'approved'))], none)).toBe('Edit');
  });

  // A run that ends on a `terminate` batch leaves its other calls pending on the page that watched it.
  it('never names a call an earlier turn left pending', () => {
    const earlier = [user('p1'), assistant(call('a', 'Read', 'pending'), call('b', 'Bash', 'denied'))];
    expect(runningToolName([...earlier, user('p2'), { ...assistant(), content: 'thinking' }], none)).toBeNull();
    expect(runningToolName([...earlier, user('p2'), assistant(call('c', 'Grep', 'completed'))], none)).toBeNull();
    expect(runningToolName([...earlier, user('p2'), assistant(call('c', 'Grep', 'running'))], none)).toBe('Grep');
  });

  // A steer, a queued message delivered mid-run, a cancel note or a command echo joins the turn under way.
  it('looks past rows delivered into the running turn, back to the prompt that opened it', () => {
    const opened = [user('p0'), assistant(call('old', 'Read', 'pending')), user('p1'), assistant(call('a', 'Bash', 'running'))];
    const delivered = [user('steer', { isCombinedQueue: true }), user('note', { isInjected: true }), user('queued', { isQueued: true, isInjected: true })];
    expect(runningToolName([...opened, ...delivered, { ...assistant(), content: 'text' }], none)).toBe('Bash');
  });

  // The name is recomputed on every streaming delta, so its cost must not grow with the conversation.
  it('reads nothing older than the prompt that opened the turn', () => {
    const unread = new Proxy(assistant(), { get: () => { throw new Error('read a row of an earlier turn'); } });
    expect(runningToolName([unread, user('p1'), { ...assistant(), content: 'text' }], none)).toBeNull();
  });

  // One of two parallel calls ending leaves the other running, so the bar keeps naming it.
  it('keeps naming a parallel call after its sibling ends', () => {
    expect(runningToolName([assistant(call('a', 'Bash', 'running'), call('b', 'Read', 'completed'))], none)).toBe('Bash');
  });

  it("names a running Agent call's subagent tool, its newest live one first, else the Agent", () => {
    const agent = [assistant(call('tc-agent', 'Agent', 'running'))];
    const live = subagent([assistant(call('s1', 'Grep', 'running'))], [call('s2', 'Bash', 'running')]);
    expect(runningToolName(agent, (id) => (id === 'tc-agent' ? live : undefined))).toBe('Bash');
    const sealed = subagent([assistant(call('s1', 'Grep', 'running'))], [call('s2', 'Bash', 'completed')]);
    expect(runningToolName(agent, () => sealed)).toBe('Grep');
    expect(runningToolName(agent, () => subagent([], [call('s2', 'Bash', 'completed')]))).toBe('Agent');
    expect(runningToolName(agent, none)).toBe('Agent');
  });

  // A background subagent's call returned at launch, so its tools are not the main chat's.
  it('never names the tool of a subagent whose Agent call ended', () => {
    const launched = [assistant(call('tc-agent', 'Agent', 'completed'))];
    expect(runningToolName(launched, () => subagent([], [call('s2', 'Bash', 'running')]))).toBeNull();
  });
});
