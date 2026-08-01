import type { ExtensionUIContext, Theme } from '@earendil-works/pi-coding-agent';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { ElicitationUI } from './mcp/elicitation-handler';
import { stripBidiControls, stripControlChars } from './untrusted-text';

/** RPC mode degrades all TUI-only surfaces; theme rendering is not used by webview-bridged dialogs. */
const EMPTY_THEME = {} as Theme;

interface DialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

type UiRequestMessage = Extract<ExtensionToWebviewMessage, { type: 'extensionUiRequest' }>;
/** Derived from the message so the stamp can never drift from what the webview reads. */
type AttributionFields = Pick<UiRequestMessage, 'agentId' | 'agentName' | 'teamId'>;

/** Who a nested (subagent / team-agent) dialog belongs to. `teamId` is absent for plain subagents. */
export interface AgentUiAttribution {
  agentId: string;
  agentName: string;
  teamId?: string;
}

/** A per-agent elicitation surface over the parent panel's bridge — NOT a full `ExtensionUIContext`. */
export interface AgentElicitationUI extends ElicitationUI {
  /** The same bridge with attribution stripped, for when the server↔agent mapping is ambiguous. */
  unattributed(): ElicitationUI;
  /**
   * Close this agent's bridge at its teardown: drop its in-flight dialogs AND refuse any later one.
   *
   * Named for its scope, NOT `cancelAll`, because `WebviewExtensionUIContext.cancelAll()` wipes EVERY
   * dialog in the panel and this type is structurally assignable to `ElicitationUI` — one shared name
   * across that blast-radius gap is how `agentUi ?? this.uiContext` silently escalates from one agent
   * to all of them, compiling cleanly the whole way.
   */
  cancelOwnDialogs(): void;
}

/**
 * The attribution line sits directly beneath the panel's trusted dialog chrome, and the name in it is
 * NOT ours: a team specialist's is chosen by the lead MODEL (`startSpecialist`) and a markdown agent's
 * is user-authored. Sanitize and cap it HERE, where it is captured, so nothing downstream has to
 * remember to.
 *
 * Two different attacks, so two passes. `stripControlChars` (the canonical flattener in
 * `untrusted-text.ts`, shared with the ToolSearch inventory) removes everything with LAYOUT meaning —
 * C0, DEL, C1 and U+2028/U+2029 — so no name can forge a second line. `stripBidiControls` removes the
 * bidi overrides and isolates, which are neither control characters nor whitespace and so survive
 * every other filter: an unpaired U+202E reverses the visual order of the rest of the badge, letting a
 * name render as text it does not contain. Flattening alone would leave that wide open. Both patterns
 * are linear.
 */
const MAX_AGENT_NAME = 60;
function agentLabel(name: string): string {
  const flattened = stripBidiControls(stripControlChars(name)).replace(/\s+/g, ' ').trim();
  if (flattened.length <= MAX_AGENT_NAME) return flattened;
  // Sliced by code POINT: a plain `.slice` on a UTF-16 string can cut a surrogate pair in half and
  // render the cap itself as U+FFFD.
  return `${[...flattened].slice(0, MAX_AGENT_NAME - 3).join('')}...`;
}

/**
 * Per-PiSession webview-bridged `ExtensionUIContext` (US-026). `select`/`confirm`/`input`/`editor`
 * post additive `extensionUiRequest` messages and await an `extensionUiResponse`; `notify` maps to a
 * webview notice. Every other method is a safe no-op mirroring pi's RPC-mode degradation
 * (`docs/rpc.md`) — the foundation third-party (marketplace) extensions render their dialogs through.
 *
 * Bound via `session.bindExtensions({ uiContext, mode: 'rpc' })`. The owning PiSession forwards
 * `extensionUiResponse` here through `resolve(requestId, value)`.
 */
export class WebviewExtensionUIContext implements ExtensionUIContext {
  private seq = 0;
  /** requestId → its awaiter, tagged with the nested agent that opened it (absent ⇒ the panel's own). */
  private readonly pending = new Map<string, { settle: (value: string | boolean | null) => void; agentId?: string }>();
  /**
   * Agents whose bridge has been closed. Sweeping `pending` at teardown is not enough on its own: the
   * `forAgent` wrapper outlives the sweep, and an MCP call can still be in flight when its agent's run
   * settles (nothing awaits `customTools.execute` — the same hazard `agent-manager.ts` documents for
   * browser work). A late `elicitation/create` would then open a NEW attributed modal for an agent that
   * finished, which no later sweep would ever reach: it would sit at the head of the queue blocking
   * every subsequent dialog, and its answer would go nowhere. Teardown has to be a terminal STATE, not
   * a one-shot pass.
   */
  private readonly closedAgents = new Set<string>();
  private readonly emit: (message: ExtensionToWebviewMessage) => void;
  private readonly sessionId: () => string;

