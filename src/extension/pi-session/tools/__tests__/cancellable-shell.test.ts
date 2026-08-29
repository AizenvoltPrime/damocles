import { describe, it, expect, vi, afterEach } from 'vitest';
import { Type } from 'typebox';
// The REAL pi bash factory. The schema-parity assertion below is worth nothing against a stub: its
// whole job is to fail when a pi upgrade reshapes the bash schema and the override still ships the old one.
// Test files may value-import the ESM pi package; extension source may not.
import { createBashToolDefinition, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { PiCodingAgentModule } from '../../pi-loader';
import { withPerCallCancel, SHELL_ABORTED_DETAIL_KEY } from '../cancellable-shell';
import { ShellCancelStore, sanitizeCancelNote, MAX_CANCEL_NOTE_CHARS, type ShellCancelRegistry } from '../shell-cancel-registry';
import { createBashTool, type ShellOptions } from '../bash-tool';
import { CANCELLED_TOOL_DETAIL_KEY } from '../../../../shared/types/session';
import { normalizeToolDetails } from '../../tool-normalization';
import { reconstructMessages } from '../../session-store/history-loader';

/**
 * The per-call cancel path. Three guarantees are asserted directly rather than read off the
 * implementation: a user cancel produces a non-error result, it leaves the run-level controller
 * unaborted so stopping one command never ends the turn, and it marks the result so the card can be
 * told from a success both live and after a reload.
 * Both upstream shapes are exercised because the two shell tools disagree, pi's bash throwing its
 * partial inside the error message while `powershell-tool.ts` returns it.
 * The note is deliberately not asserted in the result text, because it is delivered as a real user
 * message and the case below asserting the old `[User note: ...]` line is gone keeps it that way.
 */

const shellSchema = Type.Object({ command: Type.String() });

/** pi's `ExtensionContext`; nothing on the cancel path reads it. */
const ctx = {} as never;

/** The tool result's leading text block, asserting it IS text rather than reading `undefined`. */
function textOf(result: AgentToolResult<unknown>): string {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('tool result did not start with a text block');
  return first.text;
}

/** A store plus the per-context handle a shell tool registers into, and the notes that context received. */
function boundStore(): { store: ShellCancelStore; registry: ShellCancelRegistry; delivered: string[] } {
  const delivered: string[] = [];
  const store = new ShellCancelStore();
  return { store, registry: store.forContext((text) => delivered.push(text)), delivered };
}

/**
 * A shell whose `execute` settles only once the signal it was handed aborts, so a test drives the
 * timing with the abort itself and never with a wall-clock wait. `started` resolves after the abort
 * listener is installed, which is what makes a cancel from the test unable to land too early. The
 * returning shape carries the abort marker `powershell-tool.ts` sets, or it would model a tool that
 * finished normally rather than one that saw the abort.
 */
function abortingShell(
  partial: string,
  shape: 'throws' | 'returns',
  thrown?: Error,
): { definition: ToolDefinition; started: Promise<void>; upstreamReturn: AgentToolResult<unknown> } {
  const upstreamReturn: AgentToolResult<unknown> = {
    content: [{ type: 'text', text: `PowerShell command aborted.\n${partial}` }],
    details: { [SHELL_ABORTED_DETAIL_KEY]: true },
  };
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const definition: ToolDefinition = {
    name: 'bash',
    label: 'Bash',
    description: 'a shell that runs until it is aborted',
    parameters: shellSchema,
    async execute(_toolCallId, _params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: 'text', text: partial }], details: { truncation: { truncated: true }, fullOutputPath: '/tmp/full.log' } });
      const aborted = new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      markStarted();
      await aborted;
      if (shape === 'throws') throw thrown ?? new Error(`${partial}\n\nCommand aborted`);
      return upstreamReturn;
    },
  };
  return { definition, started, upstreamReturn };
}

