import type { ChatRepository, ForgeToolAnswer, ForgeToolRequest } from '../../shared/forge/tools';
import type { ForgeService } from '../forge';
import { DecidedTargets, type ForgeCall, type ForgeToolsPort } from '../pi-session/tools/forge-tools';

// A local chat's GitHub and GitLab tools: this computer's core reads its repository and its own accounts answer.

export interface LocalForgeToolsDeps {
  readonly forge: ForgeService;
  readonly repository: (folder: string) => Promise<ChatRepository>;
  /** Shows the refused notice an answer carries under the call's card; projectKey: the binding its Choose account makes. */
  readonly refused: (call: ForgeCall, answer: ForgeToolAnswer, projectKey: string | undefined) => void;
}

export function localForgeTools(deps: LocalForgeToolsDeps, folder: () => string): ForgeToolsPort {
  const decided = new DecidedTargets();

  async function requestOf(call: ForgeCall): Promise<{ readonly request: ForgeToolRequest } | { readonly answer: ForgeToolAnswer }> {
    const read = await deps.repository(folder());
    if (!read.ok) return { answer: { text: read.text, isError: true } };
    const { project, endpoints, pushRemote, branch } = read.repository;
    return {
      request: {
        tool: call.tool,
        input: call.input,
        authorityKey: 'local',
        ...(read.projectKey !== undefined ? { projectKey: read.projectKey } : {}),
        project,
        endpoints,
        ...(pushRemote !== undefined ? { pushRemote } : {}),
        ...(branch !== undefined ? { branch } : {}),
      },
    };
  }

  const noticed = (call: ForgeCall, request: ForgeToolRequest, answer: ForgeToolAnswer): ForgeToolAnswer => {
    deps.refused(call, answer, request.projectKey);
    return answer;
  };

  return {
    async run(call, signal) {
      const expected = decided.take(call.toolCallId);
      const built = await requestOf(call);
      if ('answer' in built) return built.answer;
      const request = expected ? { ...built.request, expected } : built.request;
      return noticed(call, request, await deps.forge.agentTool(request, signal));
    },

    async target(call, signal) {
      const built = await requestOf(call);
      if ('answer' in built) return { ok: false, answer: built.answer };
      const target = await deps.forge.agentToolTarget(built.request, signal);
      if (!target.ok) {
        noticed(call, built.request, target.answer);
        return target;
      }
      decided.decided(call.toolCallId, target.target);
      return { ok: true, project: target.project };
    },

    async approval(call, signal) {
      const built = await requestOf(call);
      if ('answer' in built) return { ok: false, answer: built.answer };
      const approval = await deps.forge.agentToolApproval(built.request, signal);
      if (!approval.ok) {
        noticed(call, built.request, approval.answer);
        return approval;
      }
      decided.decided(call.toolCallId, approval.target);
      return approval;
    },
  };
}
