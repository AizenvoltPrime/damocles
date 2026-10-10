import { describe, it, expect } from 'vitest';
import { CANCELLED_TOOL_DETAIL_KEY } from '../../../shared/types/session';
import { DAMOCLES_TURN_STOPPED_ENTRY } from '../session-store/constants';
import { registerAbortSettledCallRecord, registerStoppedToolResultMarker, registerWindDownErrorRecord } from '../stopped-tool-result';

type Handler = (event: Record<string, unknown>, ctx: { signal: AbortSignal | undefined }) => unknown;

function registered(): Handler {
  const handlers: Array<{ name: string; handler: Handler }> = [];
  registerStoppedToolResultMarker({ on: (name: string, handler: Handler) => handlers.push({ name, handler }) } as never);
  expect(handlers.map((h) => h.name)).toEqual(['tool_result']);
  return handlers[0]!.handler;
}

function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

const killed = { type: 'tool_result', toolName: 'bash', toolCallId: 't1', input: { command: 'sleep 20' }, content: [{ type: 'text', text: 'Command aborted' }], isError: true };

describe('registerStoppedToolResultMarker', () => {
  it('marks an error result that ended while its run was aborted, keeping the details the tool returned', () => {
    expect(registered()({ ...killed, details: { fullOutputPath: '/tmp/out' } }, { signal: aborted() })).toEqual({
      details: { fullOutputPath: '/tmp/out', [CANCELLED_TOOL_DETAIL_KEY]: true },
    });
  });

  it('marks an error result whose details are not a plain object', () => {
    expect(registered()({ ...killed, details: undefined }, { signal: aborted() })).toEqual({ details: { [CANCELLED_TOOL_DETAIL_KEY]: true } });
    expect(registered()({ ...killed, details: ['x'] }, { signal: aborted() })).toEqual({ details: { [CANCELLED_TOOL_DETAIL_KEY]: true } });
  });

  it('leaves an error result alone while the run is live', () => {
    expect(registered()({ ...killed, details: {} }, { signal: new AbortController().signal })).toBeUndefined();
    expect(registered()({ ...killed, details: {} }, { signal: undefined })).toBeUndefined();
  });

  it('leaves a result that succeeded under the aborted run alone', () => {
    expect(registered()({ ...killed, isError: false, details: {} }, { signal: aborted() })).toBeUndefined();
  });
});

describe('registerAbortSettledCallRecord', () => {
  type EndHandler = (event: Record<string, unknown>, ctx: { signal: AbortSignal | undefined }) => unknown;

  function recorder(): { handler: EndHandler; appended: Array<{ customType: string; data: unknown }> } {
    const handlers: Array<{ name: string; handler: EndHandler }> = [];
    const appended: Array<{ customType: string; data: unknown }> = [];
    registerAbortSettledCallRecord({
      on: (name: string, handler: EndHandler) => handlers.push({ name, handler }),
      appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
    } as never);
    expect(handlers.map((h) => h.name)).toEqual(['tool_execution_end']);
    return { handler: handlers[0]!.handler, appended };
  }

  const settled = { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [{ type: 'text', text: 'Operation aborted' }], details: {} }, isError: true };

  // agent-loop.js:500-504, :519-523 and :435-438 settle a call under the aborted signal before `execute`, with no durationMs (:646-655).
  it('records a call the aborted run settled before it ran, in the turn-stopped shape', () => {
    const { handler, appended } = recorder();
    handler(settled, { signal: aborted() });
    expect(appended).toEqual([{ customType: DAMOCLES_TURN_STOPPED_ENTRY, data: { toolCallIds: ['t1'], entryIds: [] } }]);
  });

  it('records nothing for a call pi executed, or one settled while the run was live', () => {
    const { handler, appended } = recorder();
    handler({ ...settled, durationMs: 812 }, { signal: aborted() });
    handler(settled, { signal: new AbortController().signal });
    handler(settled, { signal: undefined });
    expect(appended).toEqual([]);
  });
});

describe('registerWindDownErrorRecord', () => {
  type TurnEndHandler = (event: Record<string, unknown>, ctx: { signal: AbortSignal | undefined }) => unknown;

  function turnEndHandler(): TurnEndHandler {
    const handlers: Array<{ name: string; handler: TurnEndHandler }> = [];
    registerWindDownErrorRecord({ on: (name: string, handler: TurnEndHandler) => handlers.push({ name, handler }) } as never);
    expect(handlers.map((h) => h.name)).toEqual(['turn_end']);
    return handlers[0]!.handler;
  }

  const earlier = { type: 'context_edit', targetId: 'e1', replacement: { content: [] } };
  // pi-ai's lazy stream turns a request setup rejected by the aborted signal into an error stop (lazy.js:41-44 in pi-ai 1.1.0).
  const windDown = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'This operation was aborted' };
  const turnEnd = (message: unknown) => ({ type: 'turn_end', message, toolResults: [], messageEntryId: 'a7', entries: [earlier] });

  it('records the entry of an error stop that ended while its run was aborted, keeping earlier drafts', () => {
    expect(turnEndHandler()(turnEnd(windDown), { signal: aborted() })).toEqual({
      entries: [earlier, { type: 'custom', customType: DAMOCLES_TURN_STOPPED_ENTRY, data: { toolCallIds: [], entryIds: ['a7'] } }],
    });
  });

  it('records nothing for a failure while the run is live, an aborted stop, or a call that answered', () => {
    const handler = turnEndHandler();
    expect(handler(turnEnd(windDown), { signal: new AbortController().signal })).toBeUndefined();
    expect(handler(turnEnd(windDown), { signal: undefined })).toBeUndefined();
    expect(handler(turnEnd({ ...windDown, stopReason: 'aborted' }), { signal: aborted() })).toBeUndefined();
    expect(handler(turnEnd({ role: 'assistant', content: [], stopReason: 'stop' }), { signal: aborted() })).toBeUndefined();
  });
});