/** A shell that settles at once, for the exit paths that never see an abort. */
function immediateShell(outcome: { text: string } | { error: Error }): ToolDefinition {
  return {
    name: 'bash',
    label: 'Bash',
    description: 'a shell that settles immediately',
    parameters: shellSchema,
    async execute() {
      if ('error' in outcome) throw outcome.error;
      return { content: [{ type: 'text', text: outcome.text }], details: undefined };
    },
  };
}

/** `cancel` answering `true` is the only outside evidence that an entry is still registered. */
function stillRegistered(store: ShellCancelStore, toolCallId: string): boolean {
  return store.cancel(toolCallId);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('withPerCallCancel: user cancel', () => {
  it('returns a NON-ERROR result carrying the partial and the duration line, and leaves the run controller unaborted', async () => {
    // Fake timers make the elapsed-seconds line exact instead of a loose pattern match.
    vi.useFakeTimers();
    const { store, registry } = boundStore();
    const shell = abortingShell('line 1\nline 2', 'throws');
    const wrapped = withPerCallCancel(shell.definition, registry);
    const run = new AbortController();
    const onUpdate = vi.fn();

    const pending = wrapped.execute('call-1', { command: 'sleep 300' }, run.signal, onUpdate, ctx);
    await shell.started;
    vi.advanceTimersByTime(12_400);
    expect(store.cancel('call-1', 'wrong dir, use seq 1 5')).toBe(true);

    const result = await pending;
    const text = textOf(result);
    expect(text).toContain('line 1\nline 2');
    expect(text).toContain("[Command cancelled by the user after 12.4s. The output above is partial. The user's reason follows in their next message.]");
    // The independence guarantee: cancelling one call must never signal the run controller.
    expect(run.signal.aborted).toBe(false);
    // The partial's details carry truncation state and the overflow path the abort body does not, so
    // they must survive alongside the marker rather than be replaced by it.
    expect(result.details).toEqual({ truncation: { truncated: true }, fullOutputPath: '/tmp/full.log', [CANCELLED_TOOL_DETAIL_KEY]: true });
    expect(onUpdate).toHaveBeenCalledWith({ content: [{ type: 'text', text: 'line 1\nline 2' }], details: { truncation: { truncated: true }, fullOutputPath: '/tmp/full.log' } });
  });

  it('composes the same result when the upstream RETURNS its partial instead of throwing it', async () => {
    vi.useFakeTimers();
    const { store, registry } = boundStore();
    const shell = abortingShell('Get-ChildItem output', 'returns');
    const wrapped = withPerCallCancel(shell.definition, registry);
    const run = new AbortController();

    const pending = wrapped.execute('call-2', { command: 'sleep 300' }, run.signal, undefined, ctx);
    await shell.started;
    vi.advanceTimersByTime(3_000);
    expect(store.cancel('call-2')).toBe(true);

    const result = await pending;
    const text = textOf(result);
    expect(text).toContain('PowerShell command aborted.\nGet-ChildItem output');
    // No note was sent, so the trailer must promise no follow-up message that will never arrive.
    expect(text).toContain('[Command cancelled by the user after 3.0s. The output above is partial.]');
    expect(text).not.toContain('follows in their next message');
    expect(run.signal.aborted).toBe(false);
    // The marker rides on details even when no partial ever arrived to merge onto.
    expect(result.details).toEqual({ [CANCELLED_TOOL_DETAIL_KEY]: true });
  });

  it('runs with no run-level signal at all, since the per-call controller is the only one required', async () => {
    vi.useFakeTimers();
    const { store, registry } = boundStore();
    const shell = abortingShell('partial', 'throws');
    const wrapped = withPerCallCancel(shell.definition, registry);

    const pending = wrapped.execute('call-3', { command: 'sleep 300' }, undefined, undefined, ctx);
    await shell.started;
    vi.advanceTimersByTime(1_500);
    expect(store.cancel('call-3', 'enough')).toBe(true);

    const text = textOf(await pending);
    expect(text).toContain("[Command cancelled by the user after 1.5s. The output above is partial. The user's reason follows in their next message.]");
  });

  it('never puts the note itself in the tool result, which is what the model reads as injected text', async () => {
    const { store, registry } = boundStore();
    const shell = abortingShell('partial', 'throws');
    const wrapped = withPerCallCancel(shell.definition, registry);

    const pending = wrapped.execute('call-note', { command: 'sleep 300' }, undefined, undefined, ctx);
    await shell.started;
    store.cancel('call-note', 'wrong loop, use seq 1 5');

    const text = textOf(await pending);
    expect(text).not.toContain('[User note:');
    expect(text).not.toContain('wrong loop, use seq 1 5');
  });
});

describe('withPerCallCancel: run-level abort', () => {
  it('rethrows the upstream error unchanged and composes nothing', async () => {
    const { registry } = boundStore();
    const upstream = new Error('partial output\n\nCommand aborted');
    const shell = abortingShell('partial output', 'throws', upstream);
    const wrapped = withPerCallCancel(shell.definition, registry);
    const run = new AbortController();

    const pending = wrapped.execute('call-4', { command: 'sleep 300' }, run.signal, undefined, ctx);
    await shell.started;
    run.abort();

    // Identity, not message equality: a rewrapped error would still read the same and would still
    // have lost whatever the agent loop keys off.
    await expect(pending).rejects.toBe(upstream);
    expect(upstream.message).not.toContain('[Command cancelled by the user');
  });

  it('returns the upstream result object untouched when the upstream RETURNS on a run abort', async () => {
    const { registry } = boundStore();
    const shell = abortingShell('partial output', 'returns');
    const wrapped = withPerCallCancel(shell.definition, registry);
    const run = new AbortController();

    const pending = wrapped.execute('call-5', { command: 'sleep 300' }, run.signal, undefined, ctx);
    await shell.started;
    run.abort();

    const result = await pending;
    expect(result).toBe(shell.upstreamReturn);
    // A run abort is not a user cancel, so the marker must be absent or the card would read cancelled.
    expect(result.details).toEqual({ [SHELL_ABORTED_DETAIL_KEY]: true });
    expect((result.details as Record<string, unknown>)[CANCELLED_TOOL_DETAIL_KEY]).toBeUndefined();
  });

  it('propagates a run abort into the call, so a full-run interrupt still stops the command', async () => {
    const { registry } = boundStore();
    const shell = abortingShell('partial output', 'returns');
    const wrapped = withPerCallCancel(shell.definition, registry);
    const run = new AbortController();

    const pending = wrapped.execute('call-6', { command: 'sleep 300' }, run.signal, undefined, ctx);
    await shell.started;
    run.abort();

    // The shell only settles when the signal it was handed aborts, so settling IS the propagation.
    await expect(pending).resolves.toBeDefined();
  });
});

describe('withPerCallCancel: a cancel that lands after the command finished', () => {
  /** A shell whose command is done well before its tool promise settles, the window pi's bash spends writing its full-output file. */
  function lateSettlingShell(text: string): { definition: ToolDefinition; commandDone: Promise<void>; settle: () => void } {
    let markDone!: () => void;
    const commandDone = new Promise<void>((resolve) => {
      markDone = resolve;
    });
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const definition: ToolDefinition = {
      name: 'bash',
      label: 'Bash',
      description: 'a shell whose command finishes before the tool settles',
      parameters: shellSchema,
      async execute() {
        markDone();
        await gate;
        return { content: [{ type: 'text', text }], details: undefined };
      },
    };
    return { definition, commandDone, settle };
  }

  it('returns the complete result unchanged instead of relabelling it partial', async () => {
    const { store, registry } = boundStore();
    const shell = lateSettlingShell('all 400 lines of output');
    const wrapped = withPerCallCancel(shell.definition, registry);

    const pending = wrapped.execute('call-late', { command: 'ls -R' }, undefined, undefined, ctx);
    await shell.commandDone;
    // The entry is still registered so the Stop click is accepted, yet the command is already done.
    expect(store.cancel('call-late', 'never mind')).toBe(true);
    shell.settle();

    const result = await pending;
    expect(textOf(result)).toBe('all 400 lines of output');
    expect(textOf(result)).not.toContain('The output above is partial');
    // No cancelled marker either: the card must read as the success it was.
    expect(result.details).toBeUndefined();
  });
});

/**
 * `details` is `unknown` upstream and `typeof [] === 'object'`, so both places that inspect it have to
 * exclude arrays by hand. No shell tool returns an array today, which is exactly why nothing else here
 * would notice if either check stopped doing it.
 */
describe('withPerCallCancel: details that are an array', () => {
  /** A shell that emits one array-valued partial and then throws its partial the way pi's bash does. */
  function arrayPartialShell(): { definition: ToolDefinition; started: Promise<void> } {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const definition: ToolDefinition = {
      name: 'bash',
      label: 'Bash',
      description: 'a shell whose partial details are an array',
      parameters: shellSchema,
      async execute(_toolCallId, _params, signal, onUpdate) {
        onUpdate?.({ content: [{ type: 'text', text: 'partial' }], details: ['/tmp/a.log', '/tmp/b.log'] });
        const aborted = new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        markStarted();
        await aborted;
        throw new Error('partial\n\nCommand aborted');
      },
    };
    return { definition, started };
  }

  it('drops an array-valued partial detail rather than spreading it into index keys', async () => {
    const { store, registry } = boundStore();
    const shell = arrayPartialShell();
    const wrapped = withPerCallCancel(shell.definition, registry);

    const pending = wrapped.execute('call-array', { command: 'sleep 300' }, undefined, vi.fn(), ctx);
    await shell.started;
    store.cancel('call-array');

    const result = await pending;
    // Spreading an array produces `{0: '/tmp/a.log', 1: '/tmp/b.log'}`, which reaches the card and the
    // session record as detail fields no tool ever set.
    expect(result.details).toEqual({ [CANCELLED_TOOL_DETAIL_KEY]: true });
    expect(result.details).not.toHaveProperty('0');
  });

  it('never reads an array as the marker a returning tool sets to report an abort', async () => {
    const { store, registry } = boundStore();
    // The property has to be on the array itself: a plain array answers `undefined` for it either way,
    // so only this shape tells the array check apart from the property read that follows it.
    const details = ['out'] as string[] & Record<string, unknown>;
    details[SHELL_ABORTED_DETAIL_KEY] = true;
    const upstreamReturn: AgentToolResult<unknown> = { content: [{ type: 'text', text: 'complete output' }], details };
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const definition: ToolDefinition = {
      name: 'bash',
      label: 'Bash',
      description: 'a shell that returns array details on abort',
      parameters: shellSchema,
      async execute(_toolCallId, _params, signal) {
        const aborted = new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        markStarted();
        await aborted;
        return upstreamReturn;
      },
    };
    const wrapped = withPerCallCancel(definition, registry);

    const pending = wrapped.execute('call-array-marker', { command: 'sleep 300' }, undefined, undefined, ctx);
    await started;
    store.cancel('call-array-marker');

    // Returned untouched: an array is not the details object a shell tool reports an abort through, so
    // the wrapper must not compose the cancelled shape off it.
    expect(await pending).toBe(upstreamReturn);
  });
});

describe('withPerCallCancel: registry lifetime', () => {
  it('releases the entry on the resolving exit path', async () => {
    const { store, registry } = boundStore();
    const wrapped = withPerCallCancel(immediateShell({ text: 'done' }), registry);

    await wrapped.execute('call-7', { command: 'ls' }, undefined, undefined, ctx);

    expect(stillRegistered(store, 'call-7')).toBe(false);
  });

  it('releases the entry on the THROWING exit path', async () => {
    const { store, registry } = boundStore();
    const failure = new Error('spawn ENOENT');
    const wrapped = withPerCallCancel(immediateShell({ error: failure }), registry);

    await expect(wrapped.execute('call-8', { command: 'ls' }, undefined, undefined, ctx)).rejects.toBe(failure);

    expect(stillRegistered(store, 'call-8')).toBe(false);
  });

  it('releases the entry on the user-cancel exit path, so a second Stop click is a no-op', async () => {
    const { store, registry } = boundStore();
    const shell = abortingShell('partial', 'throws');
    const wrapped = withPerCallCancel(shell.definition, registry);

    const pending = wrapped.execute('call-9', { command: 'sleep 300' }, undefined, undefined, ctx);
    await shell.started;
    // The probe answers true while the call is live, which is what stops the assertions below from
    // passing against a registry that never registered anything.
    expect(stillRegistered(store, 'call-9')).toBe(true);
    await pending;

    expect(stillRegistered(store, 'call-9')).toBe(false);
  });
});

describe('ShellCancelStore: note delivery', () => {
  it('delivers the sanitized note to the context that registered the call, exactly once', async () => {
    const { store, registry, delivered } = boundStore();
    const shell = abortingShell('partial', 'throws');
    const wrapped = withPerCallCancel(shell.definition, registry);

    const pending = wrapped.execute('call-10', { command: 'sleep 300' }, undefined, undefined, ctx);
    await shell.started;
    store.cancel('call-10', '  wrong loop, use seq 1 5  ');
    await pending;

    expect(delivered).toEqual(['wrong loop, use seq 1 5']);
  });

  it('ignores a second cancel for the same call, so a repeat Stop click queues no second user turn', async () => {
    const { store, registry, delivered } = boundStore();
    const shell = abortingShell('partial', 'throws');
    const wrapped = withPerCallCancel(shell.definition, registry);

    const pending = wrapped.execute('call-14', { command: 'sleep 300' }, undefined, undefined, ctx);
    await shell.started;
    expect(store.cancel('call-14', 'wrong dir')).toBe(true);
    // The entry lives until the shell actually dies, which is the window a second click lands in.
    expect(store.cancel('call-14', 'still wrong')).toBe(false);
    await pending;

    expect(delivered).toEqual(['wrong dir']);
  });

  it('routes to the context that registered THAT call, never to another agent sharing the store', async () => {
    const store = new ShellCancelStore();
    const main: string[] = [];
    const sub: string[] = [];
    const mainShell = abortingShell('main partial', 'throws');
    const subShell = abortingShell('sub partial', 'throws');
    const mainTool = withPerCallCancel(mainShell.definition, store.forContext((t) => main.push(t)));
    const subTool = withPerCallCancel(subShell.definition, store.forContext((t) => sub.push(t)));

    const mainPending = mainTool.execute('main-call', { command: 'sleep 300' }, undefined, undefined, ctx);
    const subPending = subTool.execute('sub-call', { command: 'sleep 300' }, undefined, undefined, ctx);
    await Promise.all([mainShell.started, subShell.started]);

    store.cancel('sub-call', 'wrong dir');
    await subPending;

    expect(sub).toEqual(['wrong dir']);
    expect(main).toEqual([]);
    // The main call is still live and only settles when its own signal aborts, which is also what
    // proves the sub cancel above did not reach across to it.
    expect(store.cancel('main-call')).toBe(true);
    await mainPending;
  });

  it('delivers nothing when the user sent no note, so no empty user turn is queued', async () => {
    const { store, registry, delivered } = boundStore();
    const shell = abortingShell('partial', 'throws');
    const wrapped = withPerCallCancel(shell.definition, registry);

    const pending = wrapped.execute('call-11', { command: 'sleep 300' }, undefined, undefined, ctx);
    await shell.started;
    store.cancel('call-11');
    store.cancel('call-12', '   ');
    await pending;

    expect(delivered).toEqual([]);
  });

  it('aborts the command BEFORE delivering, so the note never delays the kill', () => {
    const store = new ShellCancelStore();
    const order: string[] = [];
    const registry = store.forContext(() => order.push('deliver'));
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => order.push('abort'), { once: true });
    registry.register('call-13', controller);

    store.cancel('call-13', 'stop that');

    expect(order).toEqual(['abort', 'deliver']);
  });

  it('answers false for an unknown id and delivers nothing, which is a Stop click that lost the race', () => {
    const { store, delivered } = boundStore();

    expect(store.cancel('never-registered', 'too late')).toBe(false);
    expect(delivered).toEqual([]);
  });
});

