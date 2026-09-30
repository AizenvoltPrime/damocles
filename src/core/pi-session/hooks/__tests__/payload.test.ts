import { describe, it, expect } from 'vitest';
import {
  buildToolCallPayload,
  buildToolResultPayload,
  buildInputPayload,
  buildAgentEndPayload,
  buildPermissionRequiredPayload,
  buildSessionStartPayload,
  buildSessionEndPayload,
  buildPreCompactPayload,
  buildSessionCompactPayload,
  buildGenericPayload,
  buildForkPayload,
  messageToSimple,
  type HookCommon,
} from '../payload';

const common: HookCommon = { session_id: 's1', transcript_path: '/t.jsonl', cwd: '/ws' };

describe('payload builders (native contract)', () => {
  it('tool_call carries event + tool_name + input', () => {
    expect(buildToolCallPayload(common, 'Bash', { command: 'ls' })).toEqual({
      ...common,
      event: 'tool_call',
      tool_name: 'Bash',
      input: { command: 'ls' },
    });
  });

  it('tool_result carries event + result', () => {
    const p = buildToolResultPayload(common, 'Read', { file_path: '/a' }, { output: 'contents', is_error: false });
    expect(p['event']).toBe('tool_result');
    expect(p['result']).toEqual({ output: 'contents', is_error: false });
  });

  it('input carries event + prompt', () => {
    expect(buildInputPayload(common, 'hi')).toMatchObject({ event: 'input', prompt: 'hi' });
  });

  it('agent_end carries flattened messages and no stop_hook_active', () => {
    const p = buildAgentEndPayload(common, [{ role: 'assistant', content: 'done' }]);
    expect(p['event']).toBe('agent_end');
    expect(p['messages']).toEqual([{ role: 'assistant', content: 'done' }]);
    expect('stop_hook_active' in p).toBe(false);
  });

  it('subagent_end sets the event + parent_tool_use_id (snake_case wire contract)', () => {
    const p = buildAgentEndPayload(common, [], { subagent: true, parentToolUseId: 'tool-9' });
    expect(p['event']).toBe('subagent_end');
    expect(p['parent_tool_use_id']).toBe('tool-9');
  });

  it('permission_required carries the optional file_path/command + input', () => {
    const p = buildPermissionRequiredPayload(common, {
      message: 'awaiting',
      tool_name: 'Edit',
      input: { file_path: '/a' },
      file_path: '/a',
    });
    expect(p['event']).toBe('permission_required');
    expect(p['input']).toEqual({ file_path: '/a' });
    expect(p['file_path']).toBe('/a');
    expect(p['command']).toBeUndefined();
  });

  it('session_start carries reason', () => {
    expect(buildSessionStartPayload(common, 'resume')).toMatchObject({ event: 'session_start', reason: 'resume' });
  });

  it('session_shutdown carries reason', () => {
    expect(buildSessionEndPayload(common, 'quit')).toMatchObject({ event: 'session_shutdown', reason: 'quit' });
  });

  it('session_before_compact carries reason + will_retry', () => {
    expect(buildPreCompactPayload(common, 'manual', false)).toEqual({
      ...common,
      event: 'session_before_compact',
      reason: 'manual',
      will_retry: false,
    });
  });

  it('session_compact carries reason + will_retry + from_extension', () => {
    expect(buildSessionCompactPayload(common, 'overflow', true, false)).toEqual({
      ...common,
      event: 'session_compact',
      reason: 'overflow',
      will_retry: true,
      from_extension: false,
    });
  });

  it('generic observe-only payload uses the pi event key as event', () => {
    expect(buildGenericPayload(common, 'turn_end')).toMatchObject({ event: 'turn_end' });
  });

  it('fork payload carries parent/new session ids + entry id', () => {
    expect(buildForkPayload(common, { parentSessionId: 's1', entryId: 'e9', newSessionId: 's2' })).toMatchObject({
      event: 'session_before_fork',
      parent_session_id: 's1',
      entry_id: 'e9',
      new_session_id: 's2',
    });
  });

  it('fork payload omits entry/new ids when absent (fork from first message)', () => {
    const p = buildForkPayload(common, { parentSessionId: 's1' });
    expect(p['event']).toBe('session_before_fork');
    expect(p['parent_session_id']).toBe('s1');
    expect('entry_id' in p).toBe(false);
    expect('new_session_id' in p).toBe(false);
  });
});

describe('messageToSimple', () => {
  it('joins text blocks', () => {
    expect(messageToSimple({ role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toEqual({
      role: 'assistant',
      content: 'a\nb',
    });
  });

  it('passes string content through', () => {
    expect(messageToSimple({ role: 'user', content: 'hi' })).toEqual({ role: 'user', content: 'hi' });
  });
});
