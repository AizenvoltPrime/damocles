import { describe, it, expect, vi } from "vitest";
import { createWorkspaceHandlers } from "../workspace-handlers";
import { createTeamHandlers } from "../team-handlers";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage } from "../../../../../shared/types/messages";

/**
 * The webview marks the agent "Stopping..." on the way in. A stop that landed is answered by the agent's
 * own completion; a late one has nothing else to clear that state, so the handler answers it.
 */
function harness(session: Record<string, unknown>) {
  const sent: ExtensionToWebviewMessage[] = [];
  const deps = {
    postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => { sent.push(message); },
  } as unknown as HandlerDependencies;
  const ctx = { host: { id: "panel-1" }, panelId: "panel-1", session } as unknown as HandlerContext;
  return { sent, ctx, workspace: createWorkspaceHandlers(deps), team: createTeamHandlers(deps) };
}

describe("stopSubagent", () => {
  it("stops the agent the message names and posts nothing when the stop landed", async () => {
    const stopSubagent = vi.fn(() => true);
    const interrupt = vi.fn();
    const h = harness({ stopSubagent, interrupt });

    await h.workspace.stopSubagent!({ type: "stopSubagent", agentId: "agent-1" }, h.ctx);

    expect(stopSubagent).toHaveBeenCalledWith("agent-1");
    expect(interrupt).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });

  it("answers a stop that landed after the agent finished", async () => {
    const h = harness({ stopSubagent: vi.fn(() => false) });

    await h.workspace.stopSubagent!({ type: "stopSubagent", agentId: "agent-1" }, h.ctx);

    expect(h.sent).toEqual([{ type: "subagentStopRejected", agentId: "agent-1" }]);
  });
});

describe("cancelTeam", () => {
  it("stops the team through the team service's one stop path and posts nothing when it landed", async () => {
    const stopTeam = vi.fn(() => true);
    const interrupt = vi.fn();
    const h = harness({ teamService: { stopTeam }, interrupt });

    await h.team.cancelTeam!({ type: "cancelTeam", teamId: "team-1" }, h.ctx);

    expect(stopTeam).toHaveBeenCalledWith("team-1");
    expect(interrupt).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });

  it.each([
    ["the team had already finished", { teamService: { stopTeam: () => false } }],
    ["the panel has no team service", {}],
  ])("answers a stop when %s", async (_label, session) => {
    const h = harness(session);

    await h.team.cancelTeam!({ type: "cancelTeam", teamId: "team-1" }, h.ctx);

    expect(h.sent).toEqual([{ type: "teamCancelRejected", teamId: "team-1" }]);
  });
});