describe('the cancelled marker reaches toolMetadata', () => {
  /** The real wrapper's result for one cancelled call, so the paths below carry real details. */
  async function cancelledResult(): Promise<AgentToolResult<unknown>> {
    const { store, registry } = boundStore();
    const shell = abortingShell('partial', 'throws');
    const wrapped = withPerCallCancel(shell.definition, registry);
    const pending = wrapped.execute('marker-call', { command: 'sleep 300' }, undefined, vi.fn(), ctx);
    await shell.started;
    store.cancel('marker-call');
    return pending;
  }

  it('survives the live path, which normalizes the result details into the toolMetadata payload', async () => {
    const result = await cancelledResult();

    // The exact call `pi-stream-adapter.ts` and `subagent-stream-bridge.ts` make on `result.details`.
    const metadata = normalizeToolDetails(result.details as Record<string, unknown>);

    expect(metadata[CANCELLED_TOOL_DETAIL_KEY]).toBe(true);
    expect(metadata['fullOutputPath']).toBe('/tmp/full.log');
  });

  it('survives the reload path, arriving on the replayed tool call metadata', async () => {
    const result = await cancelledResult();
    const branch = [
      {
        id: 'a1',
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'marker-call', name: 'bash', arguments: { command: 'sleep 300' } }] },
      },
      {
        id: 'r1',
        type: 'message',
        message: { role: 'toolResult', toolCallId: 'marker-call', content: [{ type: 'text', text: 'partial' }], details: result.details },
      },
    ];

    const { messages } = reconstructMessages(branch as never);

    const assistant = messages.find((m) => m.kind === 'assistant');
    if (assistant?.kind !== 'assistant') throw new Error('no assistant message was replayed');
    const tool = assistant.tools[0];
    // Non-vacuous: the replay must have produced a real tool call before its metadata means anything.
    expect(tool?.id).toBe('marker-call');
    expect(tool?.metadata?.[CANCELLED_TOOL_DETAIL_KEY]).toBe(true);
  });
});