  constructor(emit: (message: ExtensionToWebviewMessage) => void, sessionId: () => string) {
    this.emit = emit;
    this.sessionId = sessionId;
  }

  /** Resolve a pending dialog with the value from a webview `extensionUiResponse`. */
  resolve(requestId: string, value: string | boolean | null): void {
    const entry = this.pending.get(requestId);
    if (entry) {
      this.pending.delete(requestId);
      entry.settle(value);
    }
  }

  /**
   * Withdraw ONE in-flight dialog: settle its awaiter as cancelled AND tell the webview to drop the
   * modal. Both halves are mandatory — settling alone strands a modal the user can still answer into
   * nothing, and messaging alone hangs the awaiting MCP call.
   */
  private withdraw(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    this.emit({ type: 'extensionUiCancel', requestId });
    entry.settle(null);
  }

  /**
   * Cancel every in-flight dialog — the panel's own AND every nested agent's, which live in this same
   * map (session replacement / dispose), so a nested dialog cannot outlive the panel bridging it (G5).
   */
  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) this.withdraw(requestId);
    // The panel is being replaced or torn down, so every agent bridge is starting over with it.
    this.closedAgents.clear();
  }

  /**
   * Close one nested agent's bridge at its teardown: drop what is in flight, and mark it so nothing it
   * opens afterwards ever reaches the user. Keyed by agentId against the shared `pending` map rather
   * than through a registry of live `forAgent` wrappers: a registry would be a second lifetime to get
   * wrong, and a dialog whose owning agent is gone is identified by its tag, not by who still holds a
   * reference to the wrapper.
   */
  cancelAgentDialogs(agentId: string): void {
    this.closedAgents.add(agentId);
    for (const [requestId, entry] of [...this.pending]) {
      if (entry.agentId === agentId) this.withdraw(requestId);
    }
  }

  private request(
    payload: Omit<UiRequestMessage, 'type' | 'requestId'>,
    signal: AbortSignal | undefined,
    agentId?: string,
  ): Promise<string | boolean | null> {
    // Both refusals answer immediately and emit NOTHING, so no modal is ever posted that the webview
    // would have to be told to take back. A closed agent's prompt must not appear at all; an
    // already-aborted signal would never fire its `abort` listener (per spec, adding one to a signal
    // that has already aborted does not invoke it), so emitting first would strand the modal on screen
    // and the awaiter forever. `runForm` reads the `null` as `{ action: 'cancel' }`.
    if (agentId !== undefined && this.closedAgents.has(agentId)) return Promise.resolve(null);
    if (signal?.aborted) return Promise.resolve(null);
    const requestId = `${this.sessionId()}:ui:${(this.seq += 1)}`;
    return new Promise((resolve) => {
      const onAbort = () => this.withdraw(requestId);
      this.pending.set(requestId, {
        settle: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        ...(agentId !== undefined ? { agentId } : {}),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.emit({ type: 'extensionUiRequest', requestId, ...payload });
    });
  }

  // ---- per-agent bridge ---------------------------------------------------

  /**
   * A nested session never binds this context (only the panel calls `bindExtensions`), so its MCP tools
   * are handed this wrapper explicitly at spawn. It writes into the SAME `pending` map, which is what
   * lets `resolve()` (and `cancelAll()`) keep working for nested dialogs with no extra bookkeeping.
   */
  forAgent(attribution: AgentUiAttribution): AgentElicitationUI {
    const { agentId } = attribution;
    // Minting a bridge REOPENS the agent, and that is what keeps the terminal state from outliving a
    // launch. `redispatchSpecialist` reuses the failed agent's `agentId` (only `attempt` bumps), and
    // its previous settle already called `cancelAgentDialogs` — so a permanently-closed agentId would
    // silently mute every dialog of the re-run, for the rest of the team. `forAgent` is called exactly
    // once per spawn (`buildNestedMcp`), which makes "a new bridge" and "a new launch" the same event.
    this.closedAgents.delete(agentId);
    const agentName = agentLabel(attribution.agentName);
    const stamp: AttributionFields = {
      agentId,
      // Omitted rather than emitted empty when a name sanitizes away to nothing: an empty attribution
      // line is chrome claiming an identity it does not have.
      ...(agentName ? { agentName } : {}),
      ...(attribution.teamId !== undefined ? { teamId: attribution.teamId } : {}),
    };
    return {
      ...this.agentDialogs(agentId, stamp),
      // Attribution is dropped from the MESSAGE, but the dialog stays owned by this agent for teardown
      // — an unattributed prompt this agent opened must still die when this agent does.
      unattributed: () => this.agentDialogs(agentId, {}),
      cancelOwnDialogs: () => this.cancelAgentDialogs(agentId),
    };
  }

  /** The three `ElicitationUI` methods bound to one owner (teardown) and one stamp (display). */
  private agentDialogs(agentId: string, stamp: AttributionFields): ElicitationUI {
    return {
      select: async (title: string, options: string[], opts?: DialogOptions) => {
        const value = await this.request({ kind: 'select', title, options, ...stamp }, opts?.signal, agentId);
        return typeof value === 'string' ? value : undefined;
      },
      input: async (title: string, placeholder?: string, opts?: DialogOptions) => {
        const value = await this.request(
          { kind: 'input', title, ...(placeholder !== undefined ? { placeholder } : {}), ...stamp },
          opts?.signal,
          agentId,
        );
        return typeof value === 'string' ? value : undefined;
      },
      // Unattributed on purpose, and asymmetric with the dialogs above: `notification` carries no agent
      // fields, and widening a second message type to badge a toast is not worth it while the contents
      // are Damocles- or config-authored (MCP form validation errors). Revisit if a server's own text
      // ever reaches this path — that would make the missing attribution a trust question, not a
      // cosmetic one.
      notify: (message: string, type?: 'info' | 'warning' | 'error') => this.notify(message, type),
    };
  }

  // ---- bridged dialogs ----------------------------------------------------

  async select(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined> {
    const value = await this.request({ kind: 'select', title, options }, opts?.signal);
    return typeof value === 'string' ? value : undefined;
  }

  async confirm(title: string, message: string, opts?: DialogOptions): Promise<boolean> {
    const value = await this.request({ kind: 'confirm', title, message }, opts?.signal);
    return value === true;
  }

  async input(title: string, placeholder?: string, opts?: DialogOptions): Promise<string | undefined> {
    const value = await this.request(
      { kind: 'input', title, ...(placeholder !== undefined ? { placeholder } : {}) },
      opts?.signal,
    );
    return typeof value === 'string' ? value : undefined;
  }

  async editor(title: string, prefill?: string): Promise<string | undefined> {
    const value = await this.request({ kind: 'editor', title, ...(prefill !== undefined ? { prefill } : {}) }, undefined);
    return typeof value === 'string' ? value : undefined;
  }

  notify(message: string, type?: 'info' | 'warning' | 'error'): void {
    this.emit({ type: 'notification', message, notificationType: type ?? 'info' });
  }

  // ---- degraded RPC no-ops (mirror pi's noOpUIContext) --------------------

  onTerminalInput(): () => void {
    return () => {};
  }
  setStatus(): void {}
  setWorkingMessage(): void {}
  setWorkingVisible(): void {}
  setWorkingIndicator(): void {}
  setHiddenThinkingLabel(): void {}
  setWidget(): void {}
  setFooter(): void {}
  setHeader(): void {}
  setTitle(): void {}
  async custom(): Promise<never> {
    return undefined as never;
  }
  pasteToEditor(): void {}
  setEditorText(): void {}
  getEditorText(): string {
    return '';
  }
  addAutocompleteProvider(): void {}
  setEditorComponent(): void {}
  getEditorComponent(): undefined {
    return undefined;
  }
  get theme(): Theme {
    return EMPTY_THEME;
  }
  getAllThemes(): { name: string; path: string | undefined }[] {
    return [];
  }
  getTheme(): Theme | undefined {
    return undefined;
  }
  setTheme(): { success: boolean; error?: string } {
    return { success: false, error: 'UI not available in webview RPC mode' };
  }
  getToolsExpanded(): boolean {
    return false;
  }
  setToolsExpanded(): void {}
}
