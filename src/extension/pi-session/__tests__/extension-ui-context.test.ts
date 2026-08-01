import { describe, it, expect } from 'vitest';
import { WebviewExtensionUIContext } from '../extension-ui-context';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';

type UiRequest = Extract<ExtensionToWebviewMessage, { type: 'extensionUiRequest' }>;

function lastRequest(out: ExtensionToWebviewMessage[]): UiRequest {
  const req = [...out].reverse().find((m): m is UiRequest => m.type === 'extensionUiRequest');
  if (!req) throw new Error('no extensionUiRequest emitted');
  return req;
}

describe('WebviewExtensionUIContext (US-026)', () => {
  it('select posts an extensionUiRequest and resolves from a webview response', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    const ui = new WebviewExtensionUIContext((m) => out.push(m), () => 'SID');
    const promise = ui.select('Pick one', ['a', 'b']);
    const req = lastRequest(out);
    expect(req).toMatchObject({ kind: 'select', title: 'Pick one', options: ['a', 'b'] });
    ui.resolve(req.requestId, 'b');
    expect(await promise).toBe('b');
  });

  it('confirm maps the boolean response', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    const ui = new WebviewExtensionUIContext((m) => out.push(m), () => 'SID');
    const promise = ui.confirm('Sure?', 'really?');
    ui.resolve(lastRequest(out).requestId, true);
    expect(await promise).toBe(true);
  });

  it('input returns undefined when the webview reports cancellation (null)', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    const ui = new WebviewExtensionUIContext((m) => out.push(m), () => 'SID');
    const promise = ui.input('Name?', 'type here');
    ui.resolve(lastRequest(out).requestId, null);
    expect(await promise).toBeUndefined();
  });

  it('cancelAll settles every pending dialog as cancelled', async () => {
    const ui = new WebviewExtensionUIContext(() => {}, () => 'SID');
    const a = ui.input('A?');
    const b = ui.select('B?', ['x']);
    ui.cancelAll();
    expect(await a).toBeUndefined();
    expect(await b).toBeUndefined();
  });

  it('notify maps to a webview notification', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const ui = new WebviewExtensionUIContext((m) => out.push(m), () => 'SID');
    ui.notify('hello', 'warning');
    expect(out[0]).toEqual({ type: 'notification', message: 'hello', notificationType: 'warning' });
  });

  it('a panel dialog carries NO attribution keys (omitted, never undefined)', () => {
    // The webview branches on key PRESENCE. `agentName: undefined` would render identically today and
    // make "is this an agent's dialog?" a truthiness question again — the class of bug this slice fixes.
    const out: ExtensionToWebviewMessage[] = [];
    const ui = new WebviewExtensionUIContext((m) => out.push(m), () => 'SID');
    void ui.select('Pick one', ['a']);
    const req = lastRequest(out);
    expect('agentId' in req).toBe(false);
    expect('agentName' in req).toBe(false);
    expect('teamId' in req).toBe(false);
  });
});

/**
 * Slice 2 — the per-agent bridge. A nested session never binds this context, so its MCP tools are
 * handed `forAgent(...)` at spawn; every dialog it opens must be attributed, withdrawable on its own,
 * and withdrawn by the panel-wide teardown as well (G5).
 */