describe('sanitizeCancelNote', () => {
  it('keeps newlines and tabs, which the note textarea makes meaningful', () => {
    expect(sanitizeCancelNote('wrong dir\nrun the one file')).toBe('wrong dir\nrun the one file');
    expect(sanitizeCancelNote('a\tb')).toBe('a\tb');
    expect(sanitizeCancelNote('first\r\nsecond')).toBe('first\r\nsecond');
  });

  it('strips an RTL override, because the same text is read by a human in the panel', () => {
    expect(sanitizeCancelNote('safe\u202etxt.exe')).toBe('safetxt.exe');
  });

  it('trims surrounding whitespace so a whitespace-only note counts as no note', () => {
    expect(sanitizeCancelNote('  \n  ')).toBe('');
  });

  it(`truncates at ${MAX_CANCEL_NOTE_CHARS} characters with an ellipsis`, () => {
    expect(MAX_CANCEL_NOTE_CHARS).toBe(500);
    expect(sanitizeCancelNote('a'.repeat(600))).toBe(`${'a'.repeat(500)}\u2026`);
    // At the cap exactly, nothing is added.
    expect(sanitizeCancelNote('a'.repeat(500))).toBe('a'.repeat(500));
  });

  it('caps a multi-line note by characters, counting the newlines it keeps', () => {
    const note = `${'a'.repeat(300)}\n${'b'.repeat(300)}`;
    expect(sanitizeCancelNote(note)).toBe(`${note.slice(0, 500)}\u2026`);
  });
});

describe('createBashTool', () => {
  const deps = (getShellOptions: () => ShellOptions) => ({ getShellOptions, cancelRegistry: new ShellCancelStore().forContext(() => undefined), shellJob: undefined });

  it('registers under the literal lowercase pi name', () => {
    const pi = { createBashToolDefinition } as unknown as PiCodingAgentModule;
    const tool = createBashTool(pi, '/cwd', deps(() => ({})));

    // Lowercase `bash` is what makes this an override rather than a thirteenth tool, and it is what
    // the permission gate and the active-set lists already key off.
    expect(tool.name).toBe('bash');
  });

  it("keeps pi's own bash parameter schema, so a pi upgrade cannot leave a stale copy shipping", () => {
    const pi = { createBashToolDefinition } as unknown as PiCodingAgentModule;
    const tool = createBashTool(pi, '/cwd', deps(() => ({})));

    const upstream = createBashToolDefinition('/cwd', {}).parameters;
    // Non-vacuous: both sides must be a real object schema, not two undefineds comparing equal.
    expect(Object.keys((upstream as { properties: Record<string, unknown> }).properties)).toContain('command');
    expect(tool.parameters).toEqual(upstream);
  });

  it('builds the delegate with the CURRENT shell settings, rebuilding only when they change', async () => {
    // `AgentToolResult.details` is required, so the fake carries it rather than widening the cast
    // through `unknown`, which would also silence the schema-drift signal the case above exists for.
    const delegateExecute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: undefined }));
    const factory = vi.fn(
      () =>
        ({
          name: 'bash',
          label: 'Bash',
          description: 'pi bash',
          parameters: shellSchema,
          execute: delegateExecute,
        }) as ToolDefinition,
    );
    const pi = { createBashToolDefinition: factory } as unknown as PiCodingAgentModule;
    let options: ShellOptions = { commandPrefix: 'source ~/.profile', shellPath: '/bin/zsh' };
    const tool = createBashTool(pi, '/cwd', deps(() => options));

    // objectContaining, because the delegate options also carry process-lifetime wiring this case says nothing about.
    expect(factory).toHaveBeenLastCalledWith('/cwd', expect.objectContaining({ commandPrefix: 'source ~/.profile', shellPath: '/bin/zsh' }));
    const builtAtConstruction = factory.mock.calls.length;

    await tool.execute('c1', { command: 'ls' }, undefined, undefined, ctx);
    expect(factory.mock.calls.length).toBe(builtAtConstruction);

    // A settings edit must reach the next command with no window reload.
    options = { commandPrefix: 'source ~/.profile', shellPath: '/bin/fish' };
    await tool.execute('c2', { command: 'ls' }, undefined, undefined, ctx);
    expect(factory).toHaveBeenLastCalledWith('/cwd', expect.objectContaining({ commandPrefix: 'source ~/.profile', shellPath: '/bin/fish' }));

    await tool.execute('c3', { command: 'ls' }, undefined, undefined, ctx);
    expect(factory.mock.calls.length).toBe(builtAtConstruction + 1);
    expect(delegateExecute).toHaveBeenCalledTimes(3);
  });

  it('carries the per-call cancel, so a bash command stops without ending the turn', async () => {
    vi.useFakeTimers();
    const { store, registry, delivered } = boundStore();
    const shell = abortingShell('cloning...', 'throws');
    const factory = vi.fn(() => shell.definition);
    const pi = { createBashToolDefinition: factory } as unknown as PiCodingAgentModule;
    const tool = createBashTool(pi, '/cwd', { getShellOptions: () => ({}), cancelRegistry: registry, shellJob: undefined });
    const run = new AbortController();

    const pending = tool.execute('bash-1', { command: 'sleep 300' }, run.signal, undefined, ctx);
    await shell.started;
    vi.advanceTimersByTime(2_000);
    expect(store.cancel('bash-1', 'wrong repo')).toBe(true);

    const text = textOf(await pending);
    expect(text).toContain('cloning...');
    expect(text).toContain("[Command cancelled by the user after 2.0s. The output above is partial. The user's reason follows in their next message.]");
    expect(text).not.toContain('wrong repo');
    expect(delivered).toEqual(['wrong repo']);
    expect(run.signal.aborted).toBe(false);
  });
});