describe('WebviewExtensionUIContext.forAgent (Slice 2)', () => {
  const ctx = () => {
    const out: ExtensionToWebviewMessage[] = [];
    const ui = new WebviewExtensionUIContext((m) => out.push(m), () => 'SID');
    const cancels = (): string[] =>
      out.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'extensionUiCancel' }> => m.type === 'extensionUiCancel')
        .map((m) => m.requestId);
    return { out, ui, cancels };
  };

  it('stamps agentId/agentName/teamId onto every dialog the agent opens', async () => {
    const { out, ui } = ctx();
    const agent = ui.forAgent({ agentId: 'ag-1', agentName: 'Scout', teamId: 'team-3' });

    const select = agent.select('Pick one', ['a', 'b']);
    expect(lastRequest(out)).toMatchObject({ kind: 'select', agentId: 'ag-1', agentName: 'Scout', teamId: 'team-3' });
    ui.resolve(lastRequest(out).requestId, 'a');
    expect(await select).toBe('a');

    const input = agent.input('Name?', 'type here');
    expect(lastRequest(out)).toMatchObject({ kind: 'input', placeholder: 'type here', agentId: 'ag-1', agentName: 'Scout' });
    ui.resolve(lastRequest(out).requestId, 'x');
    expect(await input).toBe('x');
  });

  it('omits teamId for a plain subagent (it belongs to no team)', () => {
    const { out, ui } = ctx();
    void ui.forAgent({ agentId: 'ag-1', agentName: 'Explore' }).select('Pick', ['a']);
    expect('teamId' in lastRequest(out)).toBe(false);
  });

  it('writes into the SAME pending map, so the panel`s resolve() answers a nested dialog', async () => {
    // `PiSession` forwards every `extensionUiResponse` through `uiContext.resolve`. A per-agent wrapper
    // with its own map would strand nested dialogs there with no error — they would simply never settle.
    const { out, ui } = ctx();
    const promise = ui.forAgent({ agentId: 'ag-1', agentName: 'Scout' }).select('Pick', ['a', 'b']);
    ui.resolve(lastRequest(out).requestId, 'b');
    expect(await promise).toBe('b');
  });

  it('flattens and caps a hostile agent name AT CAPTURE, before any dialog is emitted', async () => {
    // The name is model- or user-authored and lands next to trusted chrome. A newline would forge a
    // second line ("Server: git" style); the cap bounds a flooding name.
    const { out, ui } = ctx();
    // Includes C1 (NEL U+0085, CSI U+009B) and U+2028: a filter stopping at DEL leaves the
    // forge-a-second-line attack open through a wider alphabet than it closes, and those characters
    // are invisible in a test fixture that only carries `\n` and `\u0007`.
    const agent = ui.forAgent({ agentId: 'ag-1', agentName: 'Rev\niewer\r\u0085\u009b\u2028\u0007\u001b[31m  spaced' });
    void agent.select('Pick', ['a']);

    const name = lastRequest(out).agentName!;
    expect(name).not.toMatch(/[\n\r\u2028\u2029]/);
    // The full layout class, not just C0: NEL and the rest of C1 are line terminators to plenty of
    // renderers, so a filter stopping at DEL leaves the forge open through a wider alphabet.
    // eslint-disable-next-line no-control-regex
    expect(name).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(name).toBe('Rev iewer [31m spaced');

    // The cap pinned EXACTLY, at the module that owns the constant: a bound asserted as `<= 120`
    // against a real limit of 60 passes a mutation that doubles it, which is the one thing this
    // assertion exists to stop.
    const long = ui.forAgent({ agentId: 'ag-2', agentName: 'B'.repeat(1000) });
    void long.select('Pick', ['a']);
    expect(lastRequest(out).agentName).toBe(`${'B'.repeat(57)}...`);
    expect(lastRequest(out).agentName!.length).toBe(60);
  });

  it('strips bidi overrides, which no control-char or whitespace filter touches', () => {
    // U+202E reverses the VISUAL order of everything after it, so a name can render as text it does not
    // contain — spoofing aimed squarely at the one line of chrome this slice adds. It is neither a
    // control character nor whitespace, so flattening alone lets it straight through.
    const { out, ui } = ctx();
    void ui.forAgent({ agentId: 'ag-1', agentName: 'Scout\u202Ereviewer\u2066x\u2069' }).select('Pick', ['a']);

    const name = lastRequest(out).agentName!;
    expect(name).toBe('Scoutreviewerx');
    expect(name).not.toMatch(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
  });

  it('caps by code POINT, so the truncation cannot split a surrogate pair', () => {
    // A plain `.slice` on a UTF-16 string cuts an astral character in half and renders the cap itself
    // as U+FFFD — the sanitizer corrupting text it was asked to make safe.
    const { out, ui } = ctx();
    void ui.forAgent({ agentId: 'ag-1', agentName: '😀'.repeat(100) }).select('Pick', ['a']);

    const name = lastRequest(out).agentName!;
    expect(name).not.toContain('\uFFFD');
    expect(name).toBe(`${'😀'.repeat(57)}...`);
    expect([...name]).toHaveLength(60);
  });

  it('OMITS agentName entirely when it sanitizes away to nothing', () => {
    // An empty attribution line is chrome claiming an identity it does not have.
    const { out, ui } = ctx();
    void ui.forAgent({ agentId: 'ag-1', agentName: '\u0000\u0007   \n' }).select('Pick', ['a']);
    const req = lastRequest(out);
    expect('agentName' in req).toBe(false);
    expect(req.agentId).toBe('ag-1'); // still owned, so teardown can still find it
  });

  it('unattributed() emits the same dialog with NO agent keys, still owned by the agent', async () => {
    const { out, ui, cancels } = ctx();
    const agent = ui.forAgent({ agentId: 'ag-1', agentName: 'Scout' });

    const promise = agent.unattributed().select('Pick', ['a']);
    const req = lastRequest(out);
    expect('agentName' in req).toBe(false);
    expect('agentId' in req).toBe(false);

    // Ownership is not attribution: an unattributed prompt this agent opened must still die with it.
    agent.cancelOwnDialogs();
    expect(cancels()).toEqual([req.requestId]);
    expect(await promise).toBeUndefined();
  });

  it('cancelOwnDialogs() withdraws only THIS agent`s dialogs, emitting one extensionUiCancel per request', async () => {
    const { out, ui, cancels } = ctx();
    const scout = ui.forAgent({ agentId: 'ag-1', agentName: 'Scout' });
    const builder = ui.forAgent({ agentId: 'ag-2', agentName: 'Builder' });

    const a = scout.select('A?', ['x']);
    const aId = lastRequest(out).requestId;
    const b = scout.input('B?');
    const bId = lastRequest(out).requestId;
    const c = builder.select('C?', ['y']);
    const cId = lastRequest(out).requestId;

    scout.cancelOwnDialogs();

    expect(cancels()).toEqual([aId, bId]); // one message per dropped id — the store removes by id
    expect(await a).toBeUndefined();
    expect(await b).toBeUndefined();

    // The other agent is untouched and still answerable.
    ui.resolve(cId, 'y');
    expect(await c).toBe('y');
    expect(cancels()).toEqual([aId, bId]);
  });

  it('cancelAgentDialogs(agentId) is the same withdrawal, reachable from the teardown seam', async () => {
    const { out, ui, cancels } = ctx();
    const promise = ui.forAgent({ agentId: 'ag-1', agentName: 'Scout' }).select('A?', ['x']);
    const id = lastRequest(out).requestId;

    ui.cancelAgentDialogs('ag-1');

    expect(cancels()).toEqual([id]);
    expect(await promise).toBeUndefined();
    // An id with nothing pending emits nothing — there is no modal to take back.
    ui.cancelAgentDialogs('ag-1');
    expect(cancels()).toEqual([id]);
  });

  it('a dialog opened AFTER teardown is never shown, and answers itself as cancelled', async () => {
    // The dangerous direction, and the one a "nothing pending is a no-op" test looks like it covers but
    // does not. Teardown sweeps what is pending AT THAT INSTANT while the `forAgent` wrapper stays
    // live, and an agent's run can settle with an MCP call still in flight — nothing awaits
    // `customTools.execute` on either the subagent or the team path. The server then elicits, and a
    // brand-new modal appears badged for an agent that finished seconds ago: no later sweep can reach
    // it, so it sits at the head of the queue blocking every subsequent dialog, and its answer is
    // discarded. Teardown has to be a terminal STATE, not a one-shot pass.
    const { out, ui, cancels } = ctx();
    const agent = ui.forAgent({ agentId: 'ag-1', agentName: 'Scout' });

    agent.cancelOwnDialogs();
    const before = out.length;

    const late = agent.select('Late?', ['x']);

    expect(out.length).toBe(before); // nothing was posted to the webview at all…
    expect(cancels()).toEqual([]); // …so there is nothing to take back either
    expect(await late).toBeUndefined(); // and the awaiting MCP call settles as `{ action: 'cancel' }`
  });

  it('a REDISPATCHED agent reuses its agentId and must not stay muted', async () => {
    // `redispatchSpecialist` re-runs a failed specialist under the SAME `agentId` (only `attempt`
    // bumps), and the failed attempt's settle already called `cancelAgentDialogs`. A terminal state
    // keyed by agentId alone would therefore silently swallow every dialog of the re-run for the rest
    // of the team. `forAgent` is minted once per spawn, so minting reopens — which makes "new bridge"
    // and "new launch" the same event, and this test the thing that keeps them so.
    const { out, ui } = ctx();
    ui.forAgent({ agentId: 'ag-1', agentName: 'Scout' }).cancelOwnDialogs();

    const relaunched = ui.forAgent({ agentId: 'ag-1', agentName: 'Scout' });
    const promise = relaunched.select('Retry?', ['x']);

    expect(lastRequest(out).agentName).toBe('Scout');
    ui.resolve(lastRequest(out).requestId, 'x');
    expect(await promise).toBe('x');
  });

  it('an ALREADY-ABORTED signal posts no modal and settles immediately', async () => {
    // Adding an `abort` listener to a signal that has already aborted never invokes it (per spec), so
    // emitting first would leave a modal on screen with an awaiter nothing can ever settle. Checked
    // before the emit, so there is no orphan to clean up. Not reachable from MCP today — the
    // elicitation renderer passes no `opts` — but `ctx.ui.*` is the surface marketplace extensions call
    // with their own signals, and per-request abort is a documented teardown path.
    const { out, ui } = ctx();
    const controller = new AbortController();
    controller.abort();

    const promise = ui.select('Pick?', ['a'], { signal: controller.signal });

    expect(out).toEqual([]);
    expect(await promise).toBeUndefined();
  });

  it('G5: the panel-wide cancelAll() withdraws nested dialogs AND tells the webview', async () => {
    // `PiSession.dispose()` calls this. Settling alone would strand a modal the user can still answer
    // into nothing; messaging alone would hang the awaiting MCP call. Both halves, always.
    const { out, ui, cancels } = ctx();
    const nested = ui.forAgent({ agentId: 'ag-1', agentName: 'Scout' }).select('Nested?', ['x']);
    const nestedId = lastRequest(out).requestId;
    const panel = ui.input('Panel?');
    const panelId = lastRequest(out).requestId;

    ui.cancelAll();

    expect(cancels().sort()).toEqual([nestedId, panelId].sort());
    expect(await nested).toBeUndefined();
    expect(await panel).toBeUndefined();
  });

  it('an aborted dialog emits extensionUiCancel too (the per-request abort path)', async () => {
    const { out, ui, cancels } = ctx();
    const controller = new AbortController();
    const promise = ui.forAgent({ agentId: 'ag-1', agentName: 'Scout' })
      .select('A?', ['x'], { signal: controller.signal });
    const id = lastRequest(out).requestId;

    controller.abort();

    expect(cancels()).toEqual([id]);
    expect(await promise).toBeUndefined();
  });

  it('answering a dialog does NOT emit a cancel for it', () => {
    // A spurious cancel would drop the NEXT queued dialog if ids were ever reused, and it is noise on a
    // seam whose whole job is "this one is gone".
    const { out, ui, cancels } = ctx();
    void ui.forAgent({ agentId: 'ag-1', agentName: 'Scout' }).select('A?', ['x']);
    ui.resolve(lastRequest(out).requestId, 'x');
    expect(cancels()).toEqual([]);
  });
});
